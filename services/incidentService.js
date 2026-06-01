/**
 * incidentService.js
 * All business logic for incident creation, querying, status transitions, and bulk operations.
 * Controllers must only call these functions — they must not implement logic themselves.
 */

'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');

const Incident = require('../models/Incident');
const Student = require('../models/Student');
const User = require('../models/User');
const Category = require('../models/Category');
const Location = require('../models/Location');
const EvidenceType = require('../models/EvidenceType');
const Log = require('../models/Log');

const { createLog } = require('../utils/logger');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { safeSheetToJson } = require('../utils/spreadsheetSecurity');
const { autoGenerateLetterFromIncident } = require('./issuedLetterService');
const notificationService = require('./notificationService');
const { letterQueue, bulkQueue } = require('../utils/asyncQueue');
const logger = require('../utils/pinoLogger');
const s3StorageService = require('./s3StorageService');
const { buildCaseReportDocx } = require('./reports/caseReportService');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ADMIN_ROLES = ['Super Admin', 'Admin', 'super_admin', 'admin'];
const ADMIN_KEYWORDS = ['admin', 'super_admin', 'super admin', 'administration'];
const MAX_PROGRESS_LOGS = 500;
const isAdministrationRole = (role) => ADMIN_ROLES.includes(role);

const toIdString = (value) => {
    if (!value) return '';
    if (value._id) return String(value._id);
    return String(value);
};

const canAccessIncident = (incident, user) => {
    if (!incident || !user) return false;
    if (isAdministrationRole(user.role)) return true;

    const userId = toIdString(user.id || user._id);

    if (user.role === 'Teacher') {
        return [incident.reportedBy, incident.assignedHandler].some((id) => toIdString(id) === userId);
    }

    if (user.role === 'Student') {
        return String(incident.admissionNo || '') === String(user.admissionNo || '');
    }

    return false;
};

const assertIncidentAccess = (incident, user, action = 'access') => {
    if (canAccessIncident(incident, user)) return;

    const err = new Error(`You are not allowed to ${action} this incident.`);
    err.statusCode = 403;
    throw err;
};

const assertIncidentMutationAccess = (incident, user, action) => {
    if (user?.role === 'Student') {
        const err = new Error('Students cannot modify incidents.');
        err.statusCode = 403;
        throw err;
    }

    assertIncidentAccess(incident, user, action);
};

const buildAlternationRegex = (values) => {
    const parts = Array.from(values).map(escapeRegex);
    if (parts.length === 0) return null;
    return new RegExp(`^(${parts.join('|')})$`, 'i');
};

const findByNameSet = (Model, values) => {
    const regex = buildAlternationRegex(values);
    if (!regex) return Promise.resolve([]);
    return Model.find({ name: { $regex: regex } }).select('name').lean();
};

const findByFieldRegexSet = (Model, field, values) => {
    const patterns = Array.from(values).map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i'));
    if (patterns.length === 0) return Promise.resolve([]);
    return Model.find({ [field]: { $in: patterns } }).lean();
};

const getPublicUploadPath = (file) => {
    if (file?.location) return file.location;
    if (!file?.filename) return null;
    return `/api/uploads/${file.filename}`;
};

const trimProgressLogsBeforePush = (incident) => {
    if (incident.progressLogs.length >= MAX_PROGRESS_LOGS) {
        incident.progressLogs.shift();
    }
};

const extractS3KeyFromProtectedUrl = (fileUrl) => {
    const marker = '/s3/';
    const value = String(fileUrl || '');
    const markerIndex = value.indexOf(marker);
    if (markerIndex === -1) return '';

    const key = value.slice(markerIndex + marker.length).split('?')[0].split('#')[0];
    try {
        return decodeURIComponent(key);
    } catch {
        return key;
    }
};

const deleteIncidentEvidenceFromS3 = async (incident) => {
    const keys = (incident.evidence || [])
        .map((entry) => extractS3KeyFromProtectedUrl(entry?.fileUrl))
        .filter(Boolean);

    if (keys.length === 0) return;

    await Promise.allSettled(keys.map((key) => s3StorageService.deleteObject(key)));
};

const buildEvidenceEntriesFromUploads = (files = [], evidenceDataList = []) =>
    files
        .map((file, index) => {
            const meta = evidenceDataList[index] || {};
            const fileUrl = getPublicUploadPath(file);
            if (!fileUrl) return null;
            return { evidenceType: meta.evidenceType || 'General Evidence', fileUrl };
        })
        .filter(Boolean);

const buildIncidentStudentDetails = (incident) => ({
    studentsInvolved: Array.isArray(incident?.studentsInvolved)
        ? incident.studentsInvolved.filter(Boolean)
        : incident?.studentsInvolved ? [incident.studentsInvolved] : [],
    class: incident?.class || '',
    section: incident?.section || '',
});

const buildIncidentMetadata = (incident, extra = {}) => ({
    title: incident?.title || incident?.category || 'Incident',
    studentName: Array.isArray(incident?.studentsInvolved)
        ? incident.studentsInvolved[0] || null
        : incident?.studentsInvolved || null,
    studentsInvolved: Array.isArray(incident?.studentsInvolved)
        ? incident.studentsInvolved.filter(Boolean)
        : incident?.studentsInvolved ? [incident.studentsInvolved] : [],
    class: incident?.class || null,
    section: incident?.section || null,
    category: incident?.category || incident?.incidentCategory || null,
    admissionNo: incident?.admissionNo || null,
    targetLabel: incident?.title || incident?.category || 'Incident',
    targetAdmissionNumber: incident?.admissionNo || null,
    incidentId: incident?._id?.toString?.() || incident?._id || null,
    routePath: incident?._id ? `/incidents/${incident._id}` : '/incidents',
    studentDetails: buildIncidentStudentDetails(incident),
    ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// Query builder helpers
// ─────────────────────────────────────────────────────────────────────────────

const parseListParam = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(',').map((v) => v.trim()).filter(Boolean);
};

const parseAliasedListParam = (query, keys = []) =>
    [...new Set(keys.flatMap((key) => parseListParam(query?.[key])))];

const STATUS_LOOKUP = {
    open: 'Open',
    'in progress': 'In Progress',
    'in-progress': 'In Progress',
    inprogress: 'In Progress',
    closed: 'Closed',
};

const normalizeStatuses = (values = []) =>
    values.map((v) => STATUS_LOOKUP[String(v || '').trim().toLowerCase()]).filter(Boolean);

const parseLocalCalendarDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    const normalized = String(value).trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
        const [, year, month, day] = match;
        return new Date(Number(year), Number(month) - 1, Number(day));
    }
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseDateBoundary = (value, boundary) => {
    const parsed = parseLocalCalendarDate(value);
    if (!parsed) return null;
    if (boundary === 'end') { parsed.setHours(23, 59, 59, 999); return parsed; }
    parsed.setHours(0, 0, 0, 0);
    return parsed;
};

