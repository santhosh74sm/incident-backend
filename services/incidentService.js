/**
 * incidentService.js
 * All business logic for incident creation, querying, status transitions, and bulk operations.
 * Controllers must only call these functions — they must not implement logic themselves.
 */

'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');

const Incident = require('../models/Incident');
const IncidentReadState = require('../models/IncidentReadState');
const Student = require('../models/Student');
const User = require('../models/User');
const Category = require('../models/Category');
const Location = require('../models/Location');
const EvidenceType = require('../models/EvidenceType');
const IssuedLetter = require('../models/IssuedLetter');
const Log = require('../models/Log');
const Notification = require('../models/Notification');

const { createLog } = require('../utils/logger');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { safeSheetToJson } = require('../utils/spreadsheetSecurity');
const { autoGenerateLetterFromIncident, deleteIssuedLetter } = require('./issuedLetterService');
const notificationService = require('./notificationService');
const { letterQueue, bulkQueue } = require('../utils/asyncQueue');
const logger = require('../utils/pinoLogger');
const {
    deleteIncidentFilesFromS3OrThrow,
    deleteS3ObjectOrThrow,
    extractS3KeyFromProtectedUrl,
} = require('./s3CleanupService');
const { buildCaseReportDocx } = require('./reports/caseReportService');
const { tenantFilter } = require('../utils/tenant');
const { getCurrentAcademicYear, getAcademicYearQuery, validateAcademicYear } = require('./academicYearService');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ADMIN_ROLES = ['Super Admin', 'Admin', 'super_admin', 'admin'];
const OPERATIONAL_ROLES = ['Teacher', 'teacher'];
const ALL_ASSIGNABLE_ROLES = [...ADMIN_ROLES, ...OPERATIONAL_ROLES];
const ADMIN_KEYWORDS = ['admin', 'super_admin', 'super admin', 'administration'];
const MAX_PROGRESS_LOGS = 500;
const UNKNOWN_FILTER_LABEL = 'Unknown';
const isAdministrationRole = (role) => ADMIN_ROLES.includes(role);

const toIdString = (value) => {
    if (!value) return '';
    if (value._id) return String(value._id);
    return String(value);
};

const formatUserLogLabel = (user) => {
    if (!user) return 'System';
    return user.name || 'System';
};

const getUserId = (user) => toIdString(user?.id || user?._id);

const isAssignableStaffActive = (staff) => {
    if (!staff) return false;
    if (staff.deletedAt) return false;
    if (staff.isActive === false) return false;
    const status = String(staff.status || 'active').trim().toLowerCase();
    return !['inactive', 'disabled', 'deleted', 'suspended', 'archived'].includes(status);
};

const attachReadState = async (incidents, user) => {
    const items = Array.isArray(incidents) ? incidents : [];
    const userId = getUserId(user);
    if (!items.length || !userId || !user?.schoolId) {
        return items.map((incident) => ({ ...incident, readByCurrentUser: false, readAt: null }));
    }

    const incidentIds = items.map((incident) => incident?._id).filter(Boolean);
    const readStates = await IncidentReadState.find({
        schoolId: user.schoolId,
        user: userId,
        incident: { $in: incidentIds },
    }).select('incident readAt').lean();

    const readMap = new Map(readStates.map((state) => [String(state.incident), state.readAt]));

    return items.map((incident) => {
        const readAt = readMap.get(String(incident._id)) || null;
        return {
            ...incident,
            readByCurrentUser: Boolean(readAt),
            readAt,
        };
    });
};

