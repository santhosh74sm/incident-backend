const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Student = require('../models/Student');
const SchoolWorkspace = require('../models/SchoolWorkspace');
const { createLog } = require('../utils/logger');
const { revokeUserSessions } = require('./sessionService');
const AppError = require('../utils/AppError');
const { assertSchoolId, tenantFilter } = require('../utils/tenant');
const {
    validateAcademicYear,
    getAcademicYearSummary,
    changeAcademicYear,
} = require('./academicYearService');

const ROLE_MAP = {
    'super admin': 'Super Admin',
    super_admin: 'Super Admin',
    admin: 'Admin',
    teacher: 'Teacher',
};

const ADMIN_ROLES = ['Super Admin', 'Admin'];
const ADMIN_ROLE_VALUES = ['Super Admin', 'Admin', 'super_admin', 'admin'];
const TEACHER_ROLES = ['Teacher', 'teacher'];
const ACCOUNT_USER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'super_admin', 'admin', 'teacher'];
const EDITABLE_ROLES = ['Admin', 'Teacher'];
const PASSWORD_MIN_LENGTH = 8;

const PASSWORD_POLICY_MESSAGE = 'Password must be at least 8 characters.';

const isStrongPassword = (password) =>
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH;

const toClientRole = (role) => {
    const normalizedRole = ROLE_MAP[String(role || '').trim().toLowerCase()];
    return normalizedRole || role;
};

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const isAdminRole = (role) => ADMIN_ROLES.includes(toClientRole(role));

const getAdminExists = async () => Boolean(await SchoolWorkspace.exists({ status: 'active' }));

const buildSchoolCode = (schoolName) => {
    const ignored = new Set(['SCHOOL', 'HIGHER', 'SECONDARY', 'MATRIC', 'PUBLIC', 'THE']);
    const tokens = String(schoolName || '')
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((token) => token && !ignored.has(token));
    const letters = (tokens.map((token) => token[0]).join('') || String(schoolName || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'SCH')
        .slice(0, 3)
        .padEnd(3, 'X');
    return letters;
};

const generateSchoolId = async (schoolName, session) => {
    const code = buildSchoolCode(schoolName);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const sequence = await SchoolWorkspace.countDocuments({}).session(session) + attempt + 1;
        const candidate = `SCH-${code}${String(sequence).padStart(3, '0')}`;
        const exists = await SchoolWorkspace.exists({ schoolId: candidate }).session(session);
        if (!exists) return candidate;
    }
    return `SCH-${code}${crypto.randomInt(100, 999)}${Date.now().toString().slice(-3)}`;
};

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

    if (actorId && actorId === targetId && actionLabel === 'change password') {
        return;
    }

    throw new AppError(`Admins cannot ${actionLabel} ${targetRole || 'this account'} accounts.`, 403);
};

const ensureAtLeastOneSuperAdminRemains = async ({ user, nextRole = null, actionLabel = 'change' }) => {
    if (toClientRole(user?.role) !== 'Super Admin') return;
    if (!nextRole || toClientRole(nextRole) === 'Super Admin') return;

    const remainingSuperAdmins = await User.countDocuments({
        schoolId: user.schoolId,
        _id: { $ne: user._id },
        role: { $in: ['Super Admin', 'super_admin'] },
    });

    if (remainingSuperAdmins === 0) {
        throw new AppError(`At least one Super Admin is required. You cannot ${actionLabel} the last Super Admin.`, 400);
    }
};

const registerUser = async ({ input, actor }) => {
    const { name, email, password, role, class: userClass } = input;

    if (!name || !email || !password || !role) {
        throw new AppError('Please provide all required fields', 400);
    }

    if (!isStrongPassword(password)) {
        throw new AppError(PASSWORD_POLICY_MESSAGE, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!actor?.schoolId) {
        throw new AppError('Public staff registration is closed. Create a school workspace instead.', 403);
    }

    const schoolId = assertSchoolId(actor.schoolId);
    const normalizedRole = ROLE_MAP[String(role).trim().toLowerCase()];
    if (!normalizedRole) {
        throw new AppError('Invalid user role', 400);
    }

    ensureCanCreateRole(toClientRole(actor?.role), normalizedRole);

    const userExists = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (userExists) {
        throw new AppError('Staff email already exists', 400);
    }

    const salt = await bcrypt.genSalt(10);
    const user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        schoolId,
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
        actor || getActorId(actor),
        'Staff',
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
            id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
            schoolId: user.schoolId,
            mustChangePassword: user.mustChangePassword,
        },
    };
};

