const express = require('express');
const router = express.Router();
const {
    getAdminExists,
    registerUser,
    createStaffUser,
    loginUser,
    getAllUsers,
    deleteUser,
    getMe,
    getCsrf,
    logoutUser,
    changeStudentPassword,
    refreshSession,
    changeStaffPassword,
    resetUserPassword,
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const {
    registerSchema,
    loginSchema,
    changeStudentPasswordSchema,
} = require('../validators/authValidators');
const { objectIdParamSchema } = require('../validators/commonValidators');
const { authSensitiveRateLimiter } = require('../middleware/rateLimit.middleware');

router.get('/admin-exists', getAdminExists);
router.get('/bootstrap-status', getAdminExists);
router.get('/csrf', getCsrf);
router.get('/csrf-token', getCsrf);
router.post('/register', authSensitiveRateLimiter, validate(registerSchema), registerUser);
router.post('/login', authSensitiveRateLimiter, validate(loginSchema), loginUser);
router.post('/refresh', refreshSession);
router.post('/logout', logoutUser);
router.get('/me', protect, getMe);
// Student-specific auth routes
router.post(
    '/student/change-password',
    protect,
    authorize('Student'),
    validate(changeStudentPasswordSchema),
    changeStudentPassword
);
router.post('/change-password', protect, validate(changeStudentPasswordSchema), changeStaffPassword);

router.post('/users', protect, authorize('Super Admin', 'Admin'), validate(registerSchema), createStaffUser);
router.get('/users', protect, authorize('Super Admin', 'Admin', 'Teacher'), getAllUsers);
router.post('/users/:id/reset-password', protect, authorize('Super Admin'), validate(objectIdParamSchema, 'params'), resetUserPassword);
router.delete('/users/:id', protect, authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), deleteUser);

module.exports = router;