const canAccessIncident = (incident, user) => {
    if (!incident || !user) return false;
    if (String(incident.schoolId || '').toUpperCase() !== String(user.schoolId || '').toUpperCase()) return false;
    if (isAdministrationRole(user.role)) return true;

    const userId = toIdString(user.id || user._id);

    if (OPERATIONAL_ROLES.includes(user.role)) {
        return true;
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

const findByNameSet = (Model, values, schoolId) => {
    const regex = buildAlternationRegex(values);
    if (!regex) return Promise.resolve([]);
    return Model.find({ schoolId, name: { $regex: regex } }).select('name').lean();
};

const findByFieldRegexSet = (Model, field, values, schoolId) => {
    const patterns = Array.from(values).map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i'));
    if (patterns.length === 0) return Promise.resolve([]);
    return Model.find({ schoolId, [field]: { $in: patterns } }).lean();
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

const buildEvidenceEntriesFromUploads = (files = [], evidenceDataList = []) =>
    files
        .map((file, index) => {
            const meta = evidenceDataList[index] || {};
            const fileUrl = getPublicUploadPath(file);
            if (!fileUrl) return null;
            return {
                evidenceType: String(meta.evidenceType || '').trim() || UNKNOWN_FILTER_LABEL,
                fileUrl,
                originalName: file.originalname || file.filename || '',
                mimeType: file.mimetype || '',
                fileSize: file.size || 0,
            };
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

const getStudentSnapshotForAcademicYear = (student, academicYear) => {
    const historyEntry = (student?.history || []).find((entry) => entry?.academicYear === academicYear);
    if (historyEntry) {
        return {
            admissionNo: historyEntry.admissionNo ?? student?.admissionNo ?? '',
            name: historyEntry.name ?? student?.name ?? '',
            className: historyEntry.className ?? '',
            section: historyEntry.section ?? '',
            academicYear,
        };
    }
    if (student?.academicYear && student.academicYear !== academicYear) {
        return {
            admissionNo: student?.admissionNo || '',
            name: student?.name || '',
            className: '',
            section: '',
            academicYear,
        };
    }
    return {
        admissionNo: student?.admissionNo || '',
        name: student?.name || '',
        className: student?.className || '',
        section: student?.section || '',
        academicYear,
    };
};

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

const splitKnownAndUnknownValues = (values = []) => {
    const knownValues = [];
    let includesUnknown = false;

    values.forEach((value) => {
        const normalized = String(value || '').trim();
        if (!normalized) return;
        if (normalized.toLowerCase() === UNKNOWN_FILTER_LABEL.toLowerCase()) {
            includesUnknown = true;
            return;
        }
        knownValues.push(normalized);
    });

    return { knownValues: [...new Set(knownValues)], includesUnknown };
};

const buildNullableStringFilter = (field, values = []) => {
    const { knownValues, includesUnknown } = splitKnownAndUnknownValues(values);
    const conditions = [];

    if (knownValues.length > 0) {
        conditions.push({ [field]: { $in: knownValues } });
    }

    if (includesUnknown) {
        conditions.push({
            $or: [
                { [field]: { $exists: false } },
                { [field]: null },
                { [field]: { $regex: /^\s*$/ } },
            ],
        });
    }

    if (conditions.length === 0) return null;
    return conditions.length === 1 ? conditions[0] : { $or: conditions };
};

const buildEvidenceTypeFilter = (values = []) => {
    const { knownValues, includesUnknown } = splitKnownAndUnknownValues(values);
    const conditions = [];

    if (knownValues.length > 0) {
        conditions.push({ 'evidence.evidenceType': { $in: knownValues } });
    }

    if (includesUnknown) {
        conditions.push({
            $or: [
                { evidence: { $exists: false } },
                { evidence: { $size: 0 } },
                { 'evidence.evidenceType': { $exists: false } },
                { 'evidence.evidenceType': null },
                { 'evidence.evidenceType': { $regex: /^\s*$/ } },
            ],
        });
    }

    if (conditions.length === 0) return null;
    return conditions.length === 1 ? conditions[0] : { $or: conditions };
};

const STATUS_LOOKUP = {
    open: 'Pending',
    'in progress': 'Pending',
    'in-progress': 'Pending',
    inprogress: 'Pending',
    pending: 'Pending',
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
    const baseConditions = [{ schoolId: user.schoolId }];
    const academicYear = getAcademicYearQuery(query?.academicYear);
    if (academicYear) baseConditions.push({ academicYear });

    const search = String(query?.search || query?.query || '').trim();
    if (search) {
        const safeSearch = escapeRegex(search);
        const searchRegex = { $regex: safeSearch, $options: 'i' };
        baseConditions.push({
            $or: [
                { title: searchRegex },
                { admissionNo: searchRegex },
                { studentsInvolved: searchRegex },
            ],
        });
    }

    if (String(query?.highPriority || '').toLowerCase() === 'true') {
        baseConditions.push({ isHighPriority: true });
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
    const locationFilter = buildNullableStringFilter('location', locations);
    if (locationFilter) baseConditions.push(locationFilter);

    const evidenceTypes = parseAliasedListParam(query, ['evidenceTypes', 'evidenceType']);
    const evidenceTypeFilter = buildEvidenceTypeFilter(evidenceTypes);
    if (evidenceTypeFilter) baseConditions.push(evidenceTypeFilter);

    const months = parseAliasedListParam(query, ['months'])
        .map((m) => parseInt(m, 10))
        .filter((m) => !Number.isNaN(m));

    if (months.length > 0) {
        baseConditions.push({
            $expr: {
                $in: [{ $month: { $ifNull: ['$incidentDate', '$incident_date'] } }, months],
            },
        });
    }

    const fromDate = query.fromDate || query.startDate;
    const toDate = query.toDate || query.endDate;
    const dateRangeQuery = buildIncidentDateRangeQuery(fromDate, toDate);
    if (dateRangeQuery) baseConditions.push(dateRangeQuery);

    const statuses = normalizeStatuses(parseAliasedListParam(query, ['statuses', 'status']));
    if (statuses.length > 0) baseConditions.push({ status: { $in: statuses } });

    const readStatus = String(query?.readStatus || '').trim().toLowerCase();
    if (readStatus === 'read' || readStatus === 'unread') {
        const readIncidentIds = await IncidentReadState.distinct('incident', {
            schoolId: user.schoolId,
            user: getUserId(user),
        });
        baseConditions.push({
            _id: readStatus === 'read' ? { $in: readIncidentIds } : { $nin: readIncidentIds },
        });
    }

    const staff = parseAliasedListParam(query, ['staff', 'staffIds', 'handler', 'handlerId', 'assignedHandler']);
    const includeUnassigned = String(query.unassigned || query.includeUnassigned || '').toLowerCase() === 'true';
    const includeAdminRole = String(query.includeAdminRole || '').toLowerCase() === 'true';

    if (staff.length > 0 || includeUnassigned || includeAdminRole) {
        try {
            const staffConditions = [];
            if (includeUnassigned) {
                staffConditions.push({ assignedHandler: null });
            }
            const validStaffIds = staff
                .filter((e) => mongoose.Types.ObjectId.isValid(e))
                .map((e) => new mongoose.Types.ObjectId(e));

            if (validStaffIds.length > 0) {
                staffConditions.push({ assignedHandler: { $in: validStaffIds } });
            }
            if (includeAdminRole) {
                const adminUsers = await User.find({ schoolId: user.schoolId, role: { $in: ADMIN_ROLES } }).select('_id').lean();
                const allAdminIds = adminUsers.map((u) => u._id);
                if (allAdminIds.length > 0) {
                    staffConditions.push({ assignedHandler: { $in: allAdminIds } });
                }
            }
            if (staffConditions.length > 0) {
                baseConditions.push({ $or: staffConditions });
            }
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
        ? await Student.find({ schoolId: incidents[0]?.schoolId, admissionNo: { $in: missingAdmissionNos } }).lean()
        : [];
    const studentByAdmissionNo = new Map(legacyStudents.map((s) => [s.admissionNo, s]));

    const selfHealOps = [];

    const enhanced = incidents.map((incidentObj) => {
        if (incidentObj.student) {
            const snapshot = getStudentSnapshotForAcademicYear(incidentObj.student, incidentObj.academicYear);
            incidentObj.studentDetails = {
                name: snapshot.name,
                admissionNo: snapshot.admissionNo,
                className: snapshot.className,
                section: snapshot.section,
            };
        } else if (incidentObj.admissionNo) {
            const student = studentByAdmissionNo.get(incidentObj.admissionNo);
            if (student) {
                selfHealOps.push({
                    updateOne: { filter: { _id: incidentObj._id, schoolId: incidentObj.schoolId }, update: { $set: { student: student._id } } },
                });
                const snapshot = getStudentSnapshotForAcademicYear(student, incidentObj.academicYear);
                incidentObj.studentDetails = {
                    name: snapshot.name,
                    admissionNo: snapshot.admissionNo,
                    className: snapshot.className,
                    section: snapshot.section,
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
    const admins = await User.find({ schoolId: user.schoolId, role: { $in: ADMIN_ROLES } }).select('_id').lean();

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
                schoolId: user.schoolId,
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
                schoolId: user.schoolId,
                recipient: handlerId,
                type: 'INCIDENT_ASSIGNED',
                incident: incident._id,
                entityType: 'Incident',
                entityId: incident._id.toString(),
                actionName: 'Incident Assigned',
                message: `${user.name} assigned you: '${incident.category || incident.title}' for ${(incident.studentsInvolved || [])[0] || 'student'} (AdNo: ${incident.admissionNo || 'N/A'}) | Class ${incident.class || 'N/A'} – Sec ${incident.section || 'N/A'}`,
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
    const isTeacherCreator = OPERATIONAL_ROLES.includes(user.role);
    const academicYear = body.academicYear
        ? validateAcademicYear(body.academicYear)
        : await getCurrentAcademicYear(user);

    if (body.studentIds !== undefined && String(body.studentIds || '').trim() !== '') {
        const err = new Error('Manual incident creation accepts exactly one student.');
        err.statusCode = 400;
        throw err;
    }

    if (Array.isArray(body.studentsInvolved)) {
        const err = new Error('Manual incident creation accepts exactly one student.');
        err.statusCode = 400;
        throw err;
    }

    if (typeof body.studentsInvolved === 'string') {
        try {
            if (Array.isArray(JSON.parse(body.studentsInvolved))) {
                const err = new Error('Manual incident creation accepts exactly one student.');
                err.statusCode = 400;
                throw err;
            }
        } catch (error) {
            if (error.statusCode) throw error;
        }
    }

    const studentQuery = body.studentId
        ? { schoolId: user.schoolId, _id: body.studentId }
        : body.admissionNo
            ? { schoolId: user.schoolId, admissionNo: body.admissionNo }
            : null;

    if (!studentQuery) {
        const err = new Error('Please select a student.');
        err.statusCode = 400;
        throw err;
    }

    const student = await Student.findOne(studentQuery).lean();
    if (!student) {
        const err = new Error('Selected student was not found.');
        err.statusCode = 400;
        throw err;
    }

    let evidenceList = [];
    try { evidenceList = JSON.parse(body.evidenceDetails || '[]'); } catch { evidenceList = []; }
    const evidence = buildEvidenceEntriesFromUploads(files || [], evidenceList);

    const cls = Array.isArray(body.class) ? body.class[0] : body.class;
    const sec = Array.isArray(body.section) ? body.section[0] : body.section;
    const ALLOWED_FIELDS = ['category', 'description', 'location', 'severity', 'isHighPriority', 'highPriority', 'assignedHandler', 'actionTaken'];
    const incidentData = Object.fromEntries(
        Object.entries(body).filter(([key]) => ALLOWED_FIELDS.includes(key))
    );
    if (!incidentData.assignedHandler) {
        incidentData.assignedHandler = user.id;
    }

    const useManualTiming = body.manualTiming === 'true' || body.manualTiming === true;
    const finalStatus = body.status || body.initialStatus || 'Pending';
    const isClosed = finalStatus === 'Closed';
    const manualOpenedAt = body.openedAt ? new Date(body.openedAt) : null;
    const manualInProgressAt = body.inProgressAt ? new Date(body.inProgressAt) : null;
    const manualClosedAt = body.closedAt ? new Date(body.closedAt) : null;

    const shouldGenerate = body.shouldGenerateLetter === 'true' || body.shouldGenerateLetter === true;
    const letterLanguage = body.letterLanguage || 'en';

    const createdIncidents = [];
    const generatedLetters = [];

    const studentSnapshot = getStudentSnapshotForAcademicYear(student, academicYear);
    const incident = await Incident.create({
        schoolId: user.schoolId,
        academicYear,
        ...incidentData,
        title: body.category,
        incidentCategory: body.category,
        reportedBy: user.id,
        submittedAt: manualOpenedAt || Date.now(),
        incidentDate: manualOpenedAt || Date.now(),
        status: finalStatus,
        evidence,
        admissionNo: studentSnapshot.admissionNo,
        student: student._id,
        class: studentSnapshot.className || cls,
        section: studentSnapshot.section || sec,
        studentsInvolved: [studentSnapshot.name],
        studentSnapshot: {
            name: studentSnapshot.name,
            admissionNo: studentSnapshot.admissionNo,
            className: studentSnapshot.className || cls || '',
            section: studentSnapshot.section || sec || '',
            academicYear,
        },
        ...(isClosed && {
            closedAt: manualClosedAt || Date.now(),
            closedBy: user.id,
        }),
        ...(useManualTiming && {
            openedAt: manualOpenedAt || Date.now(),
            ...(manualInProgressAt && { progressAt: manualInProgressAt, inProgressAt: manualInProgressAt }),
            ...(!isClosed && manualClosedAt && { closedAt: manualClosedAt, closureRequestedAt: manualClosedAt }),
        }),
    });

    if (body.actionTaken) {
        trimProgressLogsBeforePush(incident);
        if (isClosed) {
            incident.progressLogs.push({
                note: `CASE CLOSED: ${String(body.actionTaken).trim()}`,
                updatedBy: formatUserLogLabel(user),
                timestamp: incident.closedAt || Date.now(),
            });
        } else {
            incident.progressLogs.push({
                note: `Field Operations note added: ${String(body.actionTaken).trim()}`,
                updatedBy: formatUserLogLabel(user),
                timestamp: Date.now(),
            });
        }
        await incident.save();
    } else if (isClosed) {
        trimProgressLogsBeforePush(incident);
        incident.progressLogs.push({
            note: 'CASE CLOSED: Case resolved and finalized upon creation.',
            updatedBy: formatUserLogLabel(user),
            timestamp: incident.closedAt || Date.now(),
        });
        await incident.save();
    }
    createdIncidents.push(incident);

    createLog(
        useManualTiming ? 'Manual Incident Created (Custom Timing Used)' : 'Manual Incident Created',
        user,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, {
            category: body.category,
            reportedBy: user.name,
            assignedTo: isTeacherCreator ? user.name : undefined,
            assignedHandler: incident.assignedHandler || null,
            academicYear,
        })
    );

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

    return { createdIncidents, generatedLetters };
};

const listIncidents = async ({ user, query, maxLimit = 100 }) => {
    const builtQuery = await buildIncidentQuery(user, query);
    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const pagination = getPagination(query, { defaultLimit: 20, maxLimit });

    let incidentQuery = Incident.find(builtQuery)
        .populate('reportedBy', 'name role')
        .populate('assignedHandler', 'name role')
        .populate('closedBy', 'name role')
        .populate('student', 'name admissionNo className section academicYear status history')
        .sort({ status: -1, incidentDate: -1, createdAt: -1 });

    // lean() skips Mongoose document hydration — significant memory + speed win for read-only list

    if (shouldPaginate) {
        incidentQuery = incidentQuery.skip(pagination.skip).limit(pagination.limit);
    }

    const [data, total] = await Promise.all([
        incidentQuery.lean(),
        shouldPaginate ? Incident.countDocuments(builtQuery) : Promise.resolve(null),
    ]);

    const enhanced = await attachReadState(await enrichIncidentsWithStudentDetails(data), user);

    if (shouldPaginate) {
        return {
            paginated: true,
            data: enhanced,
            pagination: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
        };
    }

    return { paginated: false, data: enhanced };
};

const getIncidentSummary = async ({ user, query = {} }) => {
    const builtQuery = await buildIncidentQuery(user, query);
    const adminIds = await User.find({ schoolId: user.schoolId, role: { $in: ADMIN_ROLES } })
        .distinct('_id');
    const [grouped, readIncidentIds] = await Promise.all([
        Incident.aggregate([
        { $match: builtQuery },
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
                closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } },
                highPriority: { $sum: { $cond: [{ $eq: ['$isHighPriority', true] }, 1, 0] } },
                unassigned: {
                    $sum: {
                        $cond: [
                            { $eq: [{ $ifNull: ['$assignedHandler', null] }, null] },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
        ]).then((rows) => rows[0]),
        IncidentReadState.distinct('incident', { schoolId: user.schoolId, user: getUserId(user) }),
    ]);

    const summary = grouped || { total: 0, pending: 0, closed: 0, highPriority: 0, unassigned: 0 };
    const unread = await Incident.countDocuments({ $and: [builtQuery, { _id: { $nin: readIncidentIds } }] });
    return { ...summary, pending: summary.pending, open: summary.pending, inProgress: 0, active: summary.pending, unread };
};

const getDistinctClasses = async (user) => {
    const classes = await Incident.distinct('class', tenantFilter(user));
    const filtered = classes.filter(Boolean).sort((a, b) => {
        const aNum = parseInt(a);
        const bNum = parseInt(b);
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
        return a.localeCompare(b);
    });
    return filtered.length > 0 ? filtered : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
};

const getDistinctSections = async (user) => {
    const sections = await Incident.distinct('section', tenantFilter(user));
    const filtered = sections.filter(Boolean).sort();
    return filtered.length > 0 ? filtered : ['A', 'B', 'C', 'D', 'E'];
};

const getLocationDistribution = async ({ user, query }) => {
    const builtQuery = await buildIncidentQuery(user, query);

    const grouped = await Incident.aggregate([
        { $match: builtQuery },
        {
            $group: {
                _id: {
                    $cond: [
                        { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$location', ''] } } } }, 0] },
                        { $trim: { input: { $ifNull: ['$location', ''] } } },
                        UNKNOWN_FILTER_LABEL,
                    ],
                },
                count: { $sum: 1 },
            },
        },
        { $project: { _id: 0, location: '$_id', count: 1 } },
        { $sort: { count: -1, location: 1 } },
    ]);

    return grouped.reduce((rows, entry) => {
        const location = String(entry.location || UNKNOWN_FILTER_LABEL).trim() || UNKNOWN_FILTER_LABEL;
        const existing = rows.find((r) => r.location === location);
        if (existing) { existing.count += entry.count; return rows; }
        rows.push({ location, count: entry.count });
        return rows;
    }, []);
};

const getAnalyticsTimezone = (query = {}) => {
    const offsetMinutes = Number(query.timezoneOffsetMinutes);
    if (!Number.isFinite(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) return 'UTC';
    const absolute = Math.abs(-offsetMinutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const minutes = String(absolute % 60).padStart(2, '0');
    return `${-offsetMinutes >= 0 ? '+' : '-'}${hours}:${minutes}`;
};

const analyticsValueExpression = (field, fallback = UNKNOWN_FILTER_LABEL) => ({
    $let: {
        vars: { normalized: { $trim: { input: { $ifNull: [field, ''] } } } },
        in: { $cond: [{ $eq: ['$$normalized', ''] }, fallback, '$$normalized'] },
    },
});

const getProfessionalAnalytics = async ({ user, query = {} }) => {
    const builtQuery = await buildIncidentQuery(user, query);
    const adminRoles = ADMIN_ROLES;
    const timezone = getAnalyticsTimezone(query);
    const [result = {}] = await Incident.aggregate([
        { $match: builtQuery },
        { $lookup: { from: User.collection.name, localField: 'assignedHandler', foreignField: '_id', as: '_handler' } },
        { $lookup: { from: IssuedLetter.collection.name, localField: '_id', foreignField: 'incident', as: '_letters' } },
        {
            $set: {
                _handler: { $arrayElemAt: ['$_handler', 0] },
                _category: { $cond: [{ $eq: [{ $ifNull: ['$category', ''] }, ''] }, 'Uncategorized', '$category'] },
                _location: analyticsValueExpression('$location'),
                _className: { $ifNull: ['$class', { $ifNull: ['$studentSnapshot.className', UNKNOWN_FILTER_LABEL] }] },
                _academicYear: { $cond: [{ $eq: [{ $ifNull: ['$academicYear', ''] }, ''] }, 'Unassigned Year', '$academicYear'] },
                _incidentTimestamp: { $ifNull: ['$incidentDate', { $ifNull: ['$openedAt', '$submittedAt'] }] },
                _hasLetter: { $gt: [{ $size: '$_letters' }, 0] },
                _evidenceValues: {
                    $cond: [
                        { $gt: [{ $size: { $ifNull: ['$evidence', []] } }, 0] },
                        { $map: { input: '$evidence', as: 'entry', in: analyticsValueExpression('$$entry.evidenceType') } },
                        [UNKNOWN_FILTER_LABEL],
                    ],
                },
            },
        },
        {
            $set: {
                _handlerName: {
                    $cond: [
                        { $eq: [{ $ifNull: ['$assignedHandler', null] }, null] },
                        'Unassigned',
                        { $ifNull: ['$_handler.name', 'Unknown User'] }
                    ]
                },
                _isUnassigned: {
                    $eq: [{ $ifNull: ['$assignedHandler', null] }, null]
                },
            },
        },
        {
            $facet: {
                summary: [{ $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
                    closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } },
                    lettersIssued: { $sum: { $cond: ['$_hasLetter', 1, 0] } },
                    unassigned: { $sum: { $cond: ['$_isUnassigned', 1, 0] } },
                    hasUnknownLocation: { $max: { $cond: [{ $eq: ['$_location', UNKNOWN_FILTER_LABEL] }, 1, 0] } },
                    hasUnknownEvidence: { $max: { $cond: [{ $in: [UNKNOWN_FILTER_LABEL, '$_evidenceValues'] }, 1, 0] } },
                } }],
                categoryData: [{ $group: { _id: '$_category', count: { $sum: 1 }, firstOrder: { $min: '$_id' } } }, { $sort: { count: -1, firstOrder: 1 } }],
                locationData: [{ $group: { _id: '$_location', count: { $sum: 1 }, firstOrder: { $min: '$_id' } } }, { $sort: { count: -1, firstOrder: 1 } }],
                evidenceData: [{ $unwind: '$_evidenceValues' }, { $group: { _id: '$_evidenceValues', count: { $sum: 1 }, firstOrder: { $min: '$_id' } } }, { $sort: { count: -1, firstOrder: 1 } }],
                classWiseData: [{ $group: { _id: '$_className', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } }, closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } } } }],
                staffWorkload: [{ $group: { _id: '$_handlerName', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } }, closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } } } }, { $sort: { total: -1 } }, { $limit: 8 }],
                categoryHeatmap: [{ $group: { _id: '$_category', pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } }, closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } } } }, { $set: { total: { $add: ['$pending', '$closed'] } } }, { $sort: { total: -1 } }],
                academicYearData: [{ $group: { _id: '$_academicYear', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } }, closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } } } }],
                trendBuckets: [{ $match: { _incidentTimestamp: { $ne: null } } }, { $group: { _id: { $dateToString: { date: '$_incidentTimestamp', format: '%Y-%m-%d', timezone } }, pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } }, closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } }, created: { $sum: 1 } } }, { $sort: { _id: 1 } }],
            },
        },
    ]).allowDiskUse(true);

    const summary = result.summary?.[0] || {};
    const total = summary.total || 0;
    if (total === 0 && await Incident.exists(builtQuery)) {
        throw new AppError('Analytics aggregation returned no data for a non-empty incident scope.', 500);
    }
    const pending = summary.pending || 0;
    const closed = summary.closed || 0;
    const sortAcademicYears = (a, b) => {
        const first = Number(String(a.academicYear).slice(0, 4));
        const second = Number(String(b.academicYear).slice(0, 4));
        if (!Number.isNaN(first) && !Number.isNaN(second)) return first - second;
        return String(a.academicYear).localeCompare(String(b.academicYear));
    };

    return {
        total,
        pending,
        open: pending,
        inProgress: 0,
        closed,
        lettersIssued: summary.lettersIssued || 0,
        active: pending,
        unassigned: summary.unassigned || 0,
        resolutionRate: total > 0 ? `${Math.round((closed / total) * 100)}%` : '0%',
        statusData: [
            { name: 'Pending', value: pending },
            { name: 'Closed', value: closed },
        ],
        categoryData: (result.categoryData || []).map(({ _id, count }) => ({ name: _id, count })),
        locationData: (result.locationData || []).map(({ _id, count }) => ({ name: _id, count })),
        evidenceData: (result.evidenceData || []).map(({ _id, count }) => ({ name: _id, count })),
        classWiseData: (result.classWiseData || []).map(({ _id, ...entry }) => ({ className: _id, ...entry })).sort((a, b) => Number(a.className) - Number(b.className) || String(a.className).localeCompare(String(b.className))),
        staffWorkload: (result.staffWorkload || []).map(({ _id, ...entry }) => ({ name: _id, ...entry })),
        categoryHeatmap: (result.categoryHeatmap || []).map(({ _id, total: ignored, ...entry }) => ({ label: _id, ...entry })),
        academicYearData: (result.academicYearData || []).map(({ _id, ...entry }) => ({ name: _id, academicYear: _id, ...entry, unresolved: entry.pending })).sort(sortAcademicYears),
        trendBuckets: (result.trendBuckets || []).map(({ _id, ...entry }) => ({ date: _id, ...entry })),
        hasUnknownLocation: Boolean(summary.hasUnknownLocation),
        hasUnknownEvidence: Boolean(summary.hasUnknownEvidence),
    };
};