const createWorkspace = async ({ input }) => {
    const { schoolName, superAdminName, email, password } = input;
    const academicYear = validateAcademicYear(input.academicYear);
    if (!isStrongPassword(password)) {
        throw new AppError(PASSWORD_POLICY_MESSAGE, 400);
    }

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const userExists = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    const workspaceEmailExists = await SchoolWorkspace.findOne({ email: normalizedEmail }).select('_id').lean();
    if (userExists || workspaceEmailExists) {
        throw new AppError('Email already exists. Use a globally unique email address.', 400);
    }

    const session = await mongoose.startSession();
    let createdUser;
    let workspace;
    try {
        await session.withTransaction(async () => {
            const schoolId = await generateSchoolId(schoolName, session);
            [workspace] = await SchoolWorkspace.create([{
                schoolId,
                schoolName: schoolName.trim(),
                superAdminName: superAdminName.trim(),
                email: normalizedEmail,
                status: 'active',
                currentAcademicYear: academicYear,
            }], { session });

            const salt = await bcrypt.genSalt(12);
            [createdUser] = await User.create([{
                name: superAdminName.trim(),
                email: normalizedEmail,
                schoolId,
                password: await bcrypt.hash(password, salt),
                role: 'Super Admin',
                class: '',
                mustChangePassword: false,
                passwordChangedAt: new Date(),
            }], { session });
        });
    } finally {
        await session.endSession();
    }

    createLog(
        'WORKSPACE_CREATED',
        createdUser,
        'System',
        workspace._id,
        {
            schoolId: workspace.schoolId,
            schoolName: workspace.schoolName,
            targetLabel: workspace.schoolName,
        }
    );

    return {
        user: createdUser,
        response: {
            id: createdUser._id,
            name: createdUser.name,
            email: createdUser.email,
            role: toClientRole(createdUser.role),
            schoolId: createdUser.schoolId,
            schoolName: workspace.schoolName,
            currentAcademicYear: workspace.currentAcademicYear,
            mustChangePassword: false,
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
        user,
        'System',
        null,
        { name: user.name, role: user.role }
    );

    return {
        user,
        response: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
            schoolId: user.schoolId,
            currentAcademicYear: await require('./academicYearService').getCurrentAcademicYear(user),
            mustChangePassword: user.mustChangePassword,
        },
        tokenType: 'staff',
    };
};

const loginStudent = async ({ email, password, schoolId }) => {
    const admissionNo = String(email || '').trim();
    const normalizedSchoolId = schoolId ? assertSchoolId(schoolId) : '';
    const studentQuery = normalizedSchoolId ? { schoolId: normalizedSchoolId, admissionNo } : { admissionNo };
    const matchingStudents = await Student.find(studentQuery).select('+password').limit(2);
    if (!normalizedSchoolId && matchingStudents.length > 1) {
        throw new AppError('School workspace is required for this student sign-in.', 400);
    }
    const student = matchingStudents[0];
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
            id: student._id,
            name: student.name,
            role: 'Student',
            admissionNo: student.admissionNo,
            schoolId: student.schoolId,
            currentAcademicYear: await require('./academicYearService').getCurrentAcademicYear(student),
            mustChangePassword: student.mustChangePassword,
        },
        tokenType: 'student',
    };
};

const loginUser = async ({ email, password, loginType, schoolId }) => {
    if (loginType === 'staff') {
        return loginStaff({ email, password });
    }

    if (loginType === 'student') {
        return loginStudent({ email, password, schoolId });
    }

    throw new AppError('Login type not specified', 400);
};

const getCurrentUserResponse = async (user) => ({
    id: user._id || user.id,
    name: user.name,
    email: user.email,
    role: toClientRole(user.role),
    schoolId: user.schoolId,
    admissionNo: user.admissionNo,
    currentAcademicYear: await require('./academicYearService').getCurrentAcademicYear(user),
    mustChangePassword: user.mustChangePassword,
});

const getAllUsers = async ({ actor } = {}) => {
    const actorRole = toClientRole(actor?.role);
    const query = isAdminRole(actorRole)
        ? tenantFilter(actor, { role: { $in: ACCOUNT_USER_ROLES } })
        : tenantFilter(actor, { role: { $in: TEACHER_ROLES } });
    const users = await User.find(query).select('-password').lean();
    return users.map((user) => ({
        ...user,
        role: toClientRole(user.role),
    }));
};