const buildIncidentDateRangeQuery = (startDateValue, endDateValue) => {
    if (!startDateValue && !endDateValue) return null;
    const dateQuery = {};
    const startDate = parseDateBoundary(startDateValue, 'start');
    if (startDate) dateQuery.$gte = startDate;
    const endDate = parseDateBoundary(endDateValue, 'end');
    if (endDate) dateQuery.$lte = endDate;
    if (Object.keys(dateQuery).length === 0) return null;
    return { $or: [{ incidentDate: dateQuery }, { incident_date: dateQuery }] };
};

const buildIncidentQuery = async (user, query) => {
    const baseConditions = [];

    if (user.role === 'Teacher') {
        baseConditions.push({ $or: [{ reportedBy: user.id }, { assignedHandler: user.id }] });
    }

    const classes = parseAliasedListParam(query, ['classes', 'class', 'className']);
    if (classes.length > 0) baseConditions.push({ class: { $in: classes } });

    const sections = parseAliasedListParam(query, ['sections', 'section', 'sectionName']);
    if (sections.length > 0) baseConditions.push({ section: { $in: sections } });

    const students = parseAliasedListParam(query, ['students', 'student', 'studentName']);
    if (students.length > 0) baseConditions.push({ studentsInvolved: { $in: students } });

    const admissionNumbers = parseAliasedListParam(query, ['admissionNo', 'admissionNos', 'admissionNumber']);
    if (admissionNumbers.length > 0) baseConditions.push({ admissionNo: { $in: admissionNumbers } });

    const types = parseAliasedListParam(query, ['types', 'type', 'category', 'categories', 'incidentCategory']);
    if (types.length > 0) baseConditions.push({ category: { $in: types } });

    const locations = parseAliasedListParam(query, ['locations', 'location']);
    if (locations.length > 0) baseConditions.push({ location: { $in: locations } });

    const evidenceTypes = parseAliasedListParam(query, ['evidenceTypes', 'evidenceType']);
    if (evidenceTypes.length > 0) baseConditions.push({ 'evidence.evidenceType': { $in: evidenceTypes } });

    const months = parseAliasedListParam(query, ['months'])
        .map((m) => parseInt(m, 10))
        .filter((m) => !Number.isNaN(m));

    if (months.length > 0) {
        const currentYear = new Date().getFullYear();
        baseConditions.push({
            $expr: {
                $and: [
                    { $in: [{ $month: { $ifNull: ['$incidentDate', '$incident_date'] } }, months] },
                    { $eq: [{ $year: { $ifNull: ['$incidentDate', '$incident_date'] } }, currentYear] },
                ],
            },
        });
    }

    const fromDate = query.fromDate || query.startDate;
    const toDate = query.toDate || query.endDate;
    const dateRangeQuery = buildIncidentDateRangeQuery(fromDate, toDate);
    if (dateRangeQuery) baseConditions.push(dateRangeQuery);

    const statuses = normalizeStatuses(parseAliasedListParam(query, ['statuses', 'status']));
    if (statuses.length > 0) baseConditions.push({ status: { $in: statuses } });

    const staff = parseAliasedListParam(query, ['staff', 'staffIds', 'handler', 'handlerId', 'assignedHandler']);
    const includeUnassigned = String(query.unassigned || query.includeUnassigned || '').toLowerCase() === 'true';
    const includeAdminRole = String(query.includeAdminRole || '').toLowerCase() === 'true';

    if (staff.length > 0 || includeUnassigned || includeAdminRole) {
        try {
            const isAdminSelectedByKeyword = staff.some((e) => ADMIN_KEYWORDS.includes(e.toLowerCase()));
            const validStaffIds = staff
                .filter((e) => !ADMIN_KEYWORDS.includes(e.toLowerCase()))
                .filter((e) => mongoose.Types.ObjectId.isValid(e))
                .map((e) => new mongoose.Types.ObjectId(e));

            const selectedAdminUsers = validStaffIds.length > 0
                ? await User.find({ _id: { $in: validStaffIds }, role: { $in: ADMIN_ROLES } }).select('_id').lean()
                : [];
            const isAdminSelectedById = selectedAdminUsers.length > 0;
            const needsAdminUserIds = includeUnassigned || includeAdminRole || isAdminSelectedByKeyword || isAdminSelectedById;

            let allAdminIds = [];
            if (needsAdminUserIds) {
                const adminUsers = await User.find({ role: { $in: ADMIN_ROLES } }).select('_id').lean();
                allAdminIds = adminUsers.map((u) => u._id);
            }

            const staffConditions = [];
            if (includeUnassigned || isAdminSelectedByKeyword || isAdminSelectedById || includeAdminRole) {
                staffConditions.push({ assignedHandler: null });
                if (allAdminIds.length > 0) staffConditions.push({ assignedHandler: { $in: allAdminIds } });
            }
            if (validStaffIds.length > 0) staffConditions.push({ assignedHandler: { $in: validStaffIds } });
            if (staffConditions.length > 0) baseConditions.push({ $or: staffConditions });
        } catch {
            // Staff filter query error — skip filter silently
        }
    }

    if (baseConditions.length === 0) return {};
    if (baseConditions.length === 1) return baseConditions[0];
    return { $and: baseConditions };
};

// ─────────────────────────────────────────────────────────────────────────────
// Student detail enrichment
// ─────────────────────────────────────────────────────────────────────────────

