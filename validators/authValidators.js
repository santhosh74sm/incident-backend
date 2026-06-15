const { z } = require('zod');

const PASSWORD_MIN_LENGTH = 8;

const registerSchema = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    password: z.string()
        .min(PASSWORD_MIN_LENGTH, 'Password must be at least 8 characters')
        .max(200)
        .regex(/[a-z]/, 'Password must include a lowercase letter')
        .regex(/[A-Z]/, 'Password must include an uppercase letter')
        .regex(/\d/, 'Password must include a number')
        .regex(/[^A-Za-z0-9]/, 'Password must include a symbol'),
    role: z.string().trim().min(1).max(40),
    class: z.string().trim().max(40).optional().default(''),
});

const updateUserSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    role: z.enum(['Admin', 'Teacher']).optional(),
}).refine((data) => data.name !== undefined || data.email !== undefined || data.role !== undefined, {
    message: 'At least one profile field is required',
});

const workspaceSchema = z.object({
    schoolName: z.string().trim().min(2).max(160),
    superAdminName: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    academicYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Academic Year must use YYYY-YY format'),
    password: z.string()
        .min(PASSWORD_MIN_LENGTH, 'Password must be at least 8 characters')
        .max(200)
        .regex(/[a-z]/, 'Password must include a lowercase letter')
        .regex(/[A-Z]/, 'Password must include an uppercase letter')
        .regex(/\d/, 'Password must include a number')
        .regex(/[^A-Za-z0-9]/, 'Password must include a symbol'),
});

const academicYearSchema = z.object({
    academicYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Academic Year must use YYYY-YY format').optional(),
});

const loginSchema = z.object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
    loginType: z.enum(['staff', 'student']),
    schoolId: z.string().trim().max(40).optional(),
});

const changeStudentPasswordSchema = z
    .object({
        currentPassword: z.string().min(1, 'Current password is required').max(200),
        newPassword: z.string()
            .min(PASSWORD_MIN_LENGTH, 'New password must be at least 8 characters')
            .max(200)
            .regex(/[a-z]/, 'New password must include a lowercase letter')
            .regex(/[A-Z]/, 'New password must include an uppercase letter')
            .regex(/\d/, 'New password must include a number')
            .regex(/[^A-Za-z0-9]/, 'New password must include a symbol'),
        confirmPassword: z.string().min(1, 'Confirm password is required').max(200),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
        message: 'Passwords do not match',
        path: ['confirmPassword'],
    });

module.exports = {
    registerSchema,
    updateUserSchema,
    workspaceSchema,
    academicYearSchema,
    loginSchema,
    changeStudentPasswordSchema,
};
