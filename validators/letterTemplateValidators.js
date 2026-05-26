const { z } = require('zod');

const templateBodySchema = z.object({
    title: z.coerce.string().trim().min(1, 'Template title is required').max(160),
    incidentCategory: z.coerce.string().trim().min(1, 'Incident category is required').max(120),
    description: z.coerce.string().trim().max(1000).optional().default(''),
});

const templateUploadSchema = z.object({
    language: z.enum(['en', 'ta']).optional().default('en'),
});

const templateDocumentDeleteSchema = z.object({
    lang: z.enum(['en', 'ta']).optional().default('en'),
});

module.exports = {
    templateBodySchema,
    templateUploadSchema,
    templateDocumentDeleteSchema,
};
