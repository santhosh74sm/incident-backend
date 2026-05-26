const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');

const objectIdParamSchema = z.object({
    id: objectId,
});

const incidentIdParamSchema = z.object({
    incidentId: objectId,
});

const admissionNoParamSchema = z.object({
    admissionNo: z.coerce.string().trim().min(1).max(80),
});

const categoryParamSchema = z.object({
    category: z.coerce.string().trim().min(1).max(120),
});

const paginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
}).passthrough();

const optionalDateRangeQuerySchema = paginationQuerySchema.extend({
    fromDate: z.coerce.string().trim().max(40).optional(),
    toDate: z.coerce.string().trim().max(40).optional(),
    startDate: z.coerce.string().trim().max(40).optional(),
    endDate: z.coerce.string().trim().max(40).optional(),
}).passthrough();

const templateFormatQuerySchema = z.object({
    format: z.enum(['xlsx', 'csv']).optional(),
});

const globalSearchQuerySchema = z.object({
    query: z.coerce.string().trim().min(1).max(120),
});

module.exports = {
    objectId,
    objectIdParamSchema,
    incidentIdParamSchema,
    admissionNoParamSchema,
    categoryParamSchema,
    paginationQuerySchema,
    optionalDateRangeQuerySchema,
    templateFormatQuerySchema,
    globalSearchQuerySchema,
};
