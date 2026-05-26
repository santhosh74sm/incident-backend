const { z } = require('zod');

const registerSchema = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    password: z.string().min(6).max(200),
    role: z.string().trim().min(1).max(40),
    class: z.string().trim().max(40).optional().default(''),
});

const loginSchema = z.object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
    loginType: z.enum(['staff', 'student']),
});

const forgotPasswordSchema = z.object({
    email: z.string().trim().email().max(254),
});

const verifyOtpSchema = z.object({
    email: z.string().trim().email().max(254),
    otp: z.string().trim().regex(/^\d{6}$/),
});

const resetPasswordSchema = z.object({
    token: z.string().trim().min(32).max(200),
    password: z.string().min(6).max(200),
});

const changeStudentPasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Current password is required').max(200),
    newPassword: z.string().min(6, 'New password must be at least 6 characters').max(200),
});

module.exports = {
    registerSchema,
    loginSchema,
    forgotPasswordSchema,
    verifyOtpSchema,
    resetPasswordSchema,
    changeStudentPasswordSchema,
};
