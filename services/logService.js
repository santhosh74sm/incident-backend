const Log = require('../models/Log');
const mongoose = require('mongoose');
const Category = require('../models/Category');
const Location = require('../models/Location');
const EvidenceType = require('../models/EvidenceType');
const Incident = require('../models/Incident');
const Student = require('../models/Student');
const User = require('../models/User');
const LetterTemplate = require('../models/LetterTemplate');
const IssuedLetter = require('../models/IssuedLetter');
const { getPagination, normalizePositiveNumber, buildPaginationMeta } = require('../utils/pagination');
const { getAcademicYearQuery, getAcademicYearSummary } = require('./academicYearService');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_NOTIFICATION_LIMIT = 12;
const MAX_NOTIFICATION_LIMIT = 25;

const assertAuditLogAccess = (actor) => {
    if (actor?.role === 'Super Admin') return;
    const error = new Error('Only Super Admin can access activity logs.');
    error.statusCode = 403;
    throw error;
};

const NOTIFICATION_ENTITY_TYPES = {
    'Super Admin': ['Incident', 'Letter', 'Template', 'Student', 'Bulk Upload', 'Analytics', 'System', 'Category', 'Location', 'EvidenceType', 'User', 'Staff'],
    Admin: ['Incident', 'Letter', 'Template', 'Student', 'Bulk Upload', 'Analytics', 'System', 'Category', 'Location', 'EvidenceType', 'User', 'Staff'],
    Teacher: ['Incident', 'Letter', 'Analytics'],
};

const DISPLAY_ENTITY_LABELS = {
    Incident: 'Incident',
    Student: 'Student',
    Letter: 'Issued Letter',
    Template: 'Letter Template',
    Category: 'Incident Category',
    Location: 'Location',
    User: 'User',
    Staff: 'Staff',
    System: 'System Activity',
    Analytics: 'System Activity',
    'Bulk Upload': 'System Activity',
    EvidenceType: 'Evidence Type',
};