const enrichIncidentsWithStudentDetails = async (incidents) => {
    const missingAdmissionNos = [
        ...new Set(incidents.filter((i) => !i.student && i.admissionNo).map((i) => i.admissionNo)),
    ];

    const legacyStudents = missingAdmissionNos.length
        ? await Student.find({ admissionNo: { $in: missingAdmissionNos } }).lean()
        : [];
    const studentByAdmissionNo = new Map(legacyStudents.map((s) => [s.admissionNo, s]));

    const selfHealOps = [];

    const enhanced = incidents.map((incidentObj) => {
        if (incidentObj.student) {
            incidentObj.studentDetails = {
                name: incidentObj.student.name,
                admissionNo: incidentObj.student.admissionNo,
                className: incidentObj.student.className,
                section: incidentObj.student.section,
            };
        } else if (incidentObj.admissionNo) {
            const student = studentByAdmissionNo.get(incidentObj.admissionNo);
            if (student) {
                selfHealOps.push({
                    updateOne: { filter: { _id: incidentObj._id }, update: { $set: { student: student._id } } },
                });
                incidentObj.studentDetails = {
                    name: student.name,
                    admissionNo: student.admissionNo,
                    className: student.className,
                    section: student.section,
                };
            } else {
                incidentObj.studentDetails = null;
            }
        } else {
            incidentObj.studentDetails = null;
        }
        return incidentObj;
    });

    if (selfHealOps.length > 0) {
        Incident.bulkWrite(selfHealOps, { ordered: false }).catch((err) => {
            logger.error('Incident student self-heal bulkWrite failed', { error: err.message });
        });
    }

    return enhanced;
};

// ─────────────────────────────────────────────────────────────────────────────
// Notification dispatch — uses insertAndPush for SSE delivery
// ─────────────────────────────────────────────────────────────────────────────

const dispatchIncidentCreatedNotifications = async (incidents, user) => {
    const reporterId = user.id;
    const isAdmin = isAdministrationRole(user.role);
    const admins = await User.find({ role: { $in: ADMIN_ROLES } }).select('_id').lean();

    const allNotifications = [];

    for (const incident of incidents) {
        const baseMessage = `New '${incident.category || incident.title}' incident reported for ${(incident.studentsInvolved || [])[0] || 'student'} (AdNo: ${incident.admissionNo || 'N/A'}) | Class ${incident.class || 'N/A'} – Sec ${incident.section || 'N/A'} | By ${user.name}`;
        const studentDetailsNotify = {
            studentsInvolved: incident.studentsInvolved || [],
            class: incident.class || '',
            section: incident.section || '',
            admissionNo: incident.admissionNo || null,
        };

        for (const admin of admins) {
            if (admin._id.toString() === reporterId.toString()) continue;
            allNotifications.push({
                recipient: admin._id,
                type: 'INCIDENT_CREATED',
                incident: incident._id,
                entityType: 'Incident',
                entityId: incident._id.toString(),
                actionName: 'Incident Reported',
                message: baseMessage,
                performedBy: reporterId.toString(),
                performedByName: user.name,
                performedByRole: user.role,
                targetLabel: incident.title,
                targetAdmissionNumber: incident.admissionNo || null,
                routePath: `/incidents/${incident._id}`,
                metadata: buildIncidentMetadata(incident, { reportedBy: user.name }),
                studentDetails: studentDetailsNotify,
            });
        }

        const handlerId = incident.assignedHandler?._id || incident.assignedHandler;
        if (isAdmin && handlerId && handlerId.toString() !== reporterId.toString()) {
            allNotifications.push({
                recipient: handlerId,
                type: 'INCIDENT_ASSIGNED',
                incident: incident._id,
                entityType: 'Incident',
                entityId: incident._id.toString(),
                actionName: 'Incident Assigned',
                message: `Admin ${user.name} assigned you: '${incident.category || incident.title}' for ${(incident.studentsInvolved || [])[0] || 'student'} (AdNo: ${incident.admissionNo || 'N/A'}) | Class ${incident.class || 'N/A'} – Sec ${incident.section || 'N/A'}`,
                performedBy: reporterId.toString(),
                performedByName: user.name,
                performedByRole: user.role,
                targetLabel: incident.title,
                targetAdmissionNumber: incident.admissionNo || null,
                routePath: `/incidents/${incident._id}`,
                metadata: buildIncidentMetadata(incident, { reportedBy: user.name, handlerId: handlerId.toString() }),
                studentDetails: studentDetailsNotify,
            });
        }
    }

    if (allNotifications.length) {
        await notificationService.insertAndPush(allNotifications);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────────────────────────────────────────

const createIncidents = async ({ body, files, user }) => {
    let studentIds = [];
    try { studentIds = body.studentIds ? JSON.parse(body.studentIds) : []; } catch { studentIds = []; }
    const isBulkSubmission = Array.isArray(studentIds) && studentIds.length > 0;

    let studentDetails = [];
    if (isBulkSubmission) {
        studentDetails = await Student.find({ _id: { $in: studentIds } }).lean();
    } else if (body.admissionNo) {
        const student = await Student.findOne({ admissionNo: body.admissionNo }).lean();
        if (student) studentDetails = [student];
    }

    if (studentDetails.length === 0) {
        const err = new Error('No valid students found');
        err.statusCode = 400;
        throw err;
    }

    let evidenceList = [];
    try { evidenceList = JSON.parse(body.evidenceDetails || '[]'); } catch { evidenceList = []; }
    const evidence = buildEvidenceEntriesFromUploads(files || [], evidenceList);

    const isAdmin = isAdministrationRole(user.role);
    const cls = Array.isArray(body.class) ? body.class[0] : body.class;
    const sec = Array.isArray(body.section) ? body.section[0] : body.section;

    const ALLOWED_FIELDS = ['category', 'description', 'location', 'severity', 'isHighPriority', 'highPriority', 'assignedHandler'];
    const incidentData = Object.fromEntries(
        Object.entries(body).filter(([key]) => ALLOWED_FIELDS.includes(key))
    );
    if (!incidentData.assignedHandler) delete incidentData.assignedHandler;

    const useManualTiming = body.manualTiming === 'true' || body.manualTiming === true;
    const initialStatus = body.initialStatus || 'Open';
    const manualOpenedAt = body.openedAt ? new Date(body.openedAt) : null;
    const manualInProgressAt = body.inProgressAt ? new Date(body.inProgressAt) : null;
    const manualClosedAt = body.closedAt ? new Date(body.closedAt) : null;

    const shouldGenerate = body.shouldGenerateLetter === 'true' || body.shouldGenerateLetter === true;
    const letterLanguage = body.letterLanguage || 'en';

    const createdIncidents = [];
    const failedStudents = [];
    const generatedLetters = [];
    const incidentsToInsert = [];

    for (const student of studentDetails) {
        incidentsToInsert.push({
            ...incidentData,
            title: body.category,
            incidentCategory: body.category,
            reportedBy: user.id,
            submittedAt: manualOpenedAt || Date.now(),
            incidentDate: manualOpenedAt || Date.now(),
            approvalStatus: isAdmin ? 'Approved' : 'Pending',
            approvedAt: isAdmin ? Date.now() : null,
            status: useManualTiming ? initialStatus : 'Open',
            evidence,
            admissionNo: student.admissionNo,
            student: student._id,
            class: student.className || cls,
            section: student.section || sec,
            studentsInvolved: [student.name],
            ...(useManualTiming && {
                openedAt: manualOpenedAt || Date.now(),
                ...(manualInProgressAt && { progressAt: manualInProgressAt, inProgressAt: manualInProgressAt }),
                ...(manualClosedAt && { closedAt: manualClosedAt, closureRequestedAt: manualClosedAt }),
            }),
        });
    }

    if (incidentsToInsert.length > 0) {
        const inserted = await Incident.insertMany(incidentsToInsert);
        createdIncidents.push(...inserted);

        await Log.create([{
            actionName: useManualTiming ? 'Manual Incident Created (Custom Timing Used)' : 'Manual Incident Created',
            performedBy: user.id || null,
            entityType: 'Incident',
            entityId: createdIncidents[0]._id,
            metadata: {
                title: createdIncidents[0]?.title,
                studentName: createdIncidents[0]?.studentsInvolved?.[0] || null,
                class: createdIncidents[0]?.class || null,
                section: createdIncidents[0]?.section || null,
                category: body.category,
                count: createdIncidents.length,
                reportedBy: user.name,
                isBulkSubmission,
            }
        }]);
    }

    if (shouldGenerate) {
        for (const incident of createdIncidents) {
            try {
                const letterResult = await letterQueue.push(
                    () => autoGenerateLetterFromIncident(incident, user.id, letterLanguage)
                ).promise;
                if (letterResult.success) generatedLetters.push(letterResult.letter);
            } catch {
                // Letter generation failed — non-fatal
            }
        }
    }

    try {
        await dispatchIncidentCreatedNotifications(createdIncidents, user);
    } catch {
        // Non-fatal
    }

    return { createdIncidents, failedStudents, generatedLetters, isBulkSubmission };
};

const listIncidents = async ({ user, query }) => {
    const builtQuery = await buildIncidentQuery(user, query);
    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });

    let incidentQuery = Incident.find(builtQuery)
        .populate('reportedBy', 'name role')
        .populate('assignedHandler', 'name role')
        .populate('student', 'name admissionNo className section')
        .sort({ incidentDate: -1, createdAt: -1 });

    // lean() skips Mongoose document hydration — significant memory + speed win for read-only list

    if (shouldPaginate) {
        incidentQuery = incidentQuery.skip(pagination.skip).limit(pagination.limit);
    }

    const [data, total] = await Promise.all([
        incidentQuery.lean(),
        shouldPaginate ? Incident.countDocuments(builtQuery) : Promise.resolve(null),
    ]);

    const enhanced = await enrichIncidentsWithStudentDetails(data);

    if (shouldPaginate) {
        return {
            paginated: true,
            data: enhanced,
            pagination: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
        };
    }

    return { paginated: false, data: enhanced };
};