const getProfessionalAnalyticsDetails = async ({ user, query = {} }) => {
    const result = await listIncidents({
        user,
        query: { ...query, page: query.page || 1, limit: query.limit || 100 },
        maxLimit: 500,
    });
    const data = result.data || [];
    const incidentIds = data.map((incident) => incident._id).filter(Boolean);
    const letters = incidentIds.length
        ? await IssuedLetter.find({ schoolId: user.schoolId, incident: { $in: incidentIds } })
            .select('incident letterNumber generatedAt')
            .lean()
        : [];
    const letterStatusMap = {};
    letters.forEach((letter) => {
        letterStatusMap[String(letter.incident)] = {
            hasLetter: true,
            letterNumber: letter.letterNumber,
            generatedAt: letter.generatedAt,
        };
    });
    return { data, letterStatusMap, pagination: result.pagination };
};

const getIncidentById = async (id, user) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const err = new Error('Invalid incident ID');
        err.statusCode = 400;
        throw err;
    }

    const incident = await Incident.findOne(tenantFilter(user, { _id: id }))
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
        const snapshot = getStudentSnapshotForAcademicYear(incidentObj.student, incidentObj.academicYear);
        incidentObj.studentDetails = {
            name: snapshot.name,
            admissionNo: snapshot.admissionNo,
            className: snapshot.className,
            section: snapshot.section,
        };
    } else if (incidentObj.admissionNo) {
        const student = await Student.findOne(tenantFilter(user, { admissionNo: incidentObj.admissionNo })).lean();
        if (student) {
            Incident.updateOne(tenantFilter(user, { _id: incidentObj._id }), { $set: { student: student._id } }).exec().catch((err) => {
                logger.error('Incident student link update failed', {
                    incidentId: incidentObj._id,
                    error: err.message,
                });
            });
            const snapshot = getStudentSnapshotForAcademicYear(student, incidentObj.academicYear);
            incidentObj.studentDetails = {
                name: snapshot.name,
                admissionNo: snapshot.admissionNo,
                className: snapshot.className,
                section: snapshot.section,
            };
        } else {
            incidentObj.studentDetails = null;
        }
    } else {
        incidentObj.studentDetails = null;
    }

    const [incidentWithReadState] = await attachReadState([incidentObj], user);
    return incidentWithReadState;
};

