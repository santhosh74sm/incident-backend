const generateToken = require('../config/generateToken');
const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const {
    setAuthCookie: setCookie,
    setRefreshCookie,
    clearAuthCookie,
    clearRefreshCookie,
    clearSessionCookies,
} = require('../config/authCookies');
const { clearCsrfCookie, setCsrfCookie } = require('../middleware/csrf.middleware');

const setAuthCookie = (res, user, type) => {
    setCookie(res, generateToken(user, type), type);
};

const setSessionCookies = (res, session) => {
    setCookie(res, session.accessToken);
    setRefreshCookie(res, session.refreshToken);
    setCsrfCookie(res);
};

const getAdminExists = async (req, res, next) => {
    try {
        res.json({ exists: await authService.getAdminExists() });
    } catch (error) {
        next(error);
    }
};

const registerUser = async (req, res, next) => {
    try {
        const result = await authService.createWorkspace({
            input: req.body,
        });

        setSessionCookies(res, await sessionService.issueSession({
            user: result.user,
            type: 'staff',
            req,
        }));
        res.status(201).json(result.response);
    } catch (error) {
        next(error);
    }
};

const createStaffUser = async (req, res, next) => {
    try {
        const result = await authService.registerUser({
            input: req.body,
            actor: req.user,
        });

        res.status(201).json(result.response);
    } catch (error) {
        next(error);
    }
};

const loginUser = async (req, res, next) => {
    try {
        const result = await authService.loginUser(req.body);
        setSessionCookies(res, await sessionService.issueSession({
            user: result.user,
            type: result.tokenType,
            req,
        }));
        res.json(result.response);
    } catch (error) {
        next(error);
    }
};

const getMe = async (req, res, next) => {
    try {
        res.json(await authService.getCurrentUserResponse(req.user));
    } catch (error) {
        next(error);
    }
};

const getCsrf = async (req, res) => {
    res.json({ csrfToken: res.getHeader('X-CSRF-Token') || null });
};

const refreshSession = async (req, res, next) => {
    try {
        const session = await sessionService.rotateRefreshSession({
            rawRefreshToken: req.cookies?.refreshToken,
            req,
        });
        setSessionCookies(res, session);
        res.json(await authService.getCurrentUserResponse(session.user));
    } catch (error) {
        if (error.code !== 'REFRESH_RETRY_GRACE') {
            clearSessionCookies(res);
        }
        next(error);
    }
};

const logoutUser = async (req, res) => {
    await sessionService.revokeRefreshToken(req.cookies?.refreshToken);
    clearSessionCookies(res);
    clearCsrfCookie(res);
    res.json({ message: 'Logged out.' });
};

const getAllUsers = async (req, res, next) => {
    try {
        res.json(await authService.getAllUsers({ actor: req.user }));
    } catch (error) {
        next(error);
    }
};

const deleteUser = async (req, res, next) => {
    try {
        res.json(await authService.deleteUser({
            id: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/auth/student/change-password
 * Allows an authenticated student to change their password.
 * Issues a fresh cookie with the updated tokenVersion so the session
 * remains active (the user does NOT need to log in again).
 */
const changeStudentPassword = async (req, res, next) => {
    try {
        const result = await authService.changeStudentPassword({
            studentId: req.user._id || req.user.id,
            currentPassword: req.body.currentPassword,
            newPassword: req.body.newPassword,
            confirmPassword: req.body.confirmPassword,
        });

        clearRefreshCookie(res);
        setSessionCookies(res, await sessionService.issueSession({
            user: result.user,
            type: 'student',
            req,
        }));
        res.json(result.response);
    } catch (error) {
        next(error);
    }
};

const changeStaffPassword = async (req, res, next) => {
    try {
        const result = await authService.changeStaffPassword({
            userId: req.user._id || req.user.id,
            currentPassword: req.body.currentPassword,
            newPassword: req.body.newPassword,
            confirmPassword: req.body.confirmPassword,
        });

        clearRefreshCookie(res);
        setSessionCookies(res, await sessionService.issueSession({
            user: result.user,
            type: 'staff',
            req,
        }));
        res.json(result.response);
    } catch (error) {
        next(error);
    }
};

const updateUser = async (req, res, next) => {
    try {
        res.json(await authService.updateUser({
            id: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const resetUserPassword = async (req, res, next) => {
    try {
        res.json(await authService.resetUserPassword({
            id: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const getAcademicYears = async (req, res, next) => {
    try {
        res.json(await authService.getAcademicYearSummary(req.user));
    } catch (error) {
        next(error);
    }
};

const updateAcademicYear = async (req, res, next) => {
    try {
        res.json(await authService.changeAcademicYear({
            actor: req.user,
            academicYear: req.body.academicYear,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getAdminExists,
    registerUser,
    createStaffUser,
    loginUser,
    refreshSession,
    getAllUsers,
    updateUser,
    deleteUser,
    getMe,
    getCsrf,
    logoutUser,
    resetUserPassword,
    changeStaffPassword,
    changeStudentPassword,
    getAcademicYears,
    updateAcademicYear,
};