const getInvestigatorUsers = async ({ actor } = {}) => {
    const users = await User.find(tenantFilter(actor, { role: { $nin: ADMIN_ROLE_VALUES } }))
        .select('name email role schoolId')
        .sort({ name: 1 })
        .lean();

    return users.map((user) => ({
        ...user,
        role: toClientRole(user.role),
    }));
};

const deleteUser = async ({ id, actor }) => {
    const user = await User.findOne(tenantFilter(actor, { _id: id }));

    if (!user) {
        throw new AppError('Staff member not found', 404);
    }

    if (String(user._id) === String(actor?._id || actor?.id || '')) {
        throw new AppError('You cannot delete your own account.', 403);
    }

    ensureCanManageUser(actor, user, 'delete');
    await ensureAtLeastOneSuperAdminRemains({ user, nextRole: 'Deleted', actionLabel: 'delete' });

    await revokeUserSessions({ userId: user._id, type: 'staff' });
    await user.deleteOne();

    createLog(
        'ADMIN_DELETE_USER',
        actor,
        'Staff',
        user._id,
        { Name: user.name, Role: user.role, targetLabel: user.name }
    );

    return { message: 'Staff member removed.' };
};

const updateUser = async ({ id, input, actor }) => {
    const session = await mongoose.startSession();
    let user;
    let isRoleChange = false;
    let isSelfUpdate = false;
    let shouldInvalidateSessions = false;

    try {
        await session.withTransaction(async () => {
            user = await User.findOne(tenantFilter(actor, { _id: id })).session(session).exec();

            if (!user) {
                throw new AppError('Staff member not found', 404);
            }

            const actorRole = toClientRole(actor?.role);
            const actorId = String(actor?._id || actor?.id || '');
            const targetId = String(user._id);
            isSelfUpdate = actorId && actorId === targetId;
            const requestedRole = input.role ? ROLE_MAP[String(input.role).trim().toLowerCase()] : undefined;
            isRoleChange = requestedRole && requestedRole !== toClientRole(user.role);

            if (isRoleChange && !EDITABLE_ROLES.includes(requestedRole)) {
                throw new AppError('Invalid staff role', 400);
            }

            if (isSelfUpdate && isRoleChange) {
                throw new AppError('You cannot change your own role.', 403);
            }

            if (!isSelfUpdate && actorRole !== 'Super Admin') {
                throw new AppError('Only Super Admin can edit other users.', 403);
            }

            if (isRoleChange && actorRole !== 'Super Admin') {
                throw new AppError('Only Super Admin can change user roles.', 403);
            }

            if (isRoleChange) {
                await ensureAtLeastOneSuperAdminRemains({ user, nextRole: requestedRole, actionLabel: 'change the role of' });
            }

            const isSuperAdminAccount = toClientRole(user.role) === 'Super Admin';
            const normalizedEmail = input.email ? String(input.email).trim().toLowerCase() : undefined;
            if (normalizedEmail && normalizedEmail !== user.email) {
                const [emailExists, workspaceEmailExists] = await Promise.all([
                    User.findOne({ email: normalizedEmail, _id: { $ne: user._id } }).select('_id').session(session).lean(),
                    SchoolWorkspace.findOne({
                        email: normalizedEmail,
                        schoolId: { $ne: user.schoolId },
                    }).select('_id').session(session).lean(),
                ]);
                if (emailExists || workspaceEmailExists) {
                    throw new AppError('Email already exists. Use a globally unique email address.', 400);
                }
                user.email = normalizedEmail;
            }

            const normalizedName = input.name !== undefined ? String(input.name || '').trim() : undefined;
            if (normalizedName !== undefined) {
                user.name = normalizedName;
            }

            if (isRoleChange) {
                user.role = requestedRole;
            }

            shouldInvalidateSessions = user.isModified('email') || user.isModified('role');

            if (shouldInvalidateSessions) {
                user.tokenVersion = (user.tokenVersion ?? 0) + 1;
            }

            await user.save({ session });

            const workspaceSet = {};
            if (normalizedEmail !== undefined) {
                workspaceSet.email = user.email;
            }
            if (normalizedName !== undefined) {
                workspaceSet.superAdminName = user.name;
            }

            if (isSuperAdminAccount && Object.keys(workspaceSet).length > 0) {
                const workspaceUpdate = await SchoolWorkspace.updateOne(
                    {
                        schoolId: user.schoolId,
                    },
                    {
                        $set: workspaceSet,
                    },
                    { session }
                );

                if (workspaceUpdate.matchedCount !== 1) {
                    throw new AppError('Could not synchronize Super Admin profile with the school workspace.', 500);
                }
            }
        });
    } finally {
        await session.endSession();
    }

    if (shouldInvalidateSessions || !isSelfUpdate) {
        await revokeUserSessions({ userId: user._id, type: 'staff' });
    }

    createLog(
        isRoleChange ? 'USER_ROLE_UPDATED' : 'USER_PROFILE_UPDATED',
        actor,
        'User',
        user._id,
        {
            Name: user.name,
            Email: user.email,
            Role: user.role,
            targetLabel: user.name,
            selfUpdate: isSelfUpdate,
        }
    );

    return {
        message: 'User updated successfully.',
        user: {
            id: user._id,
            _id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
            schoolId: user.schoolId,
            mustChangePassword: user.mustChangePassword,
        },
    };
};

