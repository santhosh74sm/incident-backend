const { z } = require('zod');
const { objectId, optionalDateRangeQuerySchema, templateFormatQuerySchema } = require('./commonValidators');

const optionalBoolean = z.union([z.boolean(), z.enum(['true', 'false'])]).optional();
const optionalString = (max = 500) => z.coerce.string().trim().max(max).optional();

const listIncidentsQuerySchema = optionalDateRangeQuerySchema.extend({
    academicYear: optionalString(20),
}).passthrough();

const approveAndAssignSchema = z.object({
    handlerId: objectId,
});

const progressNoteSchema = z.object({
    note: z.coerce.string().trim().min(1).max(5000),
});

const requestClosureSchema = z.object({
    actionTaken: z.coerce.string().trim().min(1).max(5000),
});

const finalizeClosureSchema = z.object({
    note: optionalString(5000),
});

const rejectClosureSchema = z.object({
    reason: optionalString(2000),
});

const addEvidenceSchema = z.object({
    evidenceDetails: optionalString(5000),
});

const createIncidentSchema = z.object({
    studentIds: optionalString(5000),
    studentsInvolved: optionalString(5000),
    admissionNo: optionalString(80),
    evidence: optionalString(10000),
    evidenceDetails: optionalString(10000),
    category: z.coerce.string().trim().min(1).max(120),
    description: optionalString(3000),
    location: optionalString(200),
    severity: optionalString(40),
    isHighPriority: optionalBoolean,
    highPriority: optionalString(20),
    academicYear: optionalString(20),
    class: optionalString(40),
    section: optionalString(20),
    assignedHandler: optionalString(80),
    shouldGenerateLetter: optionalBoolean,
    letterLanguage: z.enum(['en', 'ta']).optional(),
    manualTiming: optionalBoolean,
    initialStatus: z.enum(['Open', 'In Progress', 'Closed']).optional(),
    openedAt: optionalString(80),
    inProgressAt: optionalString(80),
    closedAt: optionalString(80),
});

module.exports = {
    createIncidentSchema,
    listIncidentsQuerySchema,
    approveAndAssignSchema,
    progressNoteSchema,
    requestClosureSchema,
    finalizeClosureSchema,
    rejectClosureSchema,
    addEvidenceSchema,
    templateFormatQuerySchema,
};
