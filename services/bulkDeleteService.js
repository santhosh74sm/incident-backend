'use strict';

const mongoose = require('mongoose');

const Student = require('../models/Student');
const Incident = require('../models/Incident');
const IssuedLetter = require('../models/IssuedLetter');
const BulkDeleteLog = require('../models/BulkDeleteLog');
const AppError = require('../utils/AppError');
const studentService = require('./studentService');
const incidentService = require('./incidentService');
const issuedLetterService = require('./issuedLetterService');
const { tenantFilter } = require('../utils/tenant');
const { getCurrentAcademicYear } = require('./academicYearService');

const MODULES = new Set(['students', 'incidents', 'issued-letters']);
const MODES = new Set(['filtered', 'all']);
const BATCH_SIZE = 50;

const getActorId = (actor) => actor?.id || actor?._id;
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const ensureSuperAdmin = (actor) => {
    const normalizedRole = String(actor?.role || '').trim().toLowerCase();
    if (!['super admin', 'super_admin'].includes(normalizedRole)) {
        throw new AppError('Only Super Admin can perform bulk deletion.', 403);
    }
};

const normalizeIds = (ids = []) =>
    [...new Set((Array.isArray(ids) ? ids : [])
        .map((id) => String(id || '').trim())
        .filter(isObjectId))];

const buildScopeQuery = (moduleName, payload = {}, actor) => {
    const mode = payload.mode || 'filtered';
    if (!MODES.has(mode)) throw new AppError('Invalid bulk delete mode.', 400);
    const studentStatus = ['Active', 'Passed Out'].includes(payload.status) ? payload.status : null;
    const studentScope = moduleName === 'students' && studentStatus ? { status: studentStatus } : {};
    if (mode === 'all') {
        return tenantFilter(actor, studentScope);
    }

    const ids = normalizeIds(payload.ids);
    if (ids.length === 0) {
        throw new AppError('Delete Filtered requires at least one record in scope.', 400);
    }
    return tenantFilter(actor, {
        _id: { $in: ids },
        ...studentScope,
    });
};

const getModel = (moduleName) => {
    if (moduleName === 'students') return Student;
    if (moduleName === 'incidents') return Incident;
    if (moduleName === 'issued-letters') return IssuedLetter;
    throw new AppError('Invalid bulk delete module.', 400);
};

const getScopedIds = async (moduleName, payload, actor) => {
    if (!MODULES.has(moduleName)) throw new AppError('Invalid bulk delete module.', 400);
    const Model = getModel(moduleName);
    const query = buildScopeQuery(moduleName, payload, actor);
    return Model.find(query).select('_id').sort({ _id: 1 }).lean();
};

const summarizeIncidents = (incidents = []) => ({
    incidentCount: incidents.length,
    evidenceFileCount: incidents.reduce((count, incident) =>
        count + (incident.evidence || []).filter((item) => item?.fileUrl).length, 0),
});

const previewStudents = async (payload, actor) => {
    const studentIds = (await getScopedIds('students', payload, actor)).map((student) => student._id);
    const students = studentIds.length
        ? await Student.find(tenantFilter(actor, { _id: { $in: studentIds } })).select('admissionNo name academicYear status').lean()
        : [];

    const admissionNos = students.map((student) => student.admissionNo).filter(Boolean);
    const names = students.map((student) => student.name).filter(Boolean);
    const relatedIncidents = await Incident.find({
        schoolId: actor.schoolId,
        $or: [
            { student: { $in: studentIds } },
            { admissionNo: { $in: admissionNos } },
            { studentsInvolved: { $in: names } },
        ],
    }).select('_id evidence').lean();
    const incidentIds = relatedIncidents.map((incident) => incident._id);
    const issuedLetterCount = await IssuedLetter.countDocuments({
        schoolId: actor.schoolId,
        $or: [
            { admissionNo: { $in: admissionNos } },
            { incident: { $in: incidentIds } },
        ],
    });
    const incidentSummary = summarizeIncidents(relatedIncidents);

    return {
        module: 'students',
        mode: payload.mode,
        total: students.length,
        summary: {
            studentsToDelete: students.length,
            incidentsToDelete: incidentSummary.incidentCount,
            issuedLettersToDelete: issuedLetterCount,
            evidenceFiles: incidentSummary.evidenceFileCount,
        },
    };
};

