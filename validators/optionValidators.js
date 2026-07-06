const { z } = require('zod');

const nameSchema = z.object({
    name: z.string().trim().min(1).max(120),
});

const evidenceTypeSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().default(''),
});

const fieldOperationOptionSchema = z.object({
    label: z.string().trim().min(1).max(200),
    type: z.enum(['handler', 'assigner', 'updated']),
});

const reorderOptionsSchema = z.object({
    options: z.array(z.object({
        _id: z.string().optional(),
        id: z.string().optional(),
        type: z.enum(['handler', 'assigner', 'updated']).optional(),
    }).passthrough()).min(1),
});

module.exports = {
    nameSchema,
    evidenceTypeSchema,
    fieldOperationOptionSchema,
    reorderOptionsSchema,
};