const markIncidentRead = async (incidentId, user) => {
    if (!mongoose.Types.ObjectId.isValid(incidentId)) {
        const err = new Error('Invalid incident ID');
        err.statusCode = 400;
        throw err;
    }

    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId })).lean();
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    assertIncidentAccess(incident, user, 'view');

    const userId = getUserId(user);
    const readAt = new Date();
    await IncidentReadState.findOneAndUpdate(
        { schoolId: user.schoolId, user: userId, incident: incidentId },
        { $set: { readAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    notificationService
        .markAsReadByIncident({ incidentId, userId, schoolId: user.schoolId })
        .catch((err) => logger.warn('Incident notification read sync failed', { incidentId, userId, error: err.message }));

    return { incidentId, readByCurrentUser: true, readAt };
};

const assignIncident = async (incidentId, handlerId, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    const isSelfAssignment = isAdministrationRole(user?.role) && toIdString(handlerId) === getUserId(user);
    if (toIdString(incident.assignedHandler) === toIdString(handlerId)) {
        return {
            message: isSelfAssignment ? 'Already assigned to you.' : 'Already assigned to selected investigator.',
            alreadyAssigned: true,
        };
    }

    const handler = await User.findById(handlerId)
        .select('_id schoolId role status isActive deletedAt')
        .lean();

    if (!handler) {
        const err = new Error('Selected staff member does not exist.');
        err.statusCode = 404;
        throw err;
    }

    if (String(handler.schoolId || '').toUpperCase() !== String(incident.schoolId || '').toUpperCase()) {
        const err = new Error('Selected staff member cannot be assigned to this incident.');
        err.statusCode = 400;
        throw err;
    }

    if (!isAssignableStaffActive(handler)) {
        const err = new Error('Selected staff member is inactive.');
        err.statusCode = 400;
        throw err;
    }

    const roleAllowed = isSelfAssignment
        ? ADMIN_ROLES.includes(handler.role)
        : ALL_ASSIGNABLE_ROLES.includes(handler.role);

    if (!roleAllowed) {
        const err = new Error('Selected staff member cannot be assigned.');
        err.statusCode = 400;
        throw err;
    }

    incident.assignedHandler = handler._id;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({
        note: 'CASE ASSIGNED TO HANDLER.',
        updatedBy: formatUserLogLabel(user),
        timestamp: Date.now(),
    });

    await incident.save();

    const reporterId = incident.reportedBy?._id || incident.reportedBy;

    createLog(
        'Incident Assigned',
        user,
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
                handlerId ? { recipient: handlerId, actionName: 'Incident Assigned', message: `${user.name} assigned you a new incident: "${incident.title}".` } : null,
                reporterId ? { recipient: reporterId, actionName: 'Incident Assigned', message: `Your incident "${incident.title}" was assigned for handling.` } : null,
            ].filter(Boolean),
        }
    );

    return { message: 'Incident assigned.' };
};

