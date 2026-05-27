const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Student = require('../models/Student');
const { createLog } = require('../utils/logger');
const { revokeUserSessions } = require('./sessionService');
const AppError = require('../utils/AppError');

const ROLE_MAP = {
    'super admin': 'Super Admin',
    super_admin: 'Super Admin',
    admin: 'Admin',
    teacher: 'Teacher',
};

const ADMIN_ROLES = ['Super Admin', 'Admin'];
const TEACHER_ROLES = ['Teacher', 'teacher'];
const STAFF_ROLES = ['Super Admin', 'Admin', 'Teacher', 'super_admin', 'admin', 'teacher'];

const toClientRole = (role) => {
    const normalizedRole = ROLE_MAP[String(role || '').trim().toLowerCase()];
    return normalizedRole || role;
};

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const isAdminRole = (role) => ADMIN_ROLES.includes(toClientRole(role));

const getAdminExists = async () => Boolean(await User.exists({ role: { $in: ['Super Admin', 'super_admin'] } }));

const ensureCanCreateRole = (actorRole, targetRole) => {
    if (actorRole === 'Super Admin') {
        if (targetRole === 'Super Admin') {
            throw new AppError('Additional Super Admin accounts cannot be created here.', 403);
        }
        return;
    }

    if (actorRole === 'Admin') {
        if (targetRole !== 'Teacher') {
            throw new AppError('Admins can create Teacher accounts only.', 403);
        }
        return;
    }

    throw new AppError('Only administrators can create staff accounts.', 403);
};

const ensureCanManageUser = (actor, targetUser, actionLabel = 'manage') => {
    const actorRole = toClientRole(actor?.role);
    const targetRole = toClientRole(targetUser?.role);
    const actorId = String(actor?._id || actor?.id || '');
    const targetId = String(targetUser?._id || targetUser?.id || '');

    if (actorRole === 'Super Admin') {
        return;
    }

    if (actorRole === 'Admin' && targetRole === 'Teacher') {
        return;
    }

    if (actorId && actorId === targetId && actionLabel === 'change password') {
        return;
    }

    throw new AppError(`Admins cannot ${actionLabel} ${targetRole || 'this account'} accounts.`, 403);
};

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

        ensureCanCreateRole(toClientRole(actor?.role), normalizedRole);

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
        passwordChangedAt: null,
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
            recipientRoles: ['Super Admin', 'Admin'],
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

const getAllUsers = async ({ actor } = {}) => {
    const actorRole = toClientRole(actor?.role);
    const query = isAdminRole(actorRole)
        ? { role: { $in: STAFF_ROLES } }
        : { role: { $in: TEACHER_ROLES } };
    const users = await User.find(query).select('-password').lean();
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

    ensureCanManageUser(actor, user, 'delete');

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

const generateTemporaryPassword = () => {
    const prefixes = ['Temp', 'Staff'];
    return `${prefixes[crypto.randomInt(0, prefixes.length)]}@${crypto.randomInt(1000, 10000)}`;
};

const resetUserPassword = async ({ id, actor }) => {
    const user = await User.findById(id).exec();
    if (!user) {
        throw new AppError('Staff member not found', 404);
    }

    if (toClientRole(actor?.role) !== 'Super Admin') {
        throw new AppError('Only Super Admin can reset staff passwords.', 403);
    }

    const temporaryPassword = generateTemporaryPassword();
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(temporaryPassword, salt);
    user.mustChangePassword = true;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordChangedAt = new Date();
    await user.save();
    await revokeUserSessions({ userId: user._id, type: 'staff' });

    createLog('PASSWORD_RESET_BY_SUPER_ADMIN', getActorId(actor), 'System', user._id, {
        Name: user.name,
        Role: user.role,
        targetLabel: user.name,
    });

    return {
        message: 'Temporary password generated. Share it with the user through a trusted channel.',
        temporaryPassword,
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
            mustChangePassword: user.mustChangePassword,
        },
    };
};

const changeStaffPassword = async ({ userId, currentPassword, newPassword, confirmPassword }) => {
    if (!currentPassword || !newPassword || !confirmPassword) {
        throw new AppError('Current password, new password, and confirmation are required', 400);
    }

    if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters long', 400);
    }

    if (newPassword !== confirmPassword) {
        throw new AppError('Passwords do not match', 400);
    }

    if (currentPassword === newPassword) {
        throw new AppError('New password must be different from the current password', 400);
    }

    const user = await User.findById(userId).exec();
    if (!user || !(await user.matchPassword(currentPassword))) {
        throw new AppError('Current password is incorrect', 401);
    }

    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordChangedAt = new Date();
    await user.save();
    await revokeUserSessions({ userId: user._id, type: 'staff' });

    return {
        user,
        response: {
            message: 'Password changed successfully',
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: toClientRole(user.role),
                mustChangePassword: false,
            },
            mustChangePassword: false,
        },
    };
};

/**
 * changeStudentPassword
 * Allows a logged-in student to change their password.
 * Clears the mustChangePassword flag and increments tokenVersion
 * to invalidate all previous sessions after the change.
 */
const changeStudentPassword = async ({ studentId, currentPassword, newPassword, confirmPassword }) => {
    if (!currentPassword || !newPassword || !confirmPassword) {
        throw new AppError('Current password, new password, and confirmation are required', 400);
    }

    if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters long', 400);
    }

    if (newPassword !== confirmPassword) {
        throw new AppError('Passwords do not match', 400);
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
    student.passwordChangedAt = new Date();
    await student.save();
    await revokeUserSessions({ userId: student._id, type: 'student' });

    createLog(
        'STUDENT_PASSWORD_CHANGED',
        studentId.toString(),
        'Student',
        student._id,
        { Name: student.name, admissionNo: student.admissionNo }
    );

    return {
        user: student,
        response: {
            message: 'Password changed successfully',
            user: {
                _id: student._id,
                name: student.name,
                role: 'Student',
                admissionNo: student.admissionNo,
                mustChangePassword: false,
            },
            mustChangePassword: false,
        },
    };
};

module.exports = {
    toClientRole,
    getAdminExists,
    registerUser,
    loginUser,
    getCurrentUserResponse,
    getAllUsers,
    deleteUser,
    resetUserPassword,
    changeStaffPassword,
    changeStudentPassword,
};

