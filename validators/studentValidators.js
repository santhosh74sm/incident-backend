const { z } = require('zod');
const { paginationQuerySchema } = require('./commonValidators');

const studentFilterQuerySchema = paginationQuerySchema.extend({
    className: z.coerce.string().trim().max(40).optional(),
    section: z.coerce.string().trim().max(20).optional(),
    search: z.coerce.string().trim().max(120).optional(),
}).passthrough();

const studentSchema = z.object({
    admissionNo: z.coerce.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(160),
    className: z.coerce.string().trim().min(1).max(40),
    section: z.coerce.string().trim().min(1).max(20).transform((value) => value.toUpperCase()),
    academicYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Academic Year must use YYYY-YY format').optional(),
    status: z.enum(['Active', 'Passed Out', 'Alumni']).optional(),
});

module.exports = {
    createStudentSchema: studentSchema,
    updateStudentSchema: studentSchema.partial().refine((value) => Object.keys(value).length > 0, {
        message: 'At least one student field is required',
    }),
    studentFilterQuerySchema,
};