const addProgressNote = async (incidentId, note, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'update');

    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: note || 'Operational field update recorded.', updatedBy: formatUserLogLabel(user), timestamp: Date.now() });
    if (incident.rejectionReason) incident.rejectionReason = null;

    await incident.save();

    const progressActionName = 'Progress Log Added';
    const handlerId = incident.assignedHandler?._id || incident.assignedHandler;

    const progressNotificationConfig = isAdministrationRole(user.role)
        ? {
            recipientEntries: [
                handlerId ? {
                    recipient: handlerId,
                    actionName: progressActionName,
                    type: 'INCIDENT_PROGRESS',
                    message: `${user.name} added a progress update to "${incident.title}".`,
                } : null,
            ].filter(Boolean),
        }
        : { recipientRoles: ['Super Admin', 'Admin'], message: `${user.name} added a progress update to "${incident.title}".` };

    createLog(
        progressActionName,
        user,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, { note, status: incident.status, previousStatus: incident.status }),
        { type: 'INCIDENT_PROGRESS', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident), ...progressNotificationConfig }
    );

    return incident;
};

const requestClosure = async (incidentId, actionTaken, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'request closure for');

    const trimmedActionTaken = String(actionTaken || '').trim();
    if (!trimmedActionTaken) {
        const err = new Error('Action taken is required before requesting case closure.');
        err.statusCode = 400;
        throw err;
    }

    incident.closureRequested = true;
    incident.actionTaken = trimmedActionTaken;
    trimProgressLogsBeforePush(incident);
    const closesImmediately = OPERATIONAL_ROLES.includes(user.role);
    if (closesImmediately) {
        const closedAt = Date.now();
        incident.status = 'Closed';
        incident.closedAt = closedAt;
        incident.closedBy = user.id;
        incident.closureRequested = false;
        incident.rejectionReason = null;
        incident.progressLogs.push({ note: `CASE CLOSED: ${trimmedActionTaken}`, updatedBy: formatUserLogLabel(user), timestamp: closedAt });
    } else {
        incident.progressLogs.push({ note: 'CLOSURE REQUESTED: Investigation completed and submitted for final seal.', updatedBy: formatUserLogLabel(user), timestamp: Date.now() });
    }

    await incident.save();

    createLog(closesImmediately ? 'Incident Closed' : 'Closure Requested', user, 'Incident', incident._id, buildIncidentMetadata(incident, { actionTaken: trimmedActionTaken, status: incident.status, closureRequested: incident.closureRequested, closedAt: incident.closedAt || null }), {
        type: closesImmediately ? 'INCIDENT_CLOSED' : 'CLOSURE_REQUESTED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident), recipientRoles: ['Super Admin', 'Admin'], message: closesImmediately ? `${user.name} closed "${incident.title}".` : `${user.name} requested closure for "${incident.title}".`,
    });

    return closesImmediately
        ? { message: 'Incident closed successfully.', status: incident.status }
        : { message: 'Closure requested.' };
};

