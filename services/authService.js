const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Student = require('../models/Student');
const { createLog } = require('../utils/logger');
const { sendPasswordResetOtpEmail } = require('./emailService');
const AppError = require('../utils/AppError');

const ROLE_MAP = {
    admin: 'Admin',
    teacher: 'Teacher',
    counselor: 'Counselor',
};

const hashResetValue = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// Read lazily at call-time so dotenv is always fully loaded first.
const getOtpExpiryMs = () =>
    Math.max(1000, Number(process.env.PASSWORD_RESET_OTP_EXPIRY_MS) || 2 * 60 * 1000);

const toClientRole = (role) => {
    if (role === 'teacher') return 'Teacher';
    return role;
};

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const getAdminExists = async () => Boolean(await User.exists({ role: { $in: ['Admin', 'admin'] } }));

const registerUser = async ({ input, actor }) => {
    const { name, email, password, role, class: userClass } = input;

    if (!name || !email || !password || !role) {
        throw new AppError('Please provide all required fields', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const adminExists = await User.exists({ role: { $in: ['Admin', 'admin'] } });
    let normalizedRole;

    if (!adminExists) {
        normalizedRole = 'Admin';
    } else {
        normalizedRole = ROLE_MAP[String(role).trim().toLowerCase()];
        if (!normalizedRole) {
            throw new AppError('Invalid staff role', 400);
        }

        const requesterRole = toClientRole(actor?.role);

        if (normalizedRole === 'Admin' && requesterRole !== 'Admin') {
            throw new AppError(
                'Administrator registration is closed. Please register as a Teacher or ask an administrator to add the account.',
                403
            );
        }

        if (!actor || requesterRole !== 'Admin') {
            normalizedRole = 'Teacher';
        }
    }

    const userExists = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (userExists) {
        throw new AppError('Staff email already exists', 400);
    }

    const salt = await bcrypt.genSalt(10);
    const user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password: await bcrypt.hash(password, salt),
        role: normalizedRole,
        class: userClass || '',
    });

    if (!user) {
        throw new AppError('Invalid user data', 400);
    }

    createLog(
        'STAFF_REGISTERED',
        getActorId(actor),
        'System',
        user._id,
        {
            Name: user.name,
            Role: user.role,
            targetLabel: user.name,
            routePath: '/user-management',
        },
        {
            type: 'USER_REGISTERED',
            recipientRoles: ['Admin'],
            targetLabel: user.name,
            routePath: '/user-management',
            targetAdmissionNumber: null,
        }
    );

    return {
        user,
        response: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
        },
    };
};

