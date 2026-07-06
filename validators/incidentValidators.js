const { z } = require('zod');
const { objectId, optionalDateRangeQuerySchema, templateFormatQuerySchema } = require('./commonValidators');

const optionalBoolean = z.union([z.boolean(), z.enum(['true', 'false'])]).optional();
const optionalString = (max = 500) => z.coerce.string().trim().max(max).optional();
const optionalScalarString = (max = 500) =>
    z.string().trim().max(max).optional();

const listIncidentsQuerySchema = optionalDateRangeQuerySchema.extend({
    academicYear: optionalString(20),
}).passthrough();

const assignIncidentSchema = z.object({
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

const updateDescriptionSchema = z.object({
    description: z.coerce.string().trim().max(3000).optional().default(''),
});

const evidenceParamSchema = z.object({
    id: objectId,
    evidenceId: objectId,
});

const createIncidentSchema = z.object({
    studentId: optionalScalarString(80),
    studentIds: z.any().optional(),
    studentsInvolved: z.any().optional(),
    admissionNo: optionalScalarString(80),
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
    initialStatus: z.enum(['Pending', 'Closed']).optional(),
    status: z.enum(['Pending', 'Closed']).optional(),
    actionTaken: optionalString(5000),
    openedAt: optionalString(80),
    inProgressAt: optionalString(80),
    closedAt: optionalString(80),
}).superRefine((data, ctx) => {
    if (data.studentIds !== undefined && String(data.studentIds || '').trim() !== '') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['studentIds'],
            message: 'Manual incident creation accepts exactly one student. Please send studentId, not studentIds.',
        });
    }

    if (Array.isArray(data.studentsInvolved)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['studentsInvolved'],
            message: 'Manual incident creation accepts exactly one student.',
        });
    } else if (typeof data.studentsInvolved === 'string') {
        try {
            const parsed = JSON.parse(data.studentsInvolved);
            if (Array.isArray(parsed)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['studentsInvolved'],
                    message: 'Manual incident creation accepts exactly one student.',
                });
            }
        } catch {
            // Plain scalar names are allowed for legacy clients; the service derives the saved value from the student record.
        }
    }

    if (!data.studentId && !data.admissionNo) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['studentId'],
            message: 'Please select a student.',
        });
    }
});

module.exports = {
    createIncidentSchema,
    listIncidentsQuerySchema,
    assignIncidentSchema,
    progressNoteSchema,
    requestClosureSchema,
    finalizeClosureSchema,
    rejectClosureSchema,
    addEvidenceSchema,
    updateDescriptionSchema,
    evidenceParamSchema,
    templateFormatQuerySchema,
};