const getDistinctClasses = async () => {
    const classes = await Incident.distinct('class');
    const filtered = classes.filter(Boolean).sort((a, b) => {
        const aNum = parseInt(a);
        const bNum = parseInt(b);
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
        return a.localeCompare(b);
    });
    return filtered.length > 0 ? filtered : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
};

const getDistinctSections = async () => {
    const sections = await Incident.distinct('section');
    const filtered = sections.filter(Boolean).sort();
    return filtered.length > 0 ? filtered : ['A', 'B', 'C', 'D', 'E'];
};

const getLocationDistribution = async ({ user, query }) => {
    const builtQuery = await buildIncidentQuery(user, query);

    const grouped = await Incident.aggregate([
        { $match: builtQuery },
        { $group: { _id: { $ifNull: ['$location', 'Unknown'] }, count: { $sum: 1 } } },
        { $project: { _id: 0, location: '$_id', count: 1 } },
        { $sort: { count: -1, location: 1 } },
    ]);

    return grouped.reduce((rows, entry) => {
        const location = String(entry.location || 'Unknown').trim() || 'Unknown';
        const existing = rows.find((r) => r.location === location);
        if (existing) { existing.count += entry.count; return rows; }
        rows.push({ location, count: entry.count });
        return rows;
    }, []);
};

const getIncidentById = async (id, user) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const err = new Error('Invalid incident ID');
        err.statusCode = 400;
        throw err;
    }

    const incident = await Incident.findById(id)
        .populate('reportedBy', 'name role')
        .populate('assignedHandler', 'name role')
        .populate('closedBy', 'name role')
        .populate('student')
        .lean();

    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    assertIncidentAccess(incident, user, 'view');

    const incidentObj = incident;

    if (incidentObj.student) {
        incidentObj.studentDetails = {
            name: incidentObj.student.name,
            admissionNo: incidentObj.student.admissionNo,
            className: incidentObj.student.className,
            section: incidentObj.student.section,
        };
    } else if (incidentObj.admissionNo) {
        const student = await Student.findOne({ admissionNo: incidentObj.admissionNo }).lean();
        if (student) {
            Incident.updateOne({ _id: incidentObj._id }, { $set: { student: student._id } }).exec().catch((err) => {
                logger.error('Incident student link update failed', {
                    incidentId: incidentObj._id,
                    error: err.message,
                });
            });
            incidentObj.studentDetails = {
                name: student.name,
                admissionNo: student.admissionNo,
                className: student.className,
                section: student.section,
            };
        } else {
            incidentObj.studentDetails = null;
        }
    } else {
        incidentObj.studentDetails = null;
    }

    return incidentObj;
};