const requestPasswordResetOtp = async ({ email }) => {
    if (!email) {
        throw new AppError('Email is required', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail })
        .select('_id email name passwordResetOtp passwordResetOtpExpires passwordResetVerifiedToken passwordResetVerifiedExpires')
        .exec();

    if (!user) {
        throw new AppError('We could not find a staff account with this email.', 404);
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    user.passwordResetOtp = hashResetValue(`${normalizedEmail}:${otp}`);
    user.passwordResetOtpExpires = Date.now() + getOtpExpiryMs();
    user.passwordResetVerifiedToken = undefined;
    user.passwordResetVerifiedExpires = undefined;
    await user.save();

    // Send email as a non-blocking background task so the API responds instantly.
    // If delivery fails, the OTP fields are cleared and the error is logged.
    sendPasswordResetOtpEmail({ to: normalizedEmail, otp }).catch(async (error) => {
        try {
            user.passwordResetOtp = undefined;
            user.passwordResetOtpExpires = undefined;
            await user.save();
        } catch (saveErr) {
            console.error('Failed to clear OTP after email delivery failure', {
                userId: user._id?.toString(),
                saveError: saveErr.message,
            });
        }
        console.error('Password reset email delivery failed:', {
            message: error.message,
            code: error.code,
            command: error.command,
            responseCode: error.responseCode,
            response: error.response,
        });
    });

    return { message: 'A reset code has been sent to your email address.' };
};

const verifyPasswordResetOtp = async ({ email, otp }) => {
    if (!email || !otp) {
        throw new AppError('Email and reset code are required', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const passwordResetOtp = hashResetValue(`${normalizedEmail}:${String(otp).trim()}`);

    const user = await User.findOne({
        email: normalizedEmail,
        passwordResetOtp,
        passwordResetOtpExpires: { $gt: Date.now() },
    });

    if (!user) {
        throw new AppError('The reset code is incorrect or has expired.', 400);
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetVerifiedToken = hashResetValue(resetToken);
    user.passwordResetVerifiedExpires = Date.now() + 1000 * 60 * 10;
    user.passwordResetOtp = undefined;
    user.passwordResetOtpExpires = undefined;
    await user.save();

    return { message: 'Reset code verified successfully', resetToken };
};

const resetPassword = async ({ token, password }) => {
    if (!token || !password) {
        throw new AppError('Reset token and new password are required', 400);
    }

    if (password.length < 6) {
        throw new AppError('New password must be at least 6 characters long', 400);
    }

    const user = await User.findOne({
        passwordResetVerifiedToken: hashResetValue(token),
        passwordResetVerifiedExpires: { $gt: Date.now() },
    });

    if (!user) {
        throw new AppError('Password reset verification is invalid or has expired', 400);
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordResetOtp = undefined;
    user.passwordResetOtpExpires = undefined;
    user.passwordResetVerifiedToken = undefined;
    user.passwordResetVerifiedExpires = undefined;
    await user.save();

    createLog(
        'PASSWORD_RESET',
        user._id,
        'System',
        user._id,
        { Name: user.name, Role: user.role, targetLabel: user.name }
    );

    return { message: 'Password updated successfully' };
};

const loginStaff = async ({ email, password }) => {
    const user = await User.findOne({ email: String(email || '').trim().toLowerCase() });

    if (!user || !(await user.matchPassword(password))) {
        throw new AppError('Invalid Staff Credentials', 401);
    }

    createLog(
        'Staff Login',
        user._id.toString(),
        'System',
        null,
        { name: user.name, role: user.role }
    );

    return {
        user,
        response: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
        },
        tokenType: 'staff',
    };
};

const loginStudent = async ({ email, password }) => {
    const admissionNo = String(email || '').trim();
    const student = await Student.findOne({ admissionNo }).select('+password');
    const expectedLegacyPassword = `ST${admissionNo}`;
    let passwordMatches = false;

    if (student?.password) {
        passwordMatches = await student.matchPassword(password);
    } else if (student && password === expectedLegacyPassword) {
        const salt = await bcrypt.genSalt(12);
        student.password = await bcrypt.hash(password, salt);
        student.mustChangePassword = true;
        student.tokenVersion = (student.tokenVersion ?? 0) + 1;
        await student.save();
        passwordMatches = true;
    }

    if (!student || !passwordMatches) {
        throw new AppError('Invalid Student ID or Password', 401);
    }

    return {
        user: student,
        response: {
            _id: student._id,
            name: student.name,
            role: 'Student',
            admissionNo: student.admissionNo,
            mustChangePassword: student.mustChangePassword,
        },
        tokenType: 'student',
    };
};

const loginUser = async ({ email, password, loginType }) => {
    if (loginType === 'staff') {
        return loginStaff({ email, password });
    }

    if (loginType === 'student') {
        return loginStudent({ email, password });
    }

    throw new AppError('Login type not specified', 400);
};

const getCurrentUserResponse = (user) => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: toClientRole(user.role),
    admissionNo: user.admissionNo,
    mustChangePassword: user.mustChangePassword,
});

const getAllUsers = async () => {
    const users = await User.find({}).select('-password').lean();
    return users.map((user) => ({
        ...user,
        role: toClientRole(user.role),
    }));
};

const deleteUser = async ({ id, actor }) => {
    const user = await User.findById(id);

    if (!user) {
        throw new AppError('Staff member not found', 404);
    }

    await user.deleteOne();

    createLog(
        'ADMIN_DELETE_USER',
        getActorId(actor),
        'System',
        user._id,
        { Name: user.name, Role: user.role }
    );

    return { message: 'Staff member removed' };
};

/**
 * changeStudentPassword
 * Allows a logged-in student to change their password.
 * Clears the mustChangePassword flag and increments tokenVersion
 * to invalidate all previous sessions after the change.
 */
const changeStudentPassword = async ({ studentId, currentPassword, newPassword }) => {
    if (!currentPassword || !newPassword) {
        throw new AppError('Current password and new password are required', 400);
    }

    if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters long', 400);
    }

    if (currentPassword === newPassword) {
        throw new AppError('New password must be different from the current password', 400);
    }

    const student = await Student.findById(studentId).select('+password');
    if (!student) {
        throw new AppError('Student account not found', 404);
    }

    const passwordMatches = await student.matchPassword(currentPassword);
    if (!passwordMatches) {
        throw new AppError('Current password is incorrect', 401);
    }

    const salt = await bcrypt.genSalt(12);
    student.password = await bcrypt.hash(newPassword, salt);
    student.mustChangePassword = false;
    student.tokenVersion = (student.tokenVersion ?? 0) + 1;
    await student.save();

    createLog(
        'STUDENT_PASSWORD_CHANGED',
        studentId.toString(),
        'Student',
        student._id,
        { Name: student.name, admissionNo: student.admissionNo }
    );

    return {
        user: student,
        response: { message: 'Password changed successfully', mustChangePassword: false },
    };
};

module.exports = {
    toClientRole,
    getAdminExists,
    registerUser,
    requestPasswordResetOtp,
    verifyPasswordResetOtp,
    resetPassword,
    loginUser,
    getCurrentUserResponse,
    getAllUsers,
    deleteUser,
    changeStudentPassword,
};

