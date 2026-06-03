const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Student = require('../models/Student');
const env = require('../config/env');
const { clearSessionCookies } = require('../config/authCookies');

const SECRETS = {
    staff: env.JWT_SECRET_STAFF,
    student: env.JWT_SECRET_STUDENT,
};

const normalizeRoleForApp = (user) => {
    const roleMap = {
        admin: 'Admin',
        teacher: 'Teacher',
        student: 'Student',
        super_admin: 'Super Admin',
        'super admin': 'Super Admin',
    };
    const normalizedRole = roleMap[String(user?.role || '').trim().toLowerCase()];
    if (normalizedRole) {
        user.role = normalizedRole;
    }
    if (user?._id && !user.id) {
        user.id = user._id.toString();
    }
    if (user?.schoolId) {
        user.schoolId = String(user.schoolId).trim().toUpperCase();
    }
    return user;
};

const getTokenFromRequest = (req) => {
    if (req.cookies?.token) return req.cookies.token;

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        return header.split(' ')[1];
    }

    return null;
};

const verifyToken = (token) => {
    const decodedHeader = jwt.decode(token) || {};
    const tokenType = decodedHeader.type || 'legacy';

    if (tokenType === 'student' || tokenType === 'staff') {
        return jwt.verify(token, SECRETS[tokenType], { algorithms: ['HS256'] });
    }

    if (!env.JWT_SECRET) {
        throw new Error('Legacy token secret unavailable');
    }

    return { ...jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }), type: 'legacy' };
};

const findUserForToken = async (decoded) => {
    if (decoded.type === 'student') {
        const student = await Student.findById(decoded.sub).select('-password').lean();
        if (student) student.role = 'Student';
        return student;
    }

    if (decoded.type === 'staff') {
        return User.findById(decoded.sub).select('-password').lean();
    }

    const legacyId = decoded.id || decoded.sub;
    if (!legacyId) return null;

    let user = await User.findById(legacyId).select('-password').lean();
    if (!user) {
        user = await Student.findById(legacyId).select('-password').lean();
        if (user) user.role = 'Student';
    }

    return user;
};

const attachUser = async (req, token) => {
    const decoded = verifyToken(token);
    const user = await findUserForToken(decoded);

    if (!user) {
        const error = new Error('Account not found');
        error.statusCode = 401;
        throw error;
    }

    if (decoded.type !== 'legacy' && (user.tokenVersion ?? 0) !== (decoded.tokenVersion ?? 0)) {
        const error = new Error('Session invalidated. Please log in again.');
        error.statusCode = 401;
        throw error;
    }

    const normalizedUser = normalizeRoleForApp(user);

    if (!normalizedUser.schoolId) {
        const error = new Error('Account is not assigned to a school workspace.');
        error.statusCode = 401;
        throw error;
    }

    if (
        decoded.schoolId &&
        String(decoded.schoolId).trim().toUpperCase() !== String(normalizedUser.schoolId).trim().toUpperCase()
    ) {
        const error = new Error('Session workspace mismatch. Please log in again.');
        error.statusCode = 401;
        throw error;
    }

    req.user = normalizedUser;
};

const protect = async (req, res, next) => {
    const token = getTokenFromRequest(req);

    if (!token) {
        return res.status(401).json({ message: 'Please sign in to continue.' });
    }

    try {
        await attachUser(req, token);
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                code: 'ACCESS_TOKEN_EXPIRED',
                message: 'Session needs renewal.',
            });
        }

        clearSessionCookies(res);
        res.status(error.statusCode || 401).json({
            code: 'AUTH_SESSION_INVALID',
            message: error.message || 'Please sign in again.',
        });
    }
};

const optionalProtect = async (req, res, next) => {
    const token = getTokenFromRequest(req);
    if (!token) {
        next();
        return;
    }

    try {
        await attachUser(req, token);
        next();
    } catch (error) {
        clearSessionCookies(res);
        res.status(401).json({
            code: 'AUTH_SESSION_INVALID',
            message: 'Please sign in again.',
        });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        const roleMap = { admin: 'Admin', teacher: 'Teacher', student: 'Student', super_admin: 'Super Admin', 'super admin': 'Super Admin' };
        const rawRole = req.user?.role;
        const userRole = typeof rawRole === 'string' ? roleMap[rawRole.trim().toLowerCase()] || rawRole : rawRole;
        const isAllowed = roles.includes(userRole) || (userRole === 'Super Admin' && roles.includes('Admin'));
        if (!req.user || !isAllowed) {
            return res.status(403).json({
                message: `Role (${userRole}) is not authorized to access this resource`
            });
        }
        next();
    };
};

module.exports = { protect, optionalProtect, authorize };