const approveAndAssign = async (incidentId, handlerId, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    incident.approvalStatus = 'Approved';
    incident.approvedAt = Date.now();
    incident.assignedHandler = handlerId;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({
        note: 'COMMAND AUTHORIZED: CASE ASSIGNED TO HANDLER FOR INVESTIGATION.',
        updatedBy: `${user.name} (Admin)`,
        timestamp: Date.now(),
    });

    await incident.save();

    const reporterId = incident.reportedBy?._id || incident.reportedBy;

    createLog(
        'Incident Authorized & Assigned',
        user.id,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, { handlerId: handlerId || null }),
        {
            type: 'INCIDENT_ASSIGNED',
            incidentId: incident._id,
            targetLabel: incident.title,
            targetAdmissionNumber: incident.admissionNo || null,
            routePath: `/incidents/${incident._id}`,
            studentDetails: buildIncidentStudentDetails(incident),
            recipientEntries: [
                handlerId ? { recipient: handlerId, actionName: 'Incident Assigned', message: `Admin ${user.name} assigned you a new incident: "${incident.title}".` } : null,
                reporterId ? { recipient: reporterId, actionName: 'Incident Authorized', message: `Your incident "${incident.title}" has been authorized and assigned for investigation.` } : null,
            ].filter(Boolean),
        }
    );

    return { message: 'Incident Authorized & Assigned' };
};

const addProgressNote = async (incidentId, note, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'update');

    const movedToInProgress = incident.status === 'Open';
    if (movedToInProgress) {
        const t = Date.now();
        incident.status = 'In Progress';
        incident.progressAt = t;
        incident.inProgressAt = incident.inProgressAt || t;
    }

    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: note || 'Operational field update recorded.', updatedBy: user.name, timestamp: Date.now() });
    if (incident.rejectionReason) incident.rejectionReason = null;

    await incident.save();

    const progressActionName = movedToInProgress ? 'Incident Moved to In Progress' : 'Progress Log Added';
    const handlerId = incident.assignedHandler?._id || incident.assignedHandler;

    const progressNotificationConfig = isAdministrationRole(user.role)
        ? {
            recipientEntries: [
                handlerId ? {
                    recipient: handlerId,
                    actionName: progressActionName,
                    type: movedToInProgress ? 'INCIDENT_STATUS_UPDATED' : 'INCIDENT_PROGRESS',
                    message: `${user.name} added a progress update to "${incident.title}".`,
                } : null,
            ].filter(Boolean),
        }
        : { recipientRoles: ['Super Admin', 'Admin'], message: `${user.name} added a progress update to "${incident.title}".` };

    createLog(
        progressActionName,
        user.id,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, { note, status: incident.status, previousStatus: movedToInProgress ? 'Open' : incident.status }),
        { type: movedToInProgress ? 'INCIDENT_STATUS_UPDATED' : 'INCIDENT_PROGRESS', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident), ...progressNotificationConfig }
    );

    return incident;
};

const requestClosure = async (incidentId, actionTaken, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'request closure for');

    incident.closureRequested = true;
    incident.actionTaken = actionTaken;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: 'CLOSURE REQUESTED: Investigation completed and submitted for final seal.', updatedBy: user.name, timestamp: Date.now() });

    await incident.save();

    createLog('Closure Requested', user.id, 'Incident', incident._id, buildIncidentMetadata(incident, { actionTaken: actionTaken || null, status: incident.status, closureRequested: true }), {
        type: 'CLOSURE_REQUESTED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident), recipientRoles: ['Super Admin', 'Admin'], message: `${user.name} requested closure for "${incident.title}".`,
    });

    return { message: 'Closure requested' };
};

const finalizeClosure = async (incidentId, note, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    incident.status = 'Closed';
    incident.closedAt = Date.now();
    incident.closedBy = user.id;
    incident.closureRequested = false;
    incident.rejectionReason = null;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: note || 'CASE PERMANENTLY SEALED: Admin authorized final closure.', updatedBy: `${user.name} (Admin)`, timestamp: Date.now() });

    await incident.save();

    const repId = incident.reportedBy?._id || incident.reportedBy;
    const handId = incident.assignedHandler?._id || incident.assignedHandler;

    createLog('Incident Closed', user.id, 'Incident', incident._id, buildIncidentMetadata(incident, { note: note || null, status: incident.status, closedAt: incident.closedAt }), {
        type: 'INCIDENT_CLOSED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident),
        recipientEntries: [repId, handId].filter(Boolean).map((recipient) => ({ recipient, actionName: 'Incident Closed', message: `Admin ${user.name} closed "${incident.title}".` })),
    });

    return { message: 'Case permanently closed' };
};

const rejectClosure = async (incidentId, reason, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    if (!incident.closureRequested) {
        const err = new Error('No closure request to reject');
        err.statusCode = 400;
        throw err;
    }

    const rejectionReason = reason || 'Closure rejected by admin. Further investigation required.';
    incident.closureRequested = false;
    incident.rejectionReason = rejectionReason;
    incident.status = 'In Progress';
    incident.inProgressAt = incident.inProgressAt || incident.progressAt || Date.now();
    incident.progressAt = incident.progressAt || incident.inProgressAt;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: `CLOSURE REJECTED: ${rejectionReason}`, updatedBy: `${user.name} (Admin)`, timestamp: Date.now() });

    await incident.save();

    const handlerId = incident.assignedHandler?._id || incident.assignedHandler;

    createLog('Closure Rejected', user.id, 'Incident', incident._id, buildIncidentMetadata(incident, { reason: incident.rejectionReason, status: incident.status, closureRequested: incident.closureRequested }), {
        type: 'INCIDENT_STATUS_UPDATED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident),
        recipientEntries: handlerId ? [{ recipient: handlerId, actionName: 'Closure Rejected', message: `Admin ${user.name} rejected closure for "${incident.title}".` }] : [],
    });

    return { message: 'Closure rejected and case returned to handler', status: incident.status, rejectionReason: incident.rejectionReason };
};

const deleteIncident = async (incidentId, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    await deleteIncidentEvidenceFromS3(incident);

    await Incident.findByIdAndDelete(incidentId);

    createLog('Incident Deleted', user.id, 'Incident', incident._id, {
        title: incident.title, class: incident.class, students: incident.studentsInvolved,
    });

    return { message: 'Incident deleted successfully' };
};