const previewIncidents = async (payload, actor) => {
    const incidentIds = (await getScopedIds('incidents', payload, actor)).map((incident) => incident._id);
    const incidents = incidentIds.length
        ? await Incident.find(tenantFilter(actor, { _id: { $in: incidentIds } })).select('_id evidence').lean()
        : [];
    const issuedLetterCount = await IssuedLetter.countDocuments(tenantFilter(actor, { incident: { $in: incidentIds } }));
    const incidentSummary = summarizeIncidents(incidents);

    return {
        module: 'incidents',
        mode: payload.mode,
        total: incidents.length,
        summary: {
            incidents: incidents.length,
            evidenceFiles: incidentSummary.evidenceFileCount,
            issuedLetters: issuedLetterCount,
        },
    };
};

const previewIssuedLetters = async (payload, actor) => {
    const letters = await getScopedIds('issued-letters', payload, actor);
    return {
        module: 'issued-letters',
        mode: payload.mode,
        total: letters.length,
        summary: {
            issuedLetters: letters.length,
        },
    };
};

const previewBulkDelete = async ({ moduleName, payload, actor }) => {
    ensureSuperAdmin(actor);
    if (moduleName === 'students') return previewStudents(payload, actor);
    if (moduleName === 'incidents') return previewIncidents(payload, actor);
    if (moduleName === 'issued-letters') return previewIssuedLetters(payload, actor);
    throw new AppError('Invalid bulk delete module.', 400);
};

const deleteOne = async (moduleName, id, actor) => {
    if (moduleName === 'students') {
        return studentService.deleteStudent({ studentId: id, actor });
    }
    if (moduleName === 'incidents') {
        return incidentService.deleteIncident(id, actor);
    }
    if (moduleName === 'issued-letters') {
        return issuedLetterService.deleteIssuedLetter(id, actor);
    }
    throw new AppError('Invalid bulk delete module.', 400);
};

const executeBulkDelete = async ({ moduleName, payload, actor }) => {
    ensureSuperAdmin(actor);

    const mode = payload.mode || 'filtered';
    const preview = await previewBulkDelete({ moduleName, payload, actor });
    const actionWord = 'DELETE';
    const requiredPhrase = preview.total >= 100 ? `${actionWord} ${preview.total}` : actionWord;
    if (String(payload.confirmation || '').trim() !== requiredPhrase) {
        throw new AppError(`Type ${requiredPhrase} to confirm this bulk deletion.`, 400);
    }

    const ids = (await getScopedIds(moduleName, payload, actor)).map((record) => String(record._id));
    const failures = [];
    const progress = [];
    let deleted = 0;
    let processed = 0;
    const startedAt = Date.now();

    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
        const batchIds = ids.slice(index, index + BATCH_SIZE);

        for (const id of batchIds) {
            try {
                await deleteOne(moduleName, id, actor);
                deleted += 1;
            } catch (error) {
                failures.push({ id, message: error.message || 'Delete failed' });
            } finally {
                processed += 1;
            }
        }

        progress.push({
            batch: Math.floor(index / BATCH_SIZE) + 1,
            processed,
            deleted,
            failed: failures.length,
        });
    }

    const durationMs = Date.now() - startedAt;
    const log = await BulkDeleteLog.create({
        schoolId: actor.schoolId,
        academicYear: await getCurrentAcademicYear(actor),
        user: getActorId(actor),
        module: moduleName,
        mode,
        filtersUsed: {
            ids: mode === 'filtered' ? normalizeIds(payload.ids) : undefined,
            source: payload.source || null,
        },
        recordsDeleted: deleted,
        failures,
        durationMs,
        progress,
    });

    return {
        module: moduleName,
        mode,
        action: 'delete',
        batchSize: BATCH_SIZE,
        requested: ids.length,
        deleted,
        failed: failures.length,
        failures,
        durationMs,
        progress,
        logId: log._id,
    };
};

module.exports = {
    previewBulkDelete,
    executeBulkDelete,
};
