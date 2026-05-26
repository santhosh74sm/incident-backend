const { z } = require('zod');
const { objectId, paginationQuerySchema } = require('./commonValidators');

const batchIncidentIdsSchema = z.object({
    incidentIds: z.array(objectId).min(1).max(200),
});

const createIssuedLetterSchema = z.object({
    incidentId: objectId.optional(),
    incident: objectId.optional(),
    language: z.enum(['en', 'ta']).optional(),
    letterLanguage: z.enum(['en', 'ta']).optional(),
}).refine((value) => Boolean(value.incidentId || value.incident), {
    message: 'incidentId is required',
    path: ['incidentId'],
});

const updateIssuedLetterSchema = z.object({
    status: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(2000).optional(),
}).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
});

const studentLettersQuerySchema = paginationQuerySchema;

module.exports = {
    batchIncidentIdsSchema,
    createIssuedLetterSchema,
    updateIssuedLetterSchema,
    studentLettersQuerySchema,
};