const finalizeClosure = async (incidentId, note, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
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
    incident.progressLogs.push({ note: note || 'CASE PERMANENTLY SEALED: Admin finalized closure.', updatedBy: formatUserLogLabel(user), timestamp: Date.now() });

    await incident.save();

    const repId = incident.reportedBy?._id || incident.reportedBy;
    const handId = incident.assignedHandler?._id || incident.assignedHandler;

    createLog('Incident Closed', user, 'Incident', incident._id, buildIncidentMetadata(incident, { note: note || null, status: incident.status, closedAt: incident.closedAt }), {
        type: 'INCIDENT_CLOSED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident),
        recipientEntries: [repId, handId].filter(Boolean).map((recipient) => ({ recipient, actionName: 'Incident Closed', message: `${user.name} closed "${incident.title}".` })),
    });

    return { message: 'Case permanently closed.' };
};

const rejectClosure = async (incidentId, reason, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
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
    incident.status = 'Pending';
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({ note: `CLOSURE REJECTED: ${rejectionReason}`, updatedBy: formatUserLogLabel(user), timestamp: Date.now() });

    await incident.save();

    const handlerId = incident.assignedHandler?._id || incident.assignedHandler;

    createLog('Closure Rejected', user, 'Incident', incident._id, buildIncidentMetadata(incident, { reason: incident.rejectionReason, status: incident.status, closureRequested: incident.closureRequested }), {
        type: 'INCIDENT_STATUS_UPDATED', incidentId: incident._id, targetLabel: incident.title, targetAdmissionNumber: incident.admissionNo || null, routePath: `/incidents/${incident._id}`, studentDetails: buildIncidentStudentDetails(incident),
        recipientEntries: handlerId ? [{ recipient: handlerId, actionName: 'Closure Rejected', message: `${user.name} rejected closure for "${incident.title}".` }] : [],
    });

    return { message: 'Closure rejected and case returned to the handler.', status: incident.status, rejectionReason: incident.rejectionReason };
};

const deleteIncident = async (incidentId, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    await deleteIncidentFilesFromS3OrThrow(incident, {
        operation: 'deleteIncident',
        incidentId,
        actorId: user?.id || user?._id,
        schoolId: user?.schoolId,
    });

    const issuedLetters = await require('../models/IssuedLetter')
        .find(tenantFilter(user, { incident: incident._id }))
        .select('_id')
        .lean();

    for (const letter of issuedLetters) {
        await deleteIssuedLetter(letter._id, user);
    }

    await Incident.findOneAndDelete(tenantFilter(user, { _id: incidentId }));
    await IncidentReadState.deleteMany(tenantFilter(user, { incident: incidentId }));

    createLog('Incident Deleted', user, 'Incident', incident._id, {
        title: incident.title, class: incident.class, students: incident.studentsInvolved,
    });

    return { message: 'Incident deleted successfully.' };
};

const addEvidence = async (incidentId, files, evidenceDataRaw, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
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
    incident.progressLogs.push({ note: `ADDED NEW EVIDENCE: ${newEntries.length} items attached by ${formatUserLogLabel(user)}.`, updatedBy: formatUserLogLabel(user), timestamp: Date.now() });

    await incident.save();
    return incident;
};

const deleteEvidence = async (incidentId, evidenceId, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'delete evidence from');

    const evidenceEntry = incident.evidence.id(evidenceId);
    if (!evidenceEntry) {
        const err = new Error('Evidence record not found');
        err.statusCode = 404;
        throw err;
    }

    const s3Key = extractS3KeyFromProtectedUrl(evidenceEntry.fileUrl);
    if (s3Key) {
        await deleteS3ObjectOrThrow(s3Key, {
            operation: 'deleteIncidentEvidence',
            incidentId,
            evidenceId,
            actorId: user?.id || user?._id,
            schoolId: user?.schoolId,
        });
    }

    const evidenceLabel = evidenceEntry.evidenceType || evidenceEntry.originalName || 'Evidence';
    incident.evidence.pull(evidenceId);
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({
        note: `DELETED EVIDENCE: ${evidenceLabel} removed by ${formatUserLogLabel(user)}.`,
        updatedBy: formatUserLogLabel(user),
        timestamp: Date.now(),
    });

    await incident.save();

    createLog(
        'Evidence Deleted',
        user,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, {
            evidenceId,
            evidenceType: evidenceLabel,
            s3Key: s3Key || null,
        })
    );

    return incident;
};

const updateDescription = async (incidentId, description, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }
    assertIncidentMutationAccess(incident, user, 'edit description for');

    const nextDescription = String(description || '').trim();
    if (incident.description === nextDescription) return incident;

    incident.description = nextDescription;
    trimProgressLogsBeforePush(incident);
    incident.progressLogs.push({
        note: 'INCIDENT DESCRIPTION UPDATED.',
        updatedBy: formatUserLogLabel(user),
        timestamp: Date.now(),
    });

    await incident.save();

    createLog(
        'Incident Description Updated',
        user,
        'Incident',
        incident._id,
        buildIncidentMetadata(incident, { editedBy: user.name, editedAt: new Date() })
    );

    return incident;
};

// ─────────────────────────────────────────────────────────────────────────────
// Bulk Excel upload
// ─────────────────────────────────────────────────────────────────────────────