const LOOKUP_MODELS = {
    Category: { model: Category, select: 'name', label: (doc) => doc?.name },
    Location: { model: Location, select: 'name', label: (doc) => doc?.name },
    EvidenceType: { model: EvidenceType, select: 'name', label: (doc) => doc?.name },
    Incident: { model: Incident, select: 'title category studentsInvolved admissionNo', label: (doc) => doc?.title || doc?.category || doc?.studentsInvolved?.[0] },
    Student: { model: Student, select: 'name admissionNo', label: (doc) => doc?.name },
    Template: { model: LetterTemplate, select: 'title incidentCategory', label: (doc) => doc?.title || doc?.incidentCategory },
    Letter: { model: IssuedLetter, select: 'letterNumber title studentName admissionNo', label: (doc) => doc?.letterNumber || doc?.title || doc?.studentName },
    User: { model: User, select: 'name role email', label: (doc) => doc?.name || doc?.email },
    Staff: { model: User, select: 'name role email', label: (doc) => doc?.name || doc?.email },
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectIdLike = (value) => Boolean(value && mongoose.Types.ObjectId.isValid(String(value)));

const pickMetadataLabel = (metadata = {}) =>
    metadata.targetLabel ||
    metadata.name ||
    metadata.Name ||
    metadata.title ||
    metadata.Title ||
    metadata.label ||
    metadata.displayName ||
    metadata.studentName ||
    metadata.templateName ||
    metadata.letterNumber ||
    metadata.categoryName ||
    metadata.locationName ||
    metadata.staffName ||
    metadata.userName ||
    metadata.schoolName ||
    null;

const getDisplayEntityType = (logOrType) => {
    const log = typeof logOrType === 'object' && logOrType !== null ? logOrType : null;
    const rawType = log ? log.entityType : logOrType;
    const metadata = log?.metadata || {};
    const actionName = String(log?.actionName || '').toLowerCase();

    if (rawType === 'System' && (metadata.Role || metadata.role || actionName.includes('staff') || actionName.includes('user') || actionName.includes('password_reset'))) {
        return 'Staff';
    }

    return DISPLAY_ENTITY_LABELS[rawType] || 'System Activity';
};

const buildEntityTypeOptions = (entityTypes = []) => {
    const optionsByLabel = new Map();

    entityTypes.forEach((entityType) => {
        const label = getDisplayEntityType(entityType);
        const existing = optionsByLabel.get(label);
        optionsByLabel.set(label, {
            label,
            value: existing?.value ? `${existing.value},${entityType}` : entityType,
        });
    });

    return Array.from(optionsByLabel.values()).sort((a, b) => a.label.localeCompare(b.label));
};

const resolveTargetLabels = async (logs = []) => {
    const pendingByType = new Map();

    const preparedLogs = logs.map((log) => {
        const metadataLabel = pickMetadataLabel(log.metadata || {});
        const initialLabel = log.targetLabel || log.targetEntityLabel || metadataLabel;
        const displayEntityType = getDisplayEntityType(log);
        const needsLookup = (!initialLabel || isObjectIdLike(initialLabel)) && isObjectIdLike(log.entityId);

        if (needsLookup && LOOKUP_MODELS[log.entityType]) {
            const current = pendingByType.get(log.entityType) || new Set();
            current.add(String(log.entityId));
            pendingByType.set(log.entityType, current);
        }

        return {
            ...log,
            displayEntityType,
            targetLabel: initialLabel && !isObjectIdLike(initialLabel) ? initialLabel : null,
        };
    });

    const resolvedByType = new Map();
    await Promise.all(Array.from(pendingByType.entries()).map(async ([entityType, ids]) => {
        const lookup = LOOKUP_MODELS[entityType];
        const docs = await lookup.model.find({
            _id: { $in: Array.from(ids) },
            schoolId: logs[0]?.schoolId,
        }).select(lookup.select).lean();

        resolvedByType.set(entityType, new Map(docs.map((doc) => [String(doc._id), lookup.label(doc)])));
    }));

    return preparedLogs.map((log) => {
        const resolvedLabel = resolvedByType.get(log.entityType)?.get(String(log.entityId));
        const targetLabel = log.targetLabel || resolvedLabel || 'Record unavailable';

        return {
            ...log,
            targetLabel,
            targetEntityLabel: targetLabel,
        };
    });
};

const buildDateRange = (startDate, endDate) => {
    if (!startDate && !endDate) return null;

    const range = {};

    if (startDate) {
        const parsedStart = new Date(startDate);
        if (!Number.isNaN(parsedStart.getTime())) {
            parsedStart.setHours(0, 0, 0, 0);
            range.$gte = parsedStart;
        }
    }

    if (endDate) {
        const parsedEnd = new Date(endDate);
        if (!Number.isNaN(parsedEnd.getTime())) {
            parsedEnd.setHours(23, 59, 59, 999);
            range.$lte = parsedEnd;
        }
    }

    return Object.keys(range).length > 0 ? range : null;
};

const buildLogEnrichmentStages = () => [
    {
        $addFields: {
            performedByObjectId: {
                $convert: {
                    input: '$performedBy',
                    to: 'objectId',
                    onError: null,
                    onNull: null,
                },
            },
        },
    },
    {
        $lookup: {
            from: 'users',
            localField: 'performedByObjectId',
            foreignField: '_id',
            as: 'performedByUser',
        },
    },
    {
        $addFields: {
            performedByName: {
                $ifNull: [{ $arrayElemAt: ['$performedByUser.name', 0] }, '$performedBy'],
            },
            performedByRole: {
                $ifNull: [{ $arrayElemAt: ['$performedByUser.role', 0] }, null],
            },
            targetAdmissionNumber: {
                $ifNull: [
                    '$metadata.targetAdmissionNumber',
                    {
                        $ifNull: [
                            '$metadata.Admission Number',
                            {
                                $ifNull: ['$metadata.admissionNo', '$metadata.studentAdmissionNumber'],
                            },
                        ],
                    },
                ],
            },
            targetEntityLabel: {
                $ifNull: [
                    '$targetLabel',
                    {
                        $ifNull: [
                            '$metadata.targetLabel',
                            {
                                $ifNull: [
                                    '$metadata.Name',
                                    {
                                        $ifNull: [
                                            '$metadata.name',
                                            {
                                                $ifNull: [
                                                    '$metadata.Title',
                                                    {
                                                        $ifNull: [
                                                            '$metadata.title',
                                                            {
                                                                $ifNull: [
                                                                    '$metadata.studentName',
                                                                    {
                                                                        $ifNull: [
                                                                            '$metadata.templateName',
                                                                            '$metadata.letterNumber',
                                                                        ],
                                                                    },
                                                                ],
                                                            },
                                                        ],
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        },
    },
];

const getLogs = async (query = {}, actor = null) => {
    assertAuditLogAccess(actor);
    const { page, limit, skip } = getPagination(query, {
        defaultLimit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
    });
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const rawEntityType = typeof query.entityType === 'string' ? query.entityType : '';
    const entityTypes = rawEntityType.split(',').map((value) => value.trim()).filter(Boolean);
    const academicYear = getAcademicYearQuery(query.academicYear);
    const createdAtRange = buildDateRange(query.startDate, query.endDate);

    const baseMatch = { schoolId: actor?.schoolId };
    if (entityTypes.length > 0) baseMatch.entityType = { $in: entityTypes };
    if (academicYear) baseMatch.academicYear = academicYear;
    if (createdAtRange) baseMatch.createdAt = createdAtRange;

    const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : null;
    const pipeline = [
        { $match: baseMatch },
        ...buildLogEnrichmentStages(),
    ];

    if (searchRegex) {
        pipeline.push({
            $match: {
                $or: [
                    { actionName: searchRegex },
                    { performedByName: searchRegex },
                    { targetAdmissionNumber: searchRegex },
                    { targetEntityLabel: searchRegex },
                    { entityType: searchRegex },
                    { entityId: searchRegex },
                ],
            },
        });
    }

    pipeline.push(
        { $sort: { createdAt: -1, _id: -1 } },
        {
            $facet: {
                data: [
                    { $skip: skip },
                    { $limit: limit },
                    { $project: { performedByUser: 0, performedByObjectId: 0 } },
                ],
                totalCount: [{ $count: 'count' }],
            },
        }
    );

    const [result, entityTypeOptions, academicYearSummary] = await Promise.all([
        Log.aggregate(pipeline).allowDiskUse(false),
        Log.distinct('entityType', { schoolId: actor?.schoolId }),
        getAcademicYearSummary(actor),
    ]);

    const logs = await resolveTargetLabels(result?.[0]?.data || []);
    const total = result?.[0]?.totalCount?.[0]?.count || 0;
    const sortedEntityTypes = entityTypeOptions.sort((a, b) => a.localeCompare(b));

    return {
        logs,
        pagination: buildPaginationMeta({ page, limit, total }),
        filters: {
            entityTypes: sortedEntityTypes,
            entityTypeOptions: buildEntityTypeOptions(sortedEntityTypes),
            academicYears: academicYearSummary.academicYears || [],
            currentAcademicYear: academicYearSummary.currentAcademicYear || '',
        },
    };
};

const getNotificationFeed = async ({ limit: rawLimit, role, actor }) => {
    const limit = Math.min(normalizePositiveNumber(rawLimit, DEFAULT_NOTIFICATION_LIMIT), MAX_NOTIFICATION_LIMIT);
    const allowedEntityTypes = NOTIFICATION_ENTITY_TYPES[role] || NOTIFICATION_ENTITY_TYPES.Teacher;

    const notifications = await Log.aggregate([
        {
            $match: {
                entityType: { $in: allowedEntityTypes },
                actionName: { $not: /login/i },
                schoolId: actor?.schoolId,
            },
        },
        ...buildLogEnrichmentStages(),
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: limit },
        { $project: { performedByObjectId: 0, performedByUser: 0 } },
    ]);

    return {
        notifications: await resolveTargetLabels(notifications),
        meta: { limit, role: role || null },
    };
};

const clearLogs = async (actor) => {
    assertAuditLogAccess(actor);
    await Log.deleteMany({ schoolId: actor?.schoolId });
    return { message: 'Activity history cleared.' };
};

module.exports = { getLogs, getNotificationFeed, clearLogs };
