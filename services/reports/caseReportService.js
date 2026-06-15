'use strict';

const mongoose = require('mongoose');
const Incident = require('../../models/Incident');
const { tenantFilter } = require('../../utils/tenant');
const {
    DOCX_MIME_TYPE,
    createSimpleDocx,
    emptyParagraph,
    paragraph,
} = require('../../utils/docxSecurity');

const ADMIN_ROLES = new Set(['Super Admin', 'Admin', 'super_admin', 'admin']);
const OPERATIONAL_ROLES = new Set(['Teacher', 'teacher']);

const toIdString = (value) => {
    if (!value) return '';
    if (value._id) return String(value._id);
    return String(value);
};

const assertReportAccess = (incident, user) => {
    if (!incident || !user) {
        const err = new Error('You are not allowed to export this incident.');
        err.statusCode = 403;
        throw err;
    }

    if (String(incident.schoolId || '').toUpperCase() !== String(user.schoolId || '').toUpperCase()) {
        const err = new Error('You are not allowed to export this incident.');
        err.statusCode = 403;
        throw err;
    }

    if (ADMIN_ROLES.has(user.role)) return;

    const userId = toIdString(user.id || user._id);
    const canAccess =
        (OPERATIONAL_ROLES.has(user.role) && [incident.reportedBy, incident.assignedHandler].some((id) => toIdString(id) === userId)) ||
        (user.role === 'Student' && String(incident.admissionNo || '') === String(user.admissionNo || ''));

    if (!canAccess) {
        const err = new Error('You are not allowed to export this incident.');
        err.statusCode = 403;
        throw err;
    }
};

const formatDate = (date) => {
    if (!date) return 'N/A';
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return 'N/A';
    return parsed.toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

const cleanFilenamePart = (value, fallback = 'NA', max = 25) => {
    const clean = String(value || fallback)
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, max);
    return clean || fallback;
};

const buildReportFilename = ({ studentClass, studentSection, studentName, admissionNo, category }) =>
    [
        cleanFilenamePart(studentClass),
        cleanFilenamePart(studentSection),
        cleanFilenamePart(studentName),
        cleanFilenamePart(admissionNo),
        cleanFilenamePart(category || 'Incident', 'Incident', 20),
    ].join('_') + '.docx';

const resolveStudentSnapshot = async (incident) => {
    return {
        studentName: incident.studentSnapshot?.name || incident.studentsInvolved?.[0] || incident.student?.name || 'N/A',
        studentClass: incident.studentSnapshot?.className || incident.class || '',
        studentSection: incident.studentSnapshot?.section || incident.section || '',
    };
};

const buildParagraphs = (incident, studentSnapshot) => {
    const progressLogs = Array.isArray(incident.progressLogs) ? incident.progressLogs : [];
    const isClosed = incident.status === 'Closed';

    const rows = [
        paragraph('INCIDENT CASE REPORT', { bold: true, size: 44 }),
        emptyParagraph(),
        paragraph('STUDENT INFORMATION', { bold: true }),
        paragraph(`Incident Title: ${incident.title || 'Untitled Incident'}`),
        paragraph(`Student: ${studentSnapshot.studentName}`),
        paragraph(`Admission Number: ${incident.admissionNo || 'N/A'}`),
        paragraph(`Class: ${studentSnapshot.studentClass || 'N/A'} | Section: ${studentSnapshot.studentSection || 'N/A'}`),
        emptyParagraph(),
        paragraph('INCIDENT DETAILS', { bold: true }),
        paragraph(`Type: ${incident.category || 'N/A'} | Location: ${incident.location || 'Not provided'} | Severity: ${incident.severity || 'N/A'}`),
        paragraph(`Status: ${incident.status || 'Open'}`),
        paragraph(`Assigned Handler: ${incident.assignedHandler?.name || 'Unassigned'}`),
        paragraph(`Description: ${incident.description || 'Not provided'}`),
        emptyParagraph(),
        paragraph('TIMELINE', { bold: true }),
        paragraph(`Reported By: ${incident.reportedBy?.name || 'N/A'} | Handler: ${incident.assignedHandler?.name || 'Unassigned'}`),
        paragraph(`Opened: ${formatDate(incident.openedAt || incident.submittedAt || incident.createdAt)}`),
        paragraph(`In Progress: ${formatDate(incident.inProgressAt || incident.progressAt)}`),
        paragraph(`Closed: ${formatDate(incident.closedAt)}`),
        emptyParagraph(),
        paragraph('PROGRESS HISTORY', { bold: true }),
    ];

    if (progressLogs.length === 0) {
        rows.push(paragraph('No progress updates recorded.'));
    } else {
        progressLogs.forEach((log) => {
            rows.push(paragraph(`- ${formatDate(log.timestamp)} | ${log.updatedBy || 'Unknown'}: ${log.note || 'N/A'}`));
        });
    }

    if (isClosed) {
        const closureNote = incident.closureNote || 'Case closed without specific notes';
        rows.push(
            emptyParagraph(),
            paragraph('CLOSURE', { bold: true }),
            paragraph(`Closed: ${formatDate(incident.closedAt)} | Note: ${closureNote}`),
            paragraph(`Final Decision: ${closureNote}`)
        );
    }

    return rows;
};

const buildCaseReportDocx = async (incidentId, user) => {
    if (!mongoose.Types.ObjectId.isValid(incidentId)) {
        const err = new Error('Invalid incident ID');
        err.statusCode = 400;
        throw err;
    }

    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }))
        .populate('reportedBy', 'name role')
        .populate('assignedHandler', 'name role')
        .populate('closedBy', 'name role')
        .populate('student', 'name admissionNo className section')
        .lean();

    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    assertReportAccess(incident, user);

    const studentSnapshot = await resolveStudentSnapshot(incident);
    const buffer = createSimpleDocx(buildParagraphs(incident, studentSnapshot));
    const filename = buildReportFilename({
        studentClass: studentSnapshot.studentClass,
        studentSection: studentSnapshot.studentSection,
        studentName: studentSnapshot.studentName,
        admissionNo: incident.admissionNo,
        category: incident.category,
    });

    return { buffer, filename, contentType: DOCX_MIME_TYPE };
};

module.exports = {
    buildCaseReportDocx,
    buildReportFilename,
};