const processExcelUpload = async (filePath, user, body, options = {}) => {
    const startedAt = Date.now();
    const timings = {
        excelParsingMs: 0,
        validationMs: 0,
        incidentCreationMs: 0,
        letterGenerationMs: 0,
        auditLogCreationMs: 0,
        notificationCreationMs: 0,
        totalMs: 0,
    };
    const markTiming = (key, start) => {
        timings[key] += Date.now() - start;
    };
    const completeTimings = () => {
        timings.totalMs = Date.now() - startedAt;
        return timings;
    };
    const reportProgress = (stage, percent) => {
        if (typeof options.onProgress === 'function') {
            options.onProgress({ stage, percent });
        }
    };
    let workbook;
    let data = [];

    const parseStartedAt = Date.now();
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
            err.timings = completeTimings();
            throw err;
        }
        const err = new Error('Failed to read Excel file: ' + readErr.message);
        err.statusCode = 400;
        err.timings = completeTimings();
        throw err;
    }
    markTiming('excelParsingMs', parseStartedAt);
    reportProgress('Validating spreadsheet rows', 15);

    if (data.length === 0) {
        const err = new Error('Excel file is empty');
        err.statusCode = 400;
        err.timings = completeTimings();
        throw err;
    }

    const validationStartedAt = Date.now();
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
        findByNameSet(Category, categorySet, user.schoolId),
        findByNameSet(Location, locationSet, user.schoolId),
        findByNameSet(EvidenceType, evidenceTypeSet, user.schoolId),
        findByFieldRegexSet(Student, 'admissionNo', admissionNoSet, user.schoolId).then((rows) =>
            rows.map((s) => ({
                admissionNo: s.admissionNo,
                name: s.name,
                className: s.className,
                section: s.section,
                academicYear: s.academicYear,
                history: s.history || [],
            }))
        ),
        findByFieldRegexSet(User, 'email', emailSet, user.schoolId).then((rows) =>
            rows.map((u) => ({ _id: u._id, email: u.email, role: u.role, name: u.name }))
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
    const seenIncidentRows = new Map();
    const currentAcademicYear = await getCurrentAcademicYear(user);
    const uploadAcademicYear = body?.academicYear
        ? validateAcademicYear(body.academicYear)
        : currentAcademicYear;

    if (Number(uploadAcademicYear.slice(0, 4)) > Number(currentAcademicYear.slice(0, 4))) {
        const err = new Error(`Academic Year cannot be greater than the current school academic year (${currentAcademicYear}).`);
        err.statusCode = 400;
        err.errors = [err.message];
        err.validationResults = {
            ...validationResults,
            failedRows: data.length,
            errors: [{ row: 'Upload', reason: err.message, column: 'academicYear' }],
        };
        markTiming('validationMs', validationStartedAt);
        err.timings = completeTimings();
        throw err;
    }

    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNum = i + 2;
        let rowAcademicYearValue = '';
        for (const key of Object.keys(row)) {
            const keyLower = key.toLowerCase().trim();
            if (keyLower === 'academicyear' || keyLower === 'academic year' || keyLower.startsWith('academicyear') || keyLower.startsWith('academic year')) {
                rowAcademicYearValue = row[key]?.toString().trim() || '';
                break;
            }
        }
        if (!rowAcademicYearValue) continue;
        const rowAcademicYear = validateAcademicYear(rowAcademicYearValue);
        if (Number(rowAcademicYear.slice(0, 4)) > Number(currentAcademicYear.slice(0, 4))) {
            const message = `Academic Year cannot be greater than the current school academic year (${currentAcademicYear}).`;
            const err = new Error(message);
            err.statusCode = 400;
            err.errors = [`Row ${rowNum}: ${message}`];
            err.validationResults = {
                ...validationResults,
                failedRows: data.length,
                errors: [{ row: rowNum, reason: message, column: 'academicYear' }],
            };
            markTiming('validationMs', validationStartedAt);
            err.timings = completeTimings();
            throw err;
        }
    }

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
        const normalizedAdmissionNumber = admissionNumber.toLowerCase();

        const student = studentMap.get(admissionNumber) || studentMap.get(normalizedAdmissionNumber);
        if (!student) { addFieldError('admissionNumber', `student "${admissionNumber}" not found`); continue; }
        const rowAcademicYearValue = getCellValue('academicYear', 'academic year');
        let incidentAcademicYear = uploadAcademicYear;
        if (rowAcademicYearValue) {
            try {
                incidentAcademicYear = validateAcademicYear(rowAcademicYearValue);
            } catch (error) {
                addFieldError('academicYear', error.message);
                continue;
            }
        }
        const studentSnapshot = getStudentSnapshotForAcademicYear(student, incidentAcademicYear);

        const categoryInput = getCellValue('category');
        if (!categoryInput) { addFieldError('category', 'missing or empty'); continue; }
        const validCategory = categoryMap.get(categoryInput.toLowerCase());
        if (!validCategory) { addFieldError('category', `invalid "${categoryInput}"`); continue; }

        const locationInput = getCellValue('location');
        let validLocation = '';
        if (locationInput) {
            validLocation = locationMap.get(locationInput.toLowerCase());
            if (!validLocation) { addFieldError('location', `invalid "${locationInput}"`); continue; }
        }

        const description = getCellValue('description');

        const evidenceTypeInput = getCellValue('evidenceType', 'evidenceType*', 'evidence', 'evidence_type');
        const evidenceTypeNames = evidenceTypeInput
            ? evidenceTypeInput.split(',').map((t) => t.trim()).filter(Boolean)
            : [];
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
        if (handledByInput && isAdministrationRole(user.role)) {
            const handler = userMap.get(handledByInput.toLowerCase().trim());
            if (!handler) { addFieldError('handledBy', `Staff "${handledByInput}" not found`); continue; }
            assignedHandler = handler._id;
        }
        if (!assignedHandler) {
            assignedHandler = user.id;
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

        const duplicateKey = [
            normalizedAdmissionNumber,
            incidentAcademicYear,
            validCategory.toLowerCase().trim(),
            incidentRegisterDate.toISOString(),
            String(description || '').toLowerCase().trim().replace(/\s+/g, ' '),
            String(validLocation || '').toLowerCase().trim(),
            isHighPriority ? 'high' : 'normal',
        ].join('|');
        if (seenIncidentRows.has(duplicateKey)) {
            addFieldError(
                'duplicate',
                `duplicate incident also found on row ${seenIncidentRows.get(duplicateKey)}`
            );
            continue;
        }
        seenIncidentRows.set(duplicateKey, rowNum);

        incidents.push({
            schoolId: user.schoolId,
            academicYear: incidentAcademicYear,
            title: validCategory,
            category: validCategory,
            location: validLocation,
            description,
            reportedBy: user.id,
            submittedAt: incidentRegisterDate,
            createdAt: incidentRegisterDate,
            incidentDate: incidentRegisterDate,
            status: 'Pending',
            isHighPriority,
            assignedHandler,
            evidence: validEvidenceTypes.map((type) => ({ evidenceType: type, fileUrl: null })),
            studentsInvolved: [studentSnapshot.name],
            class: studentSnapshot.className,
            section: studentSnapshot.section,
            admissionNo: studentSnapshot.admissionNo,
            studentSnapshot: {
                name: studentSnapshot.name,
                admissionNo: studentSnapshot.admissionNo,
                className: studentSnapshot.className,
                section: studentSnapshot.section,
                academicYear: incidentAcademicYear,
            },
        });

        validationResults.successRows++;
    }

    if (errors.length > 0 || incidents.length !== data.length) {
        const err = new Error('Excel validation failed - no incidents were created. Please correct every reported row and upload again.');
        err.statusCode = 400;
        err.errors = errors;
        err.validationResults = validationResults;
        markTiming('validationMs', validationStartedAt);
        err.timings = completeTimings();
        throw err;
    }
    markTiming('validationMs', validationStartedAt);
    reportProgress('Saving incidents', 55);

    const shouldGenerate = body.shouldGenerateLetter === 'true' || body.shouldGenerateLetter === true;
    const letterLanguage = body.letterLanguage || 'en';
    const session = await mongoose.startSession();
    let createdIncidents = [];
    const lettersGenerated = [];
    const lettersFailed = [];
    let notifications = [];
    let notificationRecipients = [];

    try {
        await session.withTransaction(async () => {
            createdIncidents = [];
            lettersGenerated.length = 0;
            notifications = [];
            notificationRecipients = [];

            const incidentCreationStartedAt = Date.now();
            createdIncidents = await Incident.insertMany(incidents, { ordered: true, session });
            markTiming('incidentCreationMs', incidentCreationStartedAt);
            reportProgress('Generating letters', shouldGenerate ? 70 : 78);

            if (shouldGenerate) {
                for (const incident of createdIncidents) {
                    const letterStartedAt = Date.now();
                    const result = await autoGenerateLetterFromIncident(
                        incident,
                        user.id,
                        letterLanguage,
                        true,
                        { session, skipStorage: true }
                    );
                    markTiming('letterGenerationMs', letterStartedAt);

                    if (!result.success) {
                        const letterError = new Error(result.message || 'Letter generation failed.');
                        letterError.statusCode = 400;
                        throw letterError;
                    }

                    lettersGenerated.push({
                        incidentId: incident._id,
                        letterId: result.letter._id,
                        letterNumber: result.letter.letterNumber,
                        studentName: incident.studentsInvolved?.[0] || 'Unknown',
                    });
                }
            }
            reportProgress('Writing audit log', 82);

            const auditLogStartedAt = Date.now();
            await Log.create([{
                schoolId: user.schoolId,
                academicYear: createdIncidents[0]?.academicYear || uploadAcademicYear,
                actionName: 'Bulk Upload Processed',
                performedBy: String(user.id || user._id || 'System'),
                entityType: 'Bulk Upload',
                entityId: null,
                targetLabel: `${createdIncidents.length} incidents uploaded`,
                metadata: {
                    targetLabel: `${createdIncidents.length} incidents uploaded`,
                    count: createdIncidents.length,
                    lettersGenerated: lettersGenerated.length,
                    summary: true,
                    uploadType: 'Incident',
                    routePath: '/upload-incidents',
                    academicYear: createdIncidents[0]?.academicYear || uploadAcademicYear,
                },
            }], { session });
            markTiming('auditLogCreationMs', auditLogStartedAt);
            reportProgress('Creating notifications', 88);

            const notificationStartedAt = Date.now();
            const admins = await User.find({ schoolId: user.schoolId, role: { $in: ADMIN_ROLES } })
                .select('_id')
                .session(session)
                .lean();

            notifications = admins
                .filter((a) => a._id.toString() !== String(user.id || user._id))
                .map((a) => ({
                    schoolId: user.schoolId,
                    recipient: a._id,
                    type: 'INCIDENT_CREATED',
                    entityType: 'Bulk Upload',
                    entityId: null,
                    actionName: 'Bulk Upload Processed',
                    message: `${user.name} bulk uploaded ${createdIncidents.length} incidents from Excel file`,
                    performedBy: String(user.id || user._id),
                    performedByName: user.name,
                    performedByRole: user.role,
                    targetLabel: `${createdIncidents.length} incidents`,
                    routePath: '/upload-incidents',
                    metadata: {
                        count: createdIncidents.length,
                        lettersGenerated: lettersGenerated.length,
                        routePath: '/upload-incidents',
                    },
                }));

            if (notifications.length > 0) {
                await Notification.insertMany(notifications, { ordered: true, session });
                notificationRecipients = notifications.map((document) => ({
                    userId: document.recipient,
                    schoolId: document.schoolId,
                }));
            }
            markTiming('notificationCreationMs', notificationStartedAt);
            reportProgress('Committing transaction', 95);
        });
    } catch (err) {
        const transactionError = new Error(err.message || 'Bulk upload failed. No incidents were created.');
        transactionError.statusCode = err.statusCode || 500;
        transactionError.errors = err.errors || [transactionError.message];
        transactionError.validationResults = err.validationResults || {
            ...validationResults,
            errors: [
                ...validationResults.errors,
                { row: 'Transaction', reason: transactionError.message, column: 'System' },
            ],
        };
        transactionError.timings = completeTimings();
        throw transactionError;
    } finally {
        await session.endSession();
    }

    if (notificationRecipients.length > 0) {
        setImmediate(() => {
            notificationService.pushToUsers(notificationRecipients).catch((pushError) => {
                logger.warn('Bulk upload notification push failed after commit', { error: pushError?.message });
            });
        });
    }
    reportProgress('Completed', 99);

    return { createdIncidents, lettersGenerated, lettersFailed, errors, validationResults, timings: completeTimings() };
};