const generateTemporaryPassword = () => {
    const prefixes = ['Temp', 'Staff'];
    const random = crypto.randomBytes(5).toString('base64url');
    return `${prefixes[crypto.randomInt(0, prefixes.length)]}@${random}${crypto.randomInt(1000, 10000)}aA`;
};

const resetUserPassword = async ({ id, actor }) => {
    const user = await User.findOne(tenantFilter(actor, { _id: id })).exec();
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

    createLog('PASSWORD_RESET_BY_SUPER_ADMIN', actor, 'Staff', user._id, {
        Name: user.name,
        Role: user.role,
        targetLabel: user.name,
    });

    return {
        message: 'Temporary password generated. Share it with the user through a trusted channel.',
        temporaryPassword,
        user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: toClientRole(user.role),
            schoolId: user.schoolId,
            mustChangePassword: user.mustChangePassword,
        },
    };
};

const changeStaffPassword = async ({ userId, currentPassword, newPassword, confirmPassword }) => {
    if (!newPassword || !confirmPassword) {
        throw new AppError('New password and confirmation are required', 400);
    }

    if (!isStrongPassword(newPassword)) {
        throw new AppError(PASSWORD_POLICY_MESSAGE, 400);
    }

    if (newPassword !== confirmPassword) {
        throw new AppError('Passwords do not match', 400);
    }

    if (currentPassword && currentPassword === newPassword) {
        throw new AppError('New password must be different from the current password', 400);
    }

    const user = await User.findById(userId).exec();
    if (!user) {
        throw new AppError('User not found', 404);
    }

    if (currentPassword && !(await user.matchPassword(currentPassword))) {
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
            message: 'Password changed successfully.',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: toClientRole(user.role),
                schoolId: user.schoolId,
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
    if (!newPassword || !confirmPassword) {
        throw new AppError('New password and confirmation are required', 400);
    }

    if (!isStrongPassword(newPassword)) {
        throw new AppError(PASSWORD_POLICY_MESSAGE, 400);
    }

    if (newPassword !== confirmPassword) {
        throw new AppError('Passwords do not match', 400);
    }

    if (currentPassword && currentPassword === newPassword) {
        throw new AppError('New password must be different from the current password', 400);
    }

    const student = await Student.findById(studentId).select('+password');
    if (!student) {
        throw new AppError('Student account not found', 404);
    }

    if (currentPassword) {
        const passwordMatches = await student.matchPassword(currentPassword);
        if (!passwordMatches) {
            throw new AppError('Current password is incorrect', 401);
        }
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
        student,
        'Student',
        student._id,
        { Name: student.name, admissionNo: student.admissionNo }
    );

    return {
        user: student,
        response: {
            message: 'Password changed successfully.',
            user: {
                id: student._id,
                name: student.name,
            role: 'Student',
            admissionNo: student.admissionNo,
            schoolId: student.schoolId,
            mustChangePassword: false,
            },
            mustChangePassword: false,
        },
    };
};

module.exports = {
    toClientRole,
    getAdminExists,
    createWorkspace,
    registerUser,
    loginUser,
    getCurrentUserResponse,
    getAllUsers,
    getInvestigatorUsers,
    updateUser,
    deleteUser,
    resetUserPassword,
    changeStaffPassword,
    changeStudentPassword,
    getAcademicYearSummary,
    changeAcademicYear,
};