const addEvidence = async (incidentId, files, evidenceDataRaw, user) => {
    const incident = await Incident.findById(incidentId);
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'add evidence to');

    let evidenceDataList = [];
    try { evidenceDataList = JSON.parse(evidenceDataRaw || '[]'); } catch { evidenceDataList = []; }

    const newEntries = buildEvidenceEntriesFromUploads(files || [], evidenceDataList);
    if (newEntries.length === 0) {
        const err = new Error('No valid evidence files provided.');
        err.statusCode = 400;
        throw err;
    }

    incident.evidence.push(...newEntries);
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: `ADDED NEW EVIDENCE: ${newEntries.length} items attached by ${user.name}.`, updatedBy: user.name, timestamp: Date.now() });

    await incident.save();
    return incident;
};

// ─────────────────────────────────────────────────────────────────────────────
// Bulk Excel upload
// ─────────────────────────────────────────────────────────────────────────────

const processExcelUpload = async (filePath, user, body) => {
    let workbook;
    let data = [];

    try {
        workbook = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false, cellNF: false });
        const sheetName = workbook.SheetNames[0];
        data = safeSheetToJson(XLSX, workbook.Sheets[sheetName]);
    } catch (readErr) {
        const msg = readErr.message || '';
        if (msg.includes('image.png') || msg.includes('does not support image') || msg.includes('model does not support')) {
            const err = new Error('Excel file contains embedded images or objects that cannot be processed. Please remove all images from the Excel file and try again.');
            err.statusCode = 400;
            err.hint = 'Use a plain Excel file without any embedded images, icons, or drawings.';
            throw err;
        }
        const err = new Error('Failed to read Excel file: ' + readErr.message);
        err.statusCode = 400;
        throw err;
    }

    if (data.length === 0) {
        const err = new Error('Excel file is empty');
        err.statusCode = 400;
        throw err;
    }

    const categorySet = new Set();
    const locationSet = new Set();
    const evidenceTypeSet = new Set();
    const admissionNoSet = new Set();
    const emailSet = new Set();

    for (const row of data) {
        for (const [key, val] of Object.entries(row)) {
            const keyLower = key.toLowerCase().trim();
            const value = val?.toString().trim();
            if (!value) continue;

            if (keyLower === 'category') categorySet.add(value.toLowerCase());
            else if (keyLower === 'location') locationSet.add(value.toLowerCase());
            else if (['evidencetype', 'evidencetype*', 'evidence', 'evidence_type'].some(k => keyLower.startsWith(k))) {
                value.split(',').forEach(t => evidenceTypeSet.add(t.trim().toLowerCase()));
            }
            else if (['admissionnumber'].some(k => keyLower.startsWith(k))) admissionNoSet.add(value.toLowerCase());
            else if (['handledby', 'assignedby', 'assignee'].some(k => keyLower.startsWith(k))) emailSet.add(value.toLowerCase());
        }
    }

    // Fetch only the relevant data
    const [categories, locations, evidenceTypes, students, users] = await Promise.all([
        findByNameSet(Category, categorySet),
        findByNameSet(Location, locationSet),
        findByNameSet(EvidenceType, evidenceTypeSet),
        findByFieldRegexSet(Student, 'admissionNo', admissionNoSet).then((rows) =>
            rows.map((s) => ({
                admissionNo: s.admissionNo,
                name: s.name,
                className: s.className,
                section: s.section,
            }))
        ),
        findByFieldRegexSet(User, 'email', emailSet).then((rows) =>
            rows.map((u) => ({ email: u.email, role: u.role, name: u.name }))
        ),
    ]);

    const categoryMap = new Map(categories.map((c) => [c.name.toLowerCase().trim(), c.name]));
    const locationMap = new Map(locations.map((l) => [l.name.toLowerCase().trim(), l.name]));
    const evidenceTypeMap = new Map(evidenceTypes.map((e) => [e.name.toLowerCase().trim(), e.name]));
    const studentMap = new Map();
    students.forEach((s) => {
        const key = (s.admissionNo || '').toString().trim();
        if (key) { studentMap.set(key, s); studentMap.set(key.toLowerCase(), s); }
    });
    const userMap = new Map();
    users.forEach((u) => {
        const email = (u.email || '').toLowerCase().trim();
        if (email) userMap.set(email, u);
    });

    const incidents = [];
    const errors = [];
    const validationResults = { totalRows: data.length, successRows: 0, failedRows: 0, errors: [] };

    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNum = i + 2;

        const getCellValue = (fieldName, ...alternatives) => {
            const searchNames = [fieldName, ...alternatives].map((n) => n.toLowerCase().trim());
            for (const key of Object.keys(row)) {
                const keyLower = key.toLowerCase().trim();
                for (const searchName of searchNames) {
                    if (keyLower === searchName || keyLower.startsWith(searchName)) {
                        const value = row[key];
                        if (typeof value === 'boolean') return value ? 'yes' : 'no';
                        return value?.toString().trim() || '';
                    }
                }
            }
            return '';
        };

        const addFieldError = (fieldName, message) => {
            const errorMsg = `Row ${rowNum} → ${fieldName}: ${message}`;
            errors.push(errorMsg);
            validationResults.errors.push({ row: rowNum, reason: errorMsg, column: fieldName });
            validationResults.failedRows++;
        };

        const rowValues = Object.values(row).filter((v) => v && v.toString().trim() !== '');
        if (rowValues.length === 0) { addFieldError('All', 'Empty row - no data found'); continue; }

        const admissionNumber = getCellValue('admissionNumber').toString().trim();
        if (!admissionNumber) { addFieldError('admissionNumber', 'missing or empty'); continue; }

        const student = studentMap.get(admissionNumber) || studentMap.get(admissionNumber.toLowerCase());
        if (!student) { addFieldError('admissionNumber', `student "${admissionNumber}" not found`); continue; }

        const categoryInput = getCellValue('category');
        if (!categoryInput) { addFieldError('category', 'missing or empty'); continue; }
        const validCategory = categoryMap.get(categoryInput.toLowerCase());
        if (!validCategory) { addFieldError('category', `invalid "${categoryInput}"`); continue; }

        const locationInput = getCellValue('location');
        if (!locationInput) { addFieldError('location', 'missing or empty'); continue; }
        const validLocation = locationMap.get(locationInput.toLowerCase());
        if (!validLocation) { addFieldError('location', `invalid "${locationInput}"`); continue; }

        const description = getCellValue('description');
        if (!description) { addFieldError('description', 'missing or empty'); continue; }

        const evidenceTypeInput = getCellValue('evidenceType', 'evidenceType*', 'evidence', 'evidence_type');
        if (!evidenceTypeInput) { addFieldError('evidenceType', 'missing or empty'); continue; }
        const evidenceTypeNames = evidenceTypeInput.split(',').map((t) => t.trim());
        const validEvidenceTypes = [];
        let hasInvalidEvidence = false;
        for (const typeName of evidenceTypeNames) {
            const validType = evidenceTypeMap.get(typeName.toLowerCase());
            if (!validType) { addFieldError('evidenceType', `invalid "${typeName}"`); hasInvalidEvidence = true; break; }
            validEvidenceTypes.push(validType);
        }
        if (hasInvalidEvidence) continue;

        let assignedHandler = null;
        const handledByInput = getCellValue('handledBy', 'handledBy (Staff Email)', 'assignedby', 'assignee');
        if (handledByInput) {
            const handler = userMap.get(handledByInput.toLowerCase().trim());
            if (!handler) { addFieldError('handledBy', `Staff "${handledByInput}" not found`); continue; }
            assignedHandler = handler._id;
        }

        const highPriorityInput = getCellValue('highPriority', 'highPriority (Yes/No)', 'highpriority');
        const priorityLower = highPriorityInput.toLowerCase();
        const isHighPriority = priorityLower === 'yes' || priorityLower === 'y' || priorityLower === 'true';

        const dayInput = getCellValue('day');
        const monthInput = getCellValue('month');
        const yearInput = getCellValue('year');
        const hourInput = getCellValue('hour');
        const minuteInput = getCellValue('minute');
        const timePeriodInput = (getCellValue('timePeriod', 'timePeriod (AM/PM)', 'timeperiod') || 'AM').toUpperCase().trim();

        if (!dayInput || !monthInput || !yearInput) { addFieldError('date', `missing: day="${dayInput}", month="${monthInput}", year="${yearInput}"`); continue; }

        let finalTimePeriod = 'AM';
        if (timePeriodInput) {
            if (timePeriodInput.startsWith('A')) finalTimePeriod = 'AM';
            else if (timePeriodInput.startsWith('P')) finalTimePeriod = 'PM';
            else { addFieldError('timePeriod', `invalid "${timePeriodInput}". Use AM or PM`); continue; }
        }

        const day = parseInt(dayInput);
        const month = parseInt(monthInput);
        const year = parseInt(yearInput);
        let hour = parseInt(hourInput) || 0;
        const minute = parseInt(minuteInput) || 0;

        if (isNaN(day) || day < 1 || day > 31) { addFieldError('day', `invalid (${dayInput})`); continue; }
        if (isNaN(month) || month < 1 || month > 12) { addFieldError('month', `invalid (${monthInput})`); continue; }
        if (isNaN(year) || year < 2000 || year > 2100) { addFieldError('year', `invalid (${yearInput})`); continue; }

        if (finalTimePeriod === 'PM' && hour >= 1 && hour <= 12) hour = hour === 12 ? 12 : hour + 12;
        else if (finalTimePeriod === 'AM' && hour === 12) hour = 0;

        const incidentRegisterDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
        if (isNaN(incidentRegisterDate.getTime())) { addFieldError('date/time', 'invalid date/time combination'); continue; }

        incidents.push({
            title: validCategory,
            category: validCategory,
            location: validLocation,
            description,
            reportedBy: user.id,
            submittedAt: incidentRegisterDate,
            createdAt: incidentRegisterDate,
            incidentDate: incidentRegisterDate,
            approvedAt: new Date(),
            approvalStatus: 'Approved',
            status: 'Open',
            isHighPriority,
            assignedHandler,
            evidence: validEvidenceTypes.map((type) => ({ evidenceType: type, fileUrl: null })),
            studentsInvolved: [student.name],
            class: student.className,
            section: student.section,
            admissionNo: student.admissionNo,
        });

        validationResults.successRows++;
    }

    if (incidents.length === 0) {
        const err = new Error('Excel validation failed - No valid incidents to upload');
        err.statusCode = 400;
        err.errors = errors;
        err.validationResults = validationResults;
        throw err;
    }

    let createdIncidents = [];
    try {
        createdIncidents = await Incident.insertMany(incidents, { ordered: false, lean: true });
    } catch (err) {
        if (err.name === 'BulkWriteError' || err.writeErrors) {
            const insertedCount = typeof err.insertedCount === 'number'
                ? err.insertedCount
                : incidents.length - (err.writeErrors?.length || 0);
            createdIncidents = incidents.slice(0, insertedCount);
            err.writeErrors.forEach(we => {
                const errorMsg = `Database error inserting row: ${we.errmsg}`;
                errors.push(errorMsg);
                validationResults.errors.push({ row: 'DB', reason: errorMsg, column: 'System' });
                validationResults.failedRows++;
                validationResults.successRows--;
            });
        } else {
            throw err;
        }
    }

    const shouldGenerate = body.shouldGenerateLetter === 'true' || body.shouldGenerateLetter === true;
    const letterLanguage = body.letterLanguage || 'en';
    const lettersGenerated = [];
    const lettersFailed = [];

    // Optimize letter generation using Promise.all instead of a serial for-loop
    if (shouldGenerate && createdIncidents.length > 0) {
        let processedLettersCount = 0;
        let nextThreshold = 25;
        const sseManager = require('../utils/sseManager');
        
        const letterPromises = createdIncidents.map(async (incident) => {
            try {
                const result = await letterQueue.push(
                    // skipLog = true to prevent N+1 DB writes and SSE broadcast floods
                    () => autoGenerateLetterFromIncident(incident, user.id, letterLanguage, true)
                ).promise;
                if (result.success) {
                    lettersGenerated.push({ incidentId: incident._id, letterId: result.letter._id, letterNumber: result.letter.letterNumber, studentName: incident.studentsInvolved?.[0] || 'Unknown' });
                } else {
                    lettersFailed.push({ incidentId: incident._id, studentName: incident.studentsInvolved?.[0] || 'Unknown', reason: result.message });
                }
            } catch (err) {
                lettersFailed.push({ incidentId: incident._id, studentName: incident.studentsInvolved?.[0] || 'Unknown', reason: err.message });
            } finally {
                processedLettersCount++;
                const percentage = (processedLettersCount / createdIncidents.length) * 100;
                
                // Throttle SSE updates to exactly 25%, 50%, 75%, and 100%
                if (percentage >= nextThreshold || processedLettersCount === createdIncidents.length) {
                    if (percentage >= nextThreshold) nextThreshold += 25;
                    sseManager.sendToUser(user.id, 'upload_progress', { 
                        message: `Generated ${processedLettersCount} of ${createdIncidents.length} letters...` 
                    });
                }
            }
        });
        await Promise.all(letterPromises);
    }

    createLog('Bulk Upload Processed', user.id, 'Bulk Upload', null, { count: createdIncidents.length, lettersGenerated: lettersGenerated.length });

    // Notify admins via SSE
    try {
        const admins = await User.find({ role: { $in: ADMIN_ROLES } }).select('_id').lean();
        const notifications = admins
            .filter((a) => a._id.toString() !== user.id.toString())
            .map((a) => ({
                recipient: a._id,
                type: 'INCIDENT_CREATED',
                entityType: 'Bulk Upload',
                entityId: null,
                actionName: 'Bulk Upload Processed',
                message: `Admin ${user.name} bulk uploaded ${createdIncidents.length} incidents from Excel file`,
                performedBy: user.id.toString(),
                performedByName: user.name,
                performedByRole: user.role,
                targetLabel: `${createdIncidents.length} incidents`,
                routePath: '/upload-incidents',
                metadata: { count: createdIncidents.length, lettersGenerated: lettersGenerated.length, routePath: '/upload-incidents' },
            }));
        if (notifications.length) await notificationService.insertAndPush(notifications);
    } catch {
        // Non-fatal
    }

    return { createdIncidents, lettersGenerated, lettersFailed, errors, validationResults };
};

