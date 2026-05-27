const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const { createLog } = require('../utils/logger');
const { sendPasswordResetOtpEmail } = require('./emailService');
const { revokeUserSessions } = require('./sessionService');
const AppError = require('../utils/AppError');

const ROLE_MAP = {
    'super admin': 'Super Admin',
    super_admin: 'Super Admin',
    admin: 'Admin',
    teacher: 'Teacher',
};

const hashResetValue = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// Read lazily at call-time so dotenv is always fully loaded first.
const getOtpExpiryMs = () =>
    Math.max(1000, Number(process.env.PASSWORD_RESET_OTP_EXPIRY_MS) || 2 * 60 * 1000);

const toClientRole = (role) => {
    if (role === 'teacher') return 'Teacher';
    if (role === 'super_admin') return 'Super Admin';
    return role;
};

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const getAdminExists = async () => Boolean(await User.exists({ role: { $in: ['Super Admin', 'super_admin'] } }));

const registerUser = async ({ input, actor }) => {
    const { name, email, password, role, class: userClass } = input;

    if (!name || !email || !password || !role) {
        throw new AppError('Please provide all required fields', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const superAdminExists = await User.exists({ role: { $in: ['Super Admin', 'super_admin'] } });
    let normalizedRole;

    if (!superAdminExists) {
        normalizedRole = 'Super Admin';
    } else {
        if (!actor) {
            throw new AppError('Registration is closed. Please ask an administrator to create your account.', 403);
        }

        normalizedRole = ROLE_MAP[String(role).trim().toLowerCase()];
        if (!normalizedRole) {
            throw new AppError('Invalid staff role', 400);
        }

        const requesterRole = toClientRole(actor?.role);

        if (!['Super Admin', 'Admin'].includes(requesterRole)) {
            throw new AppError('Only administrators can create staff accounts.', 403);
        }

        if (normalizedRole === 'Super Admin') {
            throw new AppError('Additional Super Admin accounts cannot be created here.', 403);
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
        mustChangePassword: Boolean(actor),
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
            mustChangePassword: user.mustChangePassword,
        },
    };
};

const createPasswordResetNotification = async (user, request) => {
    const superAdmins = await User.find({ role: { $in: ['Super Admin', 'super_admin'] } }).select('_id').lean();
    if (superAdmins.length === 0) return;

    await Notification.insertMany(
        superAdmins.map((admin) => ({
            recipient: admin._id,
            type: 'PASSWORD_RESET_REQUEST',
            entityType: 'User',
            entityId: String(request._id),
            actionName: 'PASSWORD_RESET_REQUEST',
            message: `${user.name} requested a password reset.`,
            performedBy: String(user._id),
            performedByName: user.name,
            performedByRole: toClientRole(user.role),
            targetLabel: user.name,
            routePath: '/user-management',
            metadata: { requestId: String(request._id), email: user.email },
        }))
    );
};

const requestPasswordResetOtp = async ({ email }) => {
    if (!email) {
        throw new AppError('Email is required', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select('_id email name role').exec();

    if (!user) {
        throw new AppError('We could not find a staff account with this email.', 404);
    }

    const existing = await PasswordResetRequest.findOne({ user: user._id, status: 'pending' }).exec();
    const request = existing || await PasswordResetRequest.create({
        user: user._id,
        email: normalizedEmail,
    });

    if (!existing) {
        createPasswordResetNotification(user, request).catch(() => {});
    }

    return { message: 'Password reset request sent to the Super Admin.' };
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
            mustChangePassword: user.mustChangePassword,
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

    if (toClientRole(user.role) === 'Super Admin') {
        throw new AppError('Super Admin accounts cannot be deleted from this screen.', 403);
    }

    await revokeUserSessions({ userId: user._id, type: 'staff' });
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

const generateTemporaryPassword = () => `Reset-${crypto.randomBytes(4).toString('hex')}`;

const getPasswordResetRequests = async () => {
    const requests = await PasswordResetRequest.find({ status: 'pending' })
        .populate('user', 'name email role')
        .sort({ createdAt: -1 })
        .lean();

    return requests.map((request) => ({
        _id: request._id,
        email: request.email,
        status: request.status,
        requestedAt: request.requestedAt || request.createdAt,
        user: request.user ? {
            _id: request.user._id,
            name: request.user.name,
            email: request.user.email,
            role: toClientRole(request.user.role),
        } : null,
    }));
};

const completePasswordResetRequest = async ({ requestId, actor }) => {
    const request = await PasswordResetRequest.findById(requestId).exec();
    if (!request || request.status !== 'pending') {
        throw new AppError('Password reset request not found', 404);
    }

    const user = await User.findById(request.user).exec();
    if (!user) {
        request.status = 'rejected';
        request.completedAt = new Date();
        request.completedBy = actor._id || actor.id;
        await request.save();
        throw new AppError('User no longer exists', 404);
    }

    const temporaryPassword = generateTemporaryPassword();
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(temporaryPassword, salt);
    user.mustChangePassword = true;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    await revokeUserSessions({ userId: user._id, type: 'staff' });

    request.status = 'completed';
    request.completedAt = new Date();
    request.completedBy = actor._id || actor.id;
    request.temporaryPasswordHash = hashResetValue(temporaryPassword);
    await request.save();

    createLog('PASSWORD_RESET_BY_SUPER_ADMIN', getActorId(actor), 'System', user._id, {
        Name: user.name,
        Role: user.role,
        targetLabel: user.name,
    });

    return {
        message: 'Temporary password generated. Share it with the user through a trusted channel.',
        temporaryPassword,
        user: { _id: user._id, name: user.name, email: user.email, role: toClientRole(user.role) },
    };
};

const rejectPasswordResetRequest = async ({ requestId, actor }) => {
    const request = await PasswordResetRequest.findById(requestId).exec();
    if (!request || request.status !== 'pending') {
        throw new AppError('Password reset request not found', 404);
    }

    request.status = 'rejected';
    request.completedAt = new Date();
    request.completedBy = actor._id || actor.id;
    await request.save();
    return { message: 'Password reset request rejected.' };
};

const changeStaffPassword = async ({ userId, currentPassword, newPassword }) => {
    if (!currentPassword || !newPassword) {
        throw new AppError('Current password and new password are required', 400);
    }

    if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters long', 400);
    }

    const user = await User.findById(userId).exec();
    if (!user || !(await user.matchPassword(currentPassword))) {
        throw new AppError('Current password is incorrect', 401);
    }

    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    await revokeUserSessions({ userId: user._id, type: 'staff' });

    return {
        user,
        response: { message: 'Password changed successfully', mustChangePassword: false },
    };
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
    getPasswordResetRequests,
    completePasswordResetRequest,
    rejectPasswordResetRequest,
    changeStaffPassword,
    changeStudentPassword,
};

