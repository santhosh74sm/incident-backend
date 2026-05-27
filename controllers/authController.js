const generateToken = require('../config/generateToken');
const env = require('../config/env');
const authService = require('../services/authService');

const cookieOptions = (type = 'staff') => ({
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: type === 'student' ? 8 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
    path: '/',
});

const setAuthCookie = (res, user, type) => {
    res.cookie('token', generateToken(user, type), cookieOptions(type));
};

const clearAuthCookie = (res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
    });
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
        const result = await authService.registerUser({
            input: req.body,
            actor: null,
        });

        setAuthCookie(res, result.user, 'staff');
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

const requestPasswordResetOtp = async (req, res, next) => {
    try {
        res.json(await authService.requestPasswordResetOtp(req.body));
    } catch (error) {
        // Replace any technical SMTP message with a school-friendly one
        if (!error.statusCode || error.statusCode >= 500) {
            error.message =
                'The email service is temporarily unavailable. Please contact the administrator.';
            error.statusCode = 503;
        }
        next(error);
    }
};

const verifyPasswordResetOtp = async (req, res, next) => {
    try {
        res.json(await authService.verifyPasswordResetOtp(req.body));
    } catch (error) {
        next(error);
    }
};

const resetPassword = async (req, res, next) => {
    try {
        res.json(await authService.resetPassword(req.body));
    } catch (error) {
        next(error);
    }
};

const loginUser = async (req, res, next) => {
    try {
        const result = await authService.loginUser(req.body);
        setAuthCookie(res, result.user, result.tokenType);
        res.json(result.response);
    } catch (error) {
        next(error);
    }
};

const getMe = async (req, res) => {
    res.json(authService.getCurrentUserResponse(req.user));
};

const logoutUser = (req, res) => {
    clearAuthCookie(res);
    res.json({ message: 'Logged out' });
};

const getAllUsers = async (req, res, next) => {
    try {
        res.json(await authService.getAllUsers());
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
        });

        setAuthCookie(res, result.user, 'student');
        res.json(result.response);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getAdminExists,
    registerUser,
    createStaffUser,
    loginUser,
    getAllUsers,
    deleteUser,
    getMe,
    logoutUser,
    requestPasswordResetOtp,
    verifyPasswordResetOtp,
    resetPassword,
    changeStudentPassword,
};
