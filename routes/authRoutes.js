const express = require('express');
const router = express.Router();
const {
    getAdminExists,
    registerUser,
    createStaffUser,
    loginUser,
    getAllUsers,
    deleteUser,
    requestPasswordResetOtp,
    verifyPasswordResetOtp,
    resetPassword,
    getMe,
    logoutUser,
    changeStudentPassword,
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const {
    registerSchema,
    loginSchema,
    forgotPasswordSchema,
    verifyOtpSchema,
    resetPasswordSchema,
    changeStudentPasswordSchema,
} = require('../validators/authValidators');
const { objectIdParamSchema } = require('../validators/commonValidators');
const { authSensitiveRateLimiter } = require('../middleware/rateLimit.middleware');

router.get('/admin-exists', getAdminExists);
router.get('/bootstrap-status', getAdminExists);
router.post('/register', validate(registerSchema), registerUser);
router.post('/login', authSensitiveRateLimiter, validate(loginSchema), loginUser);
router.post('/logout', logoutUser);
router.get('/me', protect, getMe);
router.post('/forgot-password', authSensitiveRateLimiter, validate(forgotPasswordSchema), requestPasswordResetOtp);
router.post('/verify-reset-otp', authSensitiveRateLimiter, validate(verifyOtpSchema), verifyPasswordResetOtp);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

// Student-specific auth routes
router.post(
    '/student/change-password',
    protect,
    authorize('Student'),
    validate(changeStudentPasswordSchema),
    changeStudentPassword
);

router.post('/users', protect, authorize('Admin'), validate(registerSchema), createStaffUser);
router.get('/users', protect, authorize('Admin', 'Teacher'), getAllUsers);
router.delete('/users/:id', protect, authorize('Admin'), validate(objectIdParamSchema, 'params'), deleteUser);

module.exports = router;
