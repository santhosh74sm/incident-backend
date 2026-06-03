const Log = require('../models/Log');
const { getPagination, normalizePositiveNumber, buildPaginationMeta } = require('../utils/pagination');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_NOTIFICATION_LIMIT = 12;
const MAX_NOTIFICATION_LIMIT = 25;

const NOTIFICATION_ENTITY_TYPES = {
    'Super Admin': ['Incident', 'Letter', 'Template', 'Student', 'Bulk Upload', 'Analytics', 'System', 'Category', 'Location', 'EvidenceType'],
    Admin: ['Incident', 'Letter', 'Template', 'Student', 'Bulk Upload', 'Analytics', 'System', 'Category', 'Location', 'EvidenceType'],
    Teacher: ['Incident', 'Letter', 'Analytics'],
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
                    '$metadata.Admission Number',
                    {
                        $ifNull: ['$metadata.admissionNo', '$metadata.studentAdmissionNumber'],
                    },
                ],
            },
            targetEntityLabel: {
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
        },
    },
];

const getLogs = async (query = {}, actor = null) => {
    const { page, limit, skip } = getPagination(query, {
        defaultLimit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
    });
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const rawEntityType = typeof query.entityType === 'string' ? query.entityType : '';
    const entityTypes = rawEntityType.split(',').map((value) => value.trim()).filter(Boolean);
    const createdAtRange = buildDateRange(query.startDate, query.endDate);

    const baseMatch = { schoolId: actor?.schoolId };
    if (entityTypes.length > 0) baseMatch.entityType = { $in: entityTypes };
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

    const [result, entityTypeOptions] = await Promise.all([
        Log.aggregate(pipeline).allowDiskUse(false),
        Log.distinct('entityType', { schoolId: actor?.schoolId }),
    ]);

    const logs = result?.[0]?.data || [];
    const total = result?.[0]?.totalCount?.[0]?.count || 0;

    return {
        logs,
        pagination: buildPaginationMeta({ page, limit, total }),
        filters: {
            entityTypes: entityTypeOptions.sort((a, b) => a.localeCompare(b)),
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
        notifications,
        meta: { limit, role: role || null },
    };
};

const clearLogs = async (actor) => {
    await Log.deleteMany({ schoolId: actor?.schoolId });
    return { message: 'Activity history cleared.' };
};

module.exports = { getLogs, getNotificationFeed, clearLogs };