const buildDownloadTemplate = async (format = 'xlsx') => {
    const [categories, locations, evidenceTypes, students, users] = await Promise.all([
        Category.find().select('name').sort({ name: 1 }).lean(),
        Location.find().select('name').sort({ name: 1 }).lean(),
        EvidenceType.find().select('name').sort({ name: 1 }).lean(),
        Student.find().select('admissionNo name className section').limit(5).lean(),
        User.find({
            role: {
                $in: [
                    'Super Admin',
                    'Admin',
                    'super_admin',
                    'admin',
                ],
            },
        }).select('email role name').lean(),
    ]);

    const templateData = [
        ['admissionNumber*', 'category*', 'location*', 'description*', 'evidenceType*', 'handledBy', 'day*', 'month*', 'year*', 'hour*', 'minute*', 'timePeriod (AM/PM)', 'highPriority (Yes/No)'],
        [students[0]?.admissionNo || '21295', categories[0]?.name || 'Argument', locations[0]?.name || 'Class', 'Student was involved in an argument during class time', evidenceTypes[0]?.name || 'Parent Letter', users.find((u) => isAdministrationRole(u.role))?.email || 'teacher@school.edu', '9', '3', '2026', '10', '30', 'AM', 'No'],
        [students[1]?.admissionNo || '21296', categories[1]?.name || 'Bullying', locations[1]?.name || 'Playground', 'Student was found bullying another student during recess', evidenceTypes[1]?.name || 'Warning Letter', users.find((u) => isAdministrationRole(u.role))?.email || 'teacher@school.edu', '10', '3', '2026', '2', '45', 'PM', 'Yes'],
        ['', '', '', '', '', '', '', '', '', '', '', '', ''],
    ];

    if (format === 'csv') {
        const csvContent = templateData.map((row) =>
            row.map((field) => {
                const s = String(field || '');
                return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',')
        ).join('\n');
        const content = '\ufeff' + csvContent;
        const upload = await s3StorageService.uploadBuffer({
            buffer: Buffer.from(content, 'utf8'),
            key: 'exports/templates/incident_upload_template.csv',
            filename: 'incident_upload_template.csv',
            contentType: 'text/csv; charset=utf-8',
        });
        return { format: 'csv', content, url: upload.url, key: upload.key };
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(templateData);
    ws['!cols'] = [15, 20, 15, 40, 20, 25, 8, 8, 8, 8, 8, 12, 15].map((wch) => ({ wch }));

    const refSheets = [
        { name: 'Categories', data: [['Category (Must match exactly)'], ...categories.map((c) => [c.name])] },
        { name: 'Locations', data: [['Location (Must match exactly)'], ...locations.map((l) => [l.name])] },
        { name: 'Evidence Types', data: [['Evidence Type (Must match exactly)'], ...evidenceTypes.map((e) => [e.name])] },
        { name: 'Staff (Handled By)', data: [['Email (Handled By)', 'Role', 'Name'], ...users.map((u) => [u.email, u.role, u.name])] },
        { name: 'Students', data: [['Admission Number', 'Name', 'Class', 'Section'], ...students.map((s) => [s.admissionNo, s.name, s.className, s.section])] },
    ];

    refSheets.forEach((sheet) => {
        const refWs = XLSX.utils.aoa_to_sheet(sheet.data);
        refWs['!cols'] = [{ wch: 30 }];
        XLSX.utils.book_append_sheet(wb, refWs, sheet.name);
    });

    XLSX.utils.book_append_sheet(wb, ws, 'Incident Upload Template');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const upload = await s3StorageService.uploadBuffer({
        buffer,
        key: 'exports/templates/incident_upload_template.xlsx',
        filename: 'incident_upload_template.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    return { format: 'xlsx', buffer, url: upload.url, key: upload.key };
};

// ─────────────────────────────────────────────────────────────────────────────
// Export Incident Case Report (DOCX)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    createIncidents,
    listIncidents,
    getDistinctClasses,
    getDistinctSections,
    getLocationDistribution,
    getIncidentById,
    approveAndAssign,
    addProgressNote,
    requestClosure,
    finalizeClosure,
    rejectClosure,
    deleteIncident,
    addEvidence,
    processExcelUpload,
    buildDownloadTemplate,
    buildCaseReportDocx,
    buildIncidentMetadata,
    buildIncidentStudentDetails,
};