const buildDownloadTemplate = async (format = 'xlsx', user) => {
    const [categories, locations, evidenceTypes, students, users] = await Promise.all([
        Category.find(tenantFilter(user)).select('name').sort({ name: 1 }).lean(),
        Location.find(tenantFilter(user)).select('name').sort({ name: 1 }).lean(),
        EvidenceType.find(tenantFilter(user)).select('name').sort({ name: 1 }).lean(),
        Student.find(tenantFilter(user)).select('admissionNo name className section').limit(5).lean(),
        User.find({
            schoolId: user.schoolId,
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
        ['admissionNumber*', 'category*', 'location', 'description', 'evidenceType', 'handledBy', 'day*', 'month*', 'year*', 'hour*', 'minute*', 'timePeriod (AM/PM)', 'highPriority (Yes/No)'],
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
        return { format: 'csv', content };
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
    return { format: 'xlsx', buffer };
};

// ─────────────────────────────────────────────────────────────────────────────
// Export Incident Case Report (DOCX)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    createIncidents,
    listIncidents,
    getIncidentSummary,
    getDistinctClasses,
    getDistinctSections,
    getLocationDistribution,
    getProfessionalAnalytics,
    getProfessionalAnalyticsDetails,
    getIncidentById,
    markIncidentRead,
    assignIncident,
    addProgressNote,
    requestClosure,
    finalizeClosure,
    rejectClosure,
    deleteIncident,
    addEvidence,
    deleteEvidence,
    updateDescription,
    processExcelUpload,
    buildDownloadTemplate,
    buildCaseReportDocx,
    buildIncidentMetadata,
    buildIncidentStudentDetails,
};
