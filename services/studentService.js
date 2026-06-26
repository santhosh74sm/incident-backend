const fs = require('fs');
const XLSX = require('xlsx');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
const IncidentReadState = require('../models/IncidentReadState');
const IssuedLetter = require('../models/IssuedLetter');
const Log = require('../models/Log');
const Notification = require('../models/Notification');
const { createLog } = require('../utils/logger');
const pick = require('../utils/pick');
const AppError = require('../utils/AppError');
const { generateStudentInitialPassword } = require('./studentAuthService');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { safeSheetToJson } = require('../utils/spreadsheetSecurity');
const { tenantDoc, tenantFilter } = require('../utils/tenant');
const { getCurrentAcademicYear, validateAcademicYear, getAcademicYearQuery } = require('./academicYearService');
const {
    deleteIncidentEvidenceFromS3OrThrow,
    getIncidentEvidenceKeys,
} = require('./s3CleanupService');

const STUDENT_FIELDS = ['admissionNo', 'name', 'className', 'section', 'status'];
const STUDENT_UPLOAD_BATCH_SIZE = 50;
const STUDENT_UPLOAD_MAX_ROWS = 5000;
const STUDENT_REFERENCE_SYNC_CONCURRENCY = 10;

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const normalizeStudentInput = (input = {}) => {
    const normalized = pick(input, STUDENT_FIELDS);
    if (normalized.className === undefined && input.class !== undefined) {
        normalized.className = input.class;
    }
    if (normalized.name !== undefined) normalized.name = String(normalized.name || '').trim();
    if (normalized.admissionNo !== undefined) normalized.admissionNo = normalizeAdmissionNo(normalized.admissionNo);
    if (normalized.className !== undefined) normalized.className = normalizeClassName(normalized.className);
    if (normalized.section !== undefined) normalized.section = normalizeSection(normalized.section);
    return normalized;
};
const normalizeAdmissionNo = (value) => String(value || '').trim();
const normalizeClassName = (value) => String(value || '').trim();
const normalizeSection = (value) => String(value || '').trim().toUpperCase();
const getRowValue = (row, keys = []) => {
    const normalized = new Map(Object.entries(row || {}).map(([key, value]) => [
        String(key || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
        value,
    ]));
    for (const key of keys) {
        const value = normalized.get(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
};

const buildHistoryEntry = ({ academicYear, admissionNo, name, className, section, status = 'Active' }) => ({
    academicYear,
    ...(admissionNo ? { admissionNo } : {}),
    ...(name ? { name } : {}),
    className,
    section,
    status,
    updatedAt: new Date(),
});

const upsertStudentHistory = (history = [], entry) => {
    const existingIndex = history.findIndex((item) => item?.academicYear === entry.academicYear);
    if (existingIndex >= 0) {
        const next = [...history];
        next[existingIndex] = { ...next[existingIndex], ...entry };
        return next;
    }
    return [...history, entry];
};

const hasAcademicYearHistory = (student, academicYear) =>
    student?.academicYear === academicYear
    || (student?.history || []).some((entry) => entry?.academicYear === academicYear);

const getHistoryEntryForYear = (student, academicYear) =>
    (student?.history || []).find((entry) => entry?.academicYear === academicYear) || null;

const projectStudentForAcademicYear = (student, academicYear) => {
    if (!academicYear || String(academicYear).toLowerCase() === 'all') return student;
    const historyEntry = getHistoryEntryForYear(student, academicYear);
    if (!historyEntry && student.academicYear !== academicYear) return null;
    if (historyEntry) {
        return {
            ...student,
            academicYear,
            name: historyEntry.name ?? student.name,
            admissionNo: historyEntry.admissionNo ?? student.admissionNo,
            className: historyEntry.className ?? '',
            section: historyEntry.section ?? '',
            status: historyEntry.status ?? '',
            selectedAcademicYear: academicYear,
        };
    }

    return {
        ...student,
        academicYear,
        name: student.name,
        admissionNo: student.admissionNo,
        className: student.className,
        section: student.section,
        status: student.status,
        selectedAcademicYear: academicYear,
    };
};

const projectStudentRecordsForAcademicYear = (student, academicYear) => {
    if (!academicYear || String(academicYear).toLowerCase() !== 'all') {
        const projected = projectStudentForAcademicYear(student, academicYear);
        return projected ? [projected] : [];
    }

    const recordsByYear = new Map();
    (student?.history || []).forEach((entry) => {
        if (!entry?.academicYear) return;
        recordsByYear.set(entry.academicYear, {
            ...student,
            academicYear: entry.academicYear,
            name: entry.name ?? student.name,
            admissionNo: entry.admissionNo ?? student.admissionNo,
            className: entry.className ?? '',
            section: entry.section ?? '',
            status: entry.status ?? student.status ?? 'Active',
            selectedAcademicYear: entry.academicYear,
        });
    });

    if (student?.academicYear && !recordsByYear.has(student.academicYear)) {
        recordsByYear.set(student.academicYear, {
            ...student,
            selectedAcademicYear: student.academicYear,
        });
    }

    return Array.from(recordsByYear.values());
};

const attachStudentSummaryCounts = async (students, actor, academicYear) => {
    const rows = Array.isArray(students) ? students : [];
    if (rows.length === 0) return rows;

    const admissionNos = [...new Set(rows.map((student) => student?.admissionNo).filter(Boolean))];
    if (admissionNos.length === 0) {
        return rows.map((student) => ({ ...student, incidentCount: 0, letterCount: 0 }));
    }

    const isAllYears = String(academicYear || '').trim().toLowerCase() === 'all';
    const yearScoped = !isAllYears && academicYear;
    const baseMatch = { schoolId: actor.schoolId, admissionNo: { $in: admissionNos } };
    const [incidentCounts, letterCounts] = await Promise.all([
        Incident.aggregate([
            { $match: yearScoped ? { ...baseMatch, academicYear } : baseMatch },
            { $group: { _id: { admissionNo: '$admissionNo', academicYear: '$academicYear' }, count: { $sum: 1 } } },
        ]),
        IssuedLetter.aggregate([
            { $match: yearScoped ? { ...baseMatch, academicYear } : baseMatch },
            { $group: { _id: { admissionNo: '$admissionNo', academicYear: '$academicYear' }, count: { $sum: 1 } } },
        ]),
    ]);

    const toKey = (admissionNo, year) => `${admissionNo || ''}::${year || ''}`;
    const incidentMap = new Map();
    const letterMap = new Map();
    incidentCounts.forEach((entry) => incidentMap.set(toKey(entry._id?.admissionNo, entry._id?.academicYear), entry.count || 0));
    letterCounts.forEach((entry) => letterMap.set(toKey(entry._id?.admissionNo, entry._id?.academicYear), entry.count || 0));

    return rows.map((student) => {
        const year = isAllYears ? student.academicYear : academicYear;
        return {
            ...student,
            incidentCount: incidentMap.get(toKey(student.admissionNo, year)) || 0,
            letterCount: letterMap.get(toKey(student.admissionNo, year)) || 0,
        };
    });
};

const createUploadValidationError = (failedRows = []) => {
    const message = failedRows.length === 1
        ? failedRows[0]
        : `Student upload validation failed. Fix ${failedRows.length} row(s) and upload again.`;
    const error = new AppError(message, 400, 'STUDENT_UPLOAD_VALIDATION_FAILED');
    error.errors = failedRows;
    error.failedRows = failedRows;
    error.failedCount = failedRows.length;
    return error;
};

const validateStudentUploadAcademicYear = (value, currentAcademicYear) => {
    const academicYear = value ? validateAcademicYear(value) : currentAcademicYear;
    if (Number(academicYear.slice(0, 4)) > Number(currentAcademicYear.slice(0, 4))) {
        throw new AppError(`Academic Year cannot be greater than the current school academic year (${currentAcademicYear}).`, 400);
    }
    return academicYear;
};

const buildStudentUpdateForAcademicYear = ({ academicYear, currentAcademicYear = null, existingStudent, input }) => {
    const studentInput = normalizeStudentInput(input);
    const historyEntry = buildHistoryEntry({
        academicYear,
        admissionNo: studentInput.admissionNo ?? existingStudent.admissionNo,
        name: studentInput.name ?? existingStudent.name,
        className: studentInput.className ?? existingStudent.className,
        section: studentInput.section ?? existingStudent.section,
        status: studentInput.status || existingStudent.status || 'Active',
    });
    const identityCorrectedHistory = upsertStudentHistory(existingStudent.history || [], historyEntry)
        .map((entry) => ({
            ...entry,
            ...(studentInput.admissionNo !== undefined ? { admissionNo: studentInput.admissionNo } : {}),
            ...(studentInput.name !== undefined ? { name: studentInput.name } : {}),
        }));

    const update = {
        history: identityCorrectedHistory,
    };

    if (studentInput.name !== undefined) update.name = studentInput.name;
    if (studentInput.admissionNo !== undefined) update.admissionNo = studentInput.admissionNo;

    const shouldUpdateMasterYearFields = !currentAcademicYear || academicYear === currentAcademicYear;
    if (shouldUpdateMasterYearFields) {
        if (studentInput.className !== undefined) update.className = studentInput.className;
        if (studentInput.section !== undefined) update.section = studentInput.section;
        if (studentInput.status !== undefined) update.status = studentInput.status;
        update.academicYear = academicYear;
    }

    return {
        academicYear,
        studentInput,
        update,
    };
};

const buildCurrentYearStudentUpdate = async ({ actor, existingStudent, input }) =>
    buildStudentUpdateForAcademicYear({
        academicYear: await getCurrentAcademicYear(actor),
        existingStudent,
        input,
    });

const buildStudentUpdateQueryForAcademicYear = ({ oldStudent, currentAcademicYear, requestedAcademicYear, input }) => {
    const sourceStudent = typeof oldStudent?.toObject === 'function' ? oldStudent.toObject() : oldStudent;
    const studentInput = normalizeStudentInput(input);
    const targetHistoryEntry = buildHistoryEntry({
        academicYear: requestedAcademicYear,
        admissionNo: studentInput.admissionNo ?? sourceStudent.admissionNo,
        name: studentInput.name ?? sourceStudent.name,
        className: studentInput.className ?? getHistoryEntryForYear(sourceStudent, requestedAcademicYear)?.className ?? sourceStudent.className,
        section: studentInput.section ?? getHistoryEntryForYear(sourceStudent, requestedAcademicYear)?.section ?? sourceStudent.section,
        status: studentInput.status || getHistoryEntryForYear(sourceStudent, requestedAcademicYear)?.status || sourceStudent.status || 'Active',
    });
    const history = upsertStudentHistory(sourceStudent.history || [], targetHistoryEntry)
        .map((entry) => ({
            ...entry,
            ...(studentInput.admissionNo !== undefined ? { admissionNo: studentInput.admissionNo } : {}),
            ...(studentInput.name !== undefined ? { name: studentInput.name } : {}),
        }));
    const update = { history };

    if (studentInput.name !== undefined) update.name = studentInput.name;
    if (studentInput.admissionNo !== undefined) update.admissionNo = studentInput.admissionNo;

    const shouldUpdateMasterYearFields = sourceStudent.academicYear === requestedAcademicYear || currentAcademicYear === requestedAcademicYear;
    if (shouldUpdateMasterYearFields) {
        if (studentInput.className !== undefined) update.className = studentInput.className;
        if (studentInput.section !== undefined) update.section = studentInput.section;
        if (studentInput.status !== undefined) update.status = studentInput.status;
        update.academicYear = requestedAcademicYear;
    }

    return { studentInput, update };
};

const getFilters = async (actor, options = {}) => {
    const currentAcademicYear = await getCurrentAcademicYear(actor);
    const isAllYears = String(options.academicYear || '').trim().toLowerCase() === 'all';
    const selectedAcademicYear = options.academicYear
        ? getAcademicYearQuery(options.academicYear)
        : currentAcademicYear;
    const selectedStatus = normalizeStudentStatusFilter(options.status) || 'Active';
    const match = tenantFilter(actor);
    if (!isAllYears) {
        match.$or = [
            { academicYear: selectedAcademicYear },
            { 'history.academicYear': selectedAcademicYear },
        ];
    }

    const historyRecords = {
        $map: {
            input: {
                $filter: {
                    input: { $ifNull: ['$history', []] },
                    as: 'entry',
                    cond: isAllYears ? true : { $eq: ['$$entry.academicYear', selectedAcademicYear] },
                },
            },
            as: 'entry',
            in: {
                academicYear: '$$entry.academicYear',
                className: { $ifNull: ['$$entry.className', ''] },
                section: { $ifNull: ['$$entry.section', ''] },
                status: isAllYears
                    ? { $ifNull: ['$$entry.status', { $ifNull: ['$status', 'Active'] }] }
                    : { $ifNull: ['$$entry.status', ''] },
            },
        },
    };
    const currentRecord = {
        academicYear: '$academicYear',
        className: '$className',
        section: '$section',
        status: '$status',
    };
    const recordsExpression = isAllYears
        ? {
            $let: {
                vars: { historyRecords },
                in: {
                    $concatArrays: [
                        '$$historyRecords',
                        {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: [{ $ifNull: ['$academicYear', null] }, null] },
                                        { $not: [{ $in: ['$academicYear', '$$historyRecords.academicYear'] }] },
                                    ],
                                },
                                [currentRecord],
                                [],
                            ],
                        },
                    ],
                },
            },
        }
        : {
            $let: {
                vars: { historyRecords },
                in: { $cond: [{ $gt: [{ $size: '$$historyRecords' }, 0] }, '$$historyRecords', [currentRecord]] },
            },
        };

    const [filterValues = { classes: [], sections: [] }] = await Student.aggregate([
        { $match: match },
        { $project: { records: recordsExpression } },
        { $unwind: '$records' },
        { $replaceWith: '$records' },
        { $match: { status: selectedStatus } },
        {
            $group: {
                _id: null,
                classes: { $addToSet: '$className' },
                sections: { $addToSet: '$section' },
            },
        },
    ]);
    const classes = filterValues.classes || [];
    const sections = filterValues.sections || [];

    return {
        classes: classes.filter(Boolean).sort((a, b) => a - b),
        sections: sections.filter(Boolean).sort(),
        currentAcademicYear,
    };
};

const normalizeStudentStatusFilter = (status) => {
    const normalized = String(status || '').trim();
    if (!normalized || normalized.toLowerCase() === 'all') return null;
    if (normalized === 'Active' || normalized === 'Passed Out') return normalized;
    return 'Active';
};

const buildStudentListQuery = ({ className, section, search, status, academicYear, actor } = {}) => {
    const query = tenantFilter(actor);
    const andConditions = [];
    const isAllYears = String(academicYear || '').trim().toLowerCase() === 'all';
    const selectedAcademicYear = academicYear ? getAcademicYearQuery(academicYear) : null;
    const selectedStatus = normalizeStudentStatusFilter(status);
    if (selectedStatus && !selectedAcademicYear && !isAllYears) {
        query.status = selectedStatus;
    } else if (!selectedAcademicYear && !isAllYears) {
        query.status = 'Active';
    }
    if (selectedAcademicYear) {
        andConditions.push({ $or: [
            { academicYear: selectedAcademicYear },
            { 'history.academicYear': selectedAcademicYear },
        ] });
    }
    if (className && !selectedAcademicYear && !isAllYears) query.className = className;
    if (section && !selectedAcademicYear && !isAllYears) query.section = section;

    if (search && search.trim()) {
        const searchTerm = search.trim();
        const safe = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        andConditions.push({ $or: [
            { name: { $regex: safe, $options: 'i' } },
            { admissionNo: { $regex: safe, $options: 'i' } },
        ] });
    }

    if (andConditions.length > 0) {
        query.$and = andConditions;
    }

    return { query, selectedAcademicYear, selectedStatus };
};

const getStudentsByFilter = async ({ className, section, search, page, limit, status, academicYear, actor } = {}) => {
    const effectiveAcademicYear = academicYear !== undefined && academicYear !== null && academicYear !== ''
        ? academicYear
        : await getCurrentAcademicYear(actor);
    const { query, selectedAcademicYear, selectedStatus } = buildStudentListQuery({
        className,
        section,
        search,
        status,
        academicYear: effectiveAcademicYear,
        actor,
    });
    const shouldPaginate = page !== undefined || limit !== undefined;
    if (!shouldPaginate) {
        const students = await Student.find(query).sort({ name: 1 }).lean();
        return students
            .flatMap((student) => projectStudentRecordsForAcademicYear(student, selectedAcademicYear || effectiveAcademicYear))
            .filter((student) => !selectedStatus || student.status === selectedStatus)
            .filter((student) => !className || student.className === className)
            .filter((student) => !section || student.section === section);
    }

    return getAllStudents({ className, section, search, page, limit, status, academicYear: effectiveAcademicYear }, actor);
};

const getAllStudents = async (query = {}, actor = null) => {
    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const includeSummaryCounts = String(query.includeSummaryCounts || query.summaryCounts || '').toLowerCase() === 'true';
    const effectiveAcademicYear = query.academicYear !== undefined && query.academicYear !== null && query.academicYear !== ''
        ? query.academicYear
        : await getCurrentAcademicYear(actor);
    const { query: scopedQuery, selectedAcademicYear, selectedStatus } = buildStudentListQuery({
        status: query.status,
        academicYear: effectiveAcademicYear,
        actor,
    });
    const resolvedAcademicYear = selectedAcademicYear || effectiveAcademicYear;

    // ── Non-paginated path ────────────────────────────────────────────────────
    // Used by /api/students/all (dropdowns, exports, StudentAnalytics full list).
    // Returns a plain array — no pagination wrapper — to preserve every existing
    // caller contract.
    if (!shouldPaginate) {
        let students = (await Student.find(scopedQuery).sort({ name: 1 }).lean())
            .flatMap((student) => projectStudentRecordsForAcademicYear(student, resolvedAcademicYear))
            .filter((student) => !selectedStatus || student.status === selectedStatus);
        if (includeSummaryCounts) {
            students = await attachStudentSummaryCounts(students, actor, resolvedAcademicYear);
        }
        return students;
    }

    const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });
    const isAllYears = String(resolvedAcademicYear || '').toLowerCase() === 'all';
    const listValues = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    const classes = listValues(query.className || query.classes);
    const sections = listValues(query.section || query.sections);
    const postProjectionMatch = {};
    if (selectedStatus) postProjectionMatch.status = selectedStatus;
    if (classes.length) postProjectionMatch.className = { $in: classes };
    if (sections.length) postProjectionMatch.section = { $in: sections };
    if (query.search && String(query.search).trim()) {
        const safeSearch = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        postProjectionMatch.$or = ['name', 'admissionNo', 'className', 'section']
            .map((field) => ({ [field]: { $regex: safeSearch, $options: 'i' } }));
    }

    const historyRecords = {
        $map: {
            input: { $filter: { input: { $ifNull: ['$history', []] }, as: 'entry', cond: isAllYears ? true : { $eq: ['$$entry.academicYear', resolvedAcademicYear] } } },
            as: 'entry',
            in: {
                academicYear: '$$entry.academicYear',
                admissionNo: { $ifNull: ['$$entry.admissionNo', '$admissionNo'] },
                name: { $ifNull: ['$$entry.name', '$name'] },
                className: { $ifNull: ['$$entry.className', ''] },
                section: { $ifNull: ['$$entry.section', ''] },
                status: { $ifNull: ['$$entry.status', '$status'] },
            },
        },
    };
    const currentRecord = {
        academicYear: isAllYears ? '$academicYear' : resolvedAcademicYear,
        admissionNo: '$admissionNo',
        name: '$name',
        className: '$className',
        section: '$section',
        status: '$status',
    };
    const recordsExpression = isAllYears
        ? {
            $let: {
                vars: { historyRecords },
                in: {
                    $concatArrays: [
                        '$$historyRecords',
                        {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: [{ $ifNull: ['$academicYear', null] }, null] },
                                        { $not: [{ $in: ['$academicYear', '$$historyRecords.academicYear'] }] },
                                    ],
                                },
                                [currentRecord],
                                [],
                            ],
                        },
                    ],
                },
            },
        }
        : {
            $let: {
                vars: { historyRecords },
                in: { $cond: [{ $gt: [{ $size: '$$historyRecords' }, 0] }, '$$historyRecords', [currentRecord]] },
            },
        };

    const sortFields = new Set(['name', 'admissionNo', 'className', 'section', 'incidentCount', 'letterCount']);
    const sortBy = sortFields.has(query.sortBy) ? query.sortBy : 'name';
    const sortDirection = String(query.sortDirection || '').toLowerCase() === 'desc' ? -1 : 1;
    const sortSpec = sortBy === 'name'
        ? { name: sortDirection, _id: 1 }
        : { [sortBy]: sortDirection, name: 1, _id: 1 };
    const pipeline = [
        { $match: scopedQuery },
        { $set: { _records: recordsExpression } },
        { $unwind: '$_records' },
        {
            $project: {
                _id: 1,
                admissionNo: '$_records.admissionNo',
                name: '$_records.name',
                className: '$_records.className',
                section: '$_records.section',
                academicYear: '$_records.academicYear',
                selectedAcademicYear: '$_records.academicYear',
                status: '$_records.status',
                tokenVersion: 1,
                mustChangePassword: 1,
            },
        },
        ...(Object.keys(postProjectionMatch).length ? [{ $match: postProjectionMatch }] : []),
    ];

    if (includeSummaryCounts) {
        const countLookup = (from, as) => ({
            $lookup: {
                from,
                let: { admissionNo: '$admissionNo', academicYear: '$academicYear' },
                pipeline: [
                    { $match: { $expr: { $and: [
                        { $eq: ['$schoolId', actor.schoolId] },
                        { $eq: ['$admissionNo', '$$admissionNo'] },
                        { $eq: ['$academicYear', '$$academicYear'] },
                    ] } } },
                    { $count: 'count' },
                ],
                as,
            },
        });
        pipeline.push(
            countLookup(Incident.collection.name, '_incidentCounts'),
            countLookup(IssuedLetter.collection.name, '_letterCounts'),
            { $set: {
                incidentCount: { $ifNull: [{ $arrayElemAt: ['$_incidentCounts.count', 0] }, 0] },
                letterCount: { $ifNull: [{ $arrayElemAt: ['$_letterCounts.count', 0] }, 0] },
            } },
            { $unset: ['_incidentCounts', '_letterCounts'] }
        );
    }

    pipeline.push(
        { $sort: sortSpec },
        { $facet: {
            data: [{ $skip: pagination.skip }, { $limit: pagination.limit }],
            summary: [{ $group: {
                _id: null,
                total: { $sum: 1 },
                incidentCount: { $sum: { $ifNull: ['$incidentCount', 0] } },
                letterCount: { $sum: { $ifNull: ['$letterCount', 0] } },
            } }],
        } }
    );

    const [result = { data: [], summary: [] }] = await Student.aggregate(pipeline).allowDiskUse(true);
    const summary = result.summary[0] || { total: 0, incidentCount: 0, letterCount: 0 };
    const paginationMeta = buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total: summary.total });
    return {
        data: result.data,
        total: summary.total,
        page: pagination.page,
        pages: paginationMeta.totalPages,
        pagination: paginationMeta,
        summary,
    };
};

const buildStudentsFromUploadRows = async (rows, actor) => {
    const generatedCredentials = [];

    const students = await Promise.all(rows.map(async (row) => {
        const credentials = await generateStudentInitialPassword();
        const admissionNo = row.admissionNo.toString();

        generatedCredentials.push({
            admissionNo,
            tempPassword: credentials.plaintext,
        });

        return {
            schoolId: actor.schoolId,
            admissionNo,
            name: row.name,
            className: normalizeClassName(row.class),
            section: normalizeSection(row.section),
            academicYear: row.academicYear,
            history: [buildHistoryEntry({
                academicYear: row.academicYear,
                admissionNo,
                name: row.name,
                className: normalizeClassName(row.class),
                section: normalizeSection(row.section),
            })],
            password: credentials.hash,
            mustChangePassword: true,
        };
    }));

    return { students, generatedCredentials };
};

const uploadStudents = async ({ filePath, actor, uploadAcademicYear = null }) => {
    if (!filePath) {
        throw new AppError('No file uploaded. Please attach an Excel file.', 400);
    }

    try {
        const workbook = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false, cellNF: false });
        const data = safeSheetToJson(XLSX, workbook.Sheets[workbook.SheetNames[0]]);

        if (!data || data.length === 0) {
            throw new AppError('Excel file is empty or has no valid rows.', 400);
        }
        if (data.length > STUDENT_UPLOAD_MAX_ROWS) {
            throw new AppError(`Student uploads are limited to ${STUDENT_UPLOAD_MAX_ROWS} rows per file. Split this file into smaller batches.`, 400);
        }

        const validRows = data
            .map((row) => ({
                rowNum: row.__rowNum || row.__rowNumber || null,
                admissionNo: getRowValue(row, ['admissionNo', 'admissionNumber', 'admission no']),
                name: getRowValue(row, ['name', 'studentName', 'student name']),
                class: getRowValue(row, ['class', 'className']),
                section: getRowValue(row, ['section']),
            }))
            .filter((row) => row.admissionNo != null);
        if (validRows.length === 0) {
            throw new AppError('No valid rows with admissionNo found in the file.', 400);
        }

        const admissionNumbers = validRows.map((row) => normalizeAdmissionNo(row.admissionNo)).filter(Boolean);
        
        // Use lean() for fast pre-upload checks
        const existingStudents = await Student.find(tenantFilter(actor, {
            admissionNo: { $in: admissionNumbers },
        })).select('schoolId admissionNo name className section academicYear status history password').lean();

        const existingByAdmission = new Map(existingStudents.map((s) => [s.admissionNo, s]));
        const seenInExcel = new Set();
        const finalValidRows = [];
        const failedRows = [];
        const currentAcademicYear = await getCurrentAcademicYear(actor);
        let defaultAcademicYear = currentAcademicYear;

        try {
            defaultAcademicYear = validateStudentUploadAcademicYear(uploadAcademicYear, currentAcademicYear);
        } catch (error) {
            throw createUploadValidationError([error.message]);
        }

        for (let i = 0; i < validRows.length; i++) {
            const row = validRows[i];
            const rowNum = i + 2;
            const admNo = normalizeAdmissionNo(row.admissionNo);
            if (!admNo) {
                failedRows.push(`Row ${rowNum}: Admission Number is required`);
                continue;
            }
            if (!row.name || !row.class || !row.section) {
                failedRows.push(`Row ${rowNum}: Name, Class, and Section are required`);
                continue;
            }
            let academicYear;
            try {
                academicYear = validateStudentUploadAcademicYear(defaultAcademicYear, currentAcademicYear);
            } catch (error) {
                failedRows.push(`Row ${rowNum}: ${error.message}`);
                continue;
            }
            
            if (seenInExcel.has(`${admNo}:${academicYear}`)) {
                failedRows.push(`Row ${rowNum}: Duplicate admission number ${admNo} for academic year ${academicYear} in this upload.`);
            } else if (hasAcademicYearHistory(existingByAdmission.get(admNo), academicYear)) {
                failedRows.push(`Row ${rowNum}: A duplicate academic year record exists for admission number ${admNo} in ${academicYear}. Update the student through User Management.`);
            } else {
                seenInExcel.add(`${admNo}:${academicYear}`);
                finalValidRows.push({ ...row, admissionNo: admNo, academicYear });
            }
        }

        if (failedRows.length > 0) {
            throw createUploadValidationError(failedRows);
        }

        if (finalValidRows.length === 0 && data.length > 0) {
            throw new AppError('No valid new students to insert. All rows are duplicates or invalid.', 400);
        }

        for (let i = 0; i < finalValidRows.length; i++) {
            try {
                finalValidRows[i].academicYear = validateStudentUploadAcademicYear(finalValidRows[i].academicYear, currentAcademicYear);
            } catch (error) {
                throw createUploadValidationError([`Row ${finalValidRows[i].rowNum || i + 2}: ${error.message}`]);
            }
        }

        let insertedCount = 0;
        let updatedCount = 0;
        const generatedCredentials = [];

        for (let batchStart = 0; batchStart < finalValidRows.length; batchStart += STUDENT_UPLOAD_BATCH_SIZE) {
            const batch = finalValidRows.slice(batchStart, batchStart + STUDENT_UPLOAD_BATCH_SIZE);
            const prepared = await Promise.all(batch.map(async (row, batchIndex) => {
                const className = normalizeClassName(row.class);
                const section = normalizeSection(row.section);
                const existing = existingByAdmission.get(row.admissionNo);
                if (existing) {
                    const { update } = buildStudentUpdateForAcademicYear({
                        academicYear: row.academicYear,
                        currentAcademicYear,
                        existingStudent: existing,
                        input: { name: row.name, className, section, status: 'Active' },
                    });
                    return { row, batchIndex, type: 'update', existing, update };
                }

                const credentials = await generateStudentInitialPassword();
                return {
                    row,
                    batchIndex,
                    type: 'insert',
                    credentials,
                    document: {
                        schoolId: actor.schoolId,
                        admissionNo: row.admissionNo,
                        name: row.name,
                        className,
                        section,
                        academicYear: row.academicYear,
                        history: [buildHistoryEntry({ academicYear: row.academicYear, admissionNo: row.admissionNo, name: row.name, className, section })],
                        password: credentials.hash,
                        mustChangePassword: true,
                    },
                };
            }));
            const operations = prepared.map((entry) => entry.type === 'update'
                ? { updateOne: { filter: tenantFilter(actor, { admissionNo: entry.row.admissionNo }), update: { $set: entry.update }, runValidators: true } }
                : { insertOne: { document: entry.document } });
            const failedOperationIndexes = new Set();
            try {
                await Student.bulkWrite(operations, { ordered: false });
            } catch (error) {
                const writeErrors = error?.writeErrors || error?.result?.getWriteErrors?.() || [];
                if (!writeErrors.length) throw error;
                const hasWriteConcernFailure = Boolean(
                    error?.writeConcernError
                    || error?.result?.getWriteConcernError?.()
                    || error?.result?.getWriteConcernErrors?.()?.length
                );
                if (hasWriteConcernFailure) throw error;
                writeErrors.forEach((writeError) => {
                    const index = Number(writeError.index);
                    if (!Number.isInteger(index) || !prepared[index]) throw error;
                    failedOperationIndexes.add(index);
                    const row = prepared[index].row;
                    failedRows.push(`Row ${row?.rowNum || batchStart + index + 2}: ${writeError.errmsg || writeError.message || 'Database write failed'}`);
                });
            }

            const referenceSyncEntries = [];
            prepared.forEach((entry, index) => {
                if (failedOperationIndexes.has(index)) return;
                if (entry.type === 'insert') {
                    generatedCredentials.push({ admissionNo: entry.row.admissionNo, tempPassword: entry.credentials.plaintext });
                    existingByAdmission.set(entry.row.admissionNo, entry.document);
                    insertedCount += 1;
                    return;
                }
                const updatedExisting = { ...entry.existing, ...entry.update, schoolId: entry.existing.schoolId || actor.schoolId, history: entry.update.history };
                existingByAdmission.set(entry.row.admissionNo, updatedExisting);
                referenceSyncEntries.push({ oldStudent: entry.existing, updatedStudent: updatedExisting, row: entry.row });
                updatedCount += 1;
            });
            for (let syncStart = 0; syncStart < referenceSyncEntries.length; syncStart += STUDENT_REFERENCE_SYNC_CONCURRENCY) {
                const syncBatch = referenceSyncEntries.slice(syncStart, syncStart + STUDENT_REFERENCE_SYNC_CONCURRENCY);
                const results = await Promise.allSettled(syncBatch.map((entry) => syncStudentReferences(entry.oldStudent, entry.updatedStudent)));
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        const entry = syncBatch[index];
                        failedRows.push(`Row ${entry.row?.rowNum || batchStart + syncStart + index + 2}: Student saved, but related records could not be synchronized (${result.reason?.message || 'unknown error'}).`);
                    }
                });
            }
        }

        createLog(
            'STUDENT_BULK_UPLOAD',
            actor,
            'Student',
            null,
            {
                targetLabel: `${insertedCount} students imported, ${updatedCount} students updated`,
                Count: insertedCount + updatedCount,
                insertedCount,
                updatedCount,
                Action: 'Upsert',
                summary: true,
                uploadType: 'Student',
                academicYear: currentAcademicYear,
            }
        );

        return { 
            message: `Successfully processed upload. Inserted ${insertedCount} and updated ${updatedCount} student(s).`, 
            generatedCredentials,
            failedRows: failedRows.length > 0 ? failedRows : undefined,
            failedCount: failedRows.length
        };
    } finally {
        if (filePath) {
            fs.unlink(filePath, () => {});
        }
    }
};

const getStudentDeleteImpact = async ({ student, actor }) => {
    const schoolId = actor.schoolId;
    const studentId = student._id;
    const admissionNo = String(student.admissionNo || '').trim();
    const studentName = String(student.name || '').trim();
    const studentMatchConditions = [
        { student: studentId },
        ...(admissionNo ? [{ admissionNo }] : []),
        ...(studentName ? [{ studentsInvolved: studentName }] : []),
    ];
    const incidentMatch = { schoolId, $or: studentMatchConditions };
    const relatedIncidents = await Incident.find(incidentMatch).select('_id evidence').lean();
    const incidentIds = relatedIncidents.map((incident) => incident._id);
    const evidenceFileCount = relatedIncidents.reduce(
        (total, incident) => total + getIncidentEvidenceKeys(incident).length,
        0
    );
    const letterMatch = {
        schoolId,
        $or: [
            ...(admissionNo ? [{ admissionNo }] : []),
            ...(incidentIds.length > 0 ? [{ incident: { $in: incidentIds } }] : []),
        ],
    };
    const notificationMatch = {
        schoolId,
        $or: [
            ...(incidentIds.length > 0 ? [{ incident: { $in: incidentIds } }] : []),
            { entityId: String(studentId) },
            ...(admissionNo ? [
                { targetAdmissionNumber: admissionNo },
                { 'studentDetails.admissionNo': admissionNo },
                { routePath: `/student-analytics/${admissionNo}` },
            ] : []),
        ],
    };
    const logMatch = {
        schoolId,
        $or: [
            { entityId: String(studentId) },
            ...(admissionNo ? [
                { 'metadata.targetAdmissionNumber': admissionNo },
                { 'metadata.admissionNo': admissionNo },
                { 'metadata.studentAdmissionNumber': admissionNo },
                { 'metadata.studentDetails.admissionNo': admissionNo },
                { 'metadata.routePath': `/student-analytics/${admissionNo}` },
            ] : []),
        ],
    };

    const [issuedLetterCount, notificationCount, logCount, readStateCount] = await Promise.all([
        letterMatch.$or.length ? IssuedLetter.countDocuments(letterMatch) : 0,
        notificationMatch.$or.length ? Notification.countDocuments(notificationMatch) : 0,
        logMatch.$or.length ? Log.countDocuments(logMatch) : 0,
        incidentIds.length ? IncidentReadState.countDocuments({ schoolId, incident: { $in: incidentIds } }) : 0,
    ]);

    return {
        studentId,
        admissionNo,
        incidentIds,
        relatedIncidents,
        incidentMatch,
        letterMatch,
        notificationMatch,
        logMatch,
        counts: {
            students: 1,
            incidents: relatedIncidents.length,
            evidenceFiles: evidenceFileCount,
            issuedLetters: issuedLetterCount,
            notifications: notificationCount,
            logs: logCount,
            incidentReadStates: readStateCount,
        },
    };
};

const deleteStudent = async ({ studentId, actor }) => {
    const student = await Student.findOne(tenantFilter(actor, { _id: studentId })).lean();
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const impact = await getStudentDeleteImpact({ student, actor });
    const session = await Student.startSession();
    let evidenceReferencesDeleted = { modifiedCount: 0 };
    let readStatesDeleted = { deletedCount: 0 };
    let incidentsDeleted = { deletedCount: 0 };
    let lettersDeleted = { deletedCount: 0 };
    let notificationsDeleted = { deletedCount: 0 };
    let logsDeleted = { deletedCount: 0 };
    let studentsDeleted = { deletedCount: 0 };
    const evidenceKeys = getIncidentEvidenceKeys(impact.relatedIncidents);

    try {
        await session.withTransaction(async () => {
            evidenceReferencesDeleted = impact.incidentIds.length
                ? await Incident.updateMany(impact.incidentMatch, { $set: { evidence: [] } }, { session })
                : { modifiedCount: 0 };
            readStatesDeleted = impact.incidentIds.length
                ? await IncidentReadState.deleteMany(
                    { schoolId: actor.schoolId, incident: { $in: impact.incidentIds } },
                    { session }
                )
                : { deletedCount: 0 };
            incidentsDeleted = await Incident.deleteMany(impact.incidentMatch, { session });
            lettersDeleted = impact.letterMatch.$or.length
                ? await IssuedLetter.deleteMany(impact.letterMatch, { session })
                : { deletedCount: 0 };
            notificationsDeleted = impact.notificationMatch.$or.length
                ? await Notification.deleteMany(impact.notificationMatch, { session })
                : { deletedCount: 0 };
            logsDeleted = impact.logMatch.$or.length
                ? await Log.deleteMany(impact.logMatch, { session })
                : { deletedCount: 0 };
            studentsDeleted = await Student.deleteOne(tenantFilter(actor, { _id: studentId }), { session });

            const deletedRecords = {
                students: studentsDeleted.deletedCount || 0,
                incidents: incidentsDeleted.deletedCount || 0,
                evidenceFiles: evidenceKeys.length,
                evidenceReferences: evidenceReferencesDeleted.modifiedCount ? impact.counts.evidenceFiles : 0,
                issuedLetters: lettersDeleted.deletedCount || 0,
                notifications: notificationsDeleted.deletedCount || 0,
                logs: logsDeleted.deletedCount || 0,
                incidentReadStates: readStatesDeleted.deletedCount || 0,
            };

            await Log.create([{
                schoolId: actor.schoolId,
                academicYear: student.academicYear,
                actionName: 'STUDENT_PERMANENTLY_DELETED',
                performedBy: String(getActorId(actor)),
                entityType: 'System',
                entityId: null,
                targetLabel: student.name,
                metadata: {
                    Name: student.name,
                    'Admission Number': student.admissionNo,
                    Role: 'Student',
                    targetLabel: student.name,
                    targetAdmissionNumber: student.admissionNo,
                    admissionNo: student.admissionNo,
                    academicYear: student.academicYear,
                    affectedRecords: impact.counts,
                    deletedRecords,
                },
            }], { ordered: true, session });
        });
    } finally {
        await session.endSession();
    }

    const evidenceDeleted = evidenceKeys.length
        ? await deleteIncidentEvidenceFromS3OrThrow(impact.relatedIncidents, {
            operation: 'deleteStudent',
            schoolId: actor.schoolId,
            studentId,
            admissionNo: student.admissionNo,
        })
        : { deletedKeys: [] };

    return {
        message: 'Student deleted successfully.',
        affectedRecords: impact.counts,
        deletedRecords: {
            students: studentsDeleted.deletedCount || 0,
            incidents: incidentsDeleted.deletedCount || 0,
            evidenceFiles: evidenceDeleted.deletedKeys.length,
            evidenceReferences: evidenceReferencesDeleted.modifiedCount ? impact.counts.evidenceFiles : 0,
            issuedLetters: lettersDeleted.deletedCount || 0,
            notifications: notificationsDeleted.deletedCount || 0,
            logs: logsDeleted.deletedCount || 0,
            incidentReadStates: readStatesDeleted.deletedCount || 0,
        },
    };
};

const previewStudentDelete = async ({ studentId, actor }) => {
    const student = await Student.findOne(tenantFilter(actor, { _id: studentId })).lean();
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const impact = await getStudentDeleteImpact({ student, actor });
    return {
        student: {
            _id: student._id,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
            section: student.section,
            academicYear: student.academicYear,
            status: student.status,
        },
        affectedRecords: impact.counts,
    };
};

const createStudent = async ({ input, actor }) => {
    const studentInput = normalizeStudentInput(input);
    const academicYear = await getCurrentAcademicYear(actor);
    const existingStudent = await Student.findOne(tenantFilter(actor, { admissionNo: studentInput.admissionNo })).select('_id').lean();

    if (existingStudent) {
        throw new AppError('Admission Number already exists. Duplicate IDs are not allowed.', 400);
    }

    const credentials = await generateStudentInitialPassword();
    const student = await Student.create({
        ...tenantDoc(actor),
        ...studentInput,
        academicYear,
        history: [buildHistoryEntry({
            academicYear,
            admissionNo: studentInput.admissionNo,
            name: studentInput.name,
            className: studentInput.className,
            section: studentInput.section,
            status: studentInput.status || 'Active',
        })],
        password: credentials.hash,
        mustChangePassword: true,
    });

    createLog(
        'STUDENT_REGISTER',
        actor,
        'Student',
        student._id,
        {
            Name: student.name,
            'Admission Number': student.admissionNo,
            Role: 'Student',
            targetLabel: student.name,
            targetAdmissionNumber: student.admissionNo,
            admissionNo: student.admissionNo,
            routePath: `/student-analytics/${student.admissionNo}`,
            academicYear,
        },
        {
            type: 'STUDENT_REGISTERED',
            recipientRoles: ['Super Admin', 'Admin'],
            targetLabel: student.name,
            targetAdmissionNumber: student.admissionNo,
            routePath: `/student-analytics/${student.admissionNo}`,
        }
    );

    return {
        ...student.toObject(),
        initialPassword: credentials.plaintext,
    };
};

const getStudentBehavioralSummary = async (studentId, actor) => {
    const student = await Student.findOne(tenantFilter(actor, { _id: studentId })).lean();
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const [incidents, lettersCount] = await Promise.all([
        Incident.find(tenantFilter(actor, { admissionNo: student.admissionNo })).sort({ createdAt: -1 }).lean(),
        IssuedLetter.countDocuments(tenantFilter(actor, { admissionNo: student.admissionNo })),
    ]);

    const categoryBreakdown = {};
    incidents.forEach((incident) => {
        if (incident.category) {
            categoryBreakdown[incident.category] = (categoryBreakdown[incident.category] || 0) + 1;
        }
    });

    const totalIncidents = incidents.length;
    const riskLevel = totalIncidents >= 3 || lettersCount >= 2
        ? 'Red'
        : totalIncidents >= 1 || lettersCount >= 1
            ? 'Yellow'
            : 'Green';

    return {
        totalIncidents,
        totalLetters: lettersCount,
        categoryBreakdown,
        riskLevel,
        lastIncident: incidents[0] || null,
        studentName: student.name,
        admissionNo: student.admissionNo,
        className: student.className,
        section: student.section,
        academicYear: student.academicYear,
        status: student.status,
        history: student.history || [],
    };
};

const syncStudentReferences = async (oldStudent, updatedStudent, options = {}) => {
    const oldAdmissionNo = String(oldStudent?.admissionNo || '').trim();
    const newAdmissionNo = String(updatedStudent?.admissionNo || '').trim();
    const oldName = String(oldStudent?.name || '').trim();
    const newName = String(updatedStudent?.name || '').trim();
    const oldClassName = String(options.oldClassName ?? oldStudent?.className ?? '').trim();
    const newClassName = String(updatedStudent?.className || '').trim();
    const oldSection = String(options.oldSection ?? oldStudent?.section ?? '').trim();
    const newSection = String(updatedStudent?.section || '').trim();
    const currentAcademicYear = options.academicYear || updatedStudent?.academicYear;
    const schoolId = updatedStudent?.schoolId || oldStudent?.schoolId;
    const studentId = updatedStudent?._id || oldStudent?._id;

    const nameChanged = oldName !== newName;
    const admissionChanged = oldAdmissionNo !== newAdmissionNo;
    const classChanged = oldClassName !== newClassName;
    const sectionChanged = oldSection !== newSection;
    const admissionValues = [...new Set([oldAdmissionNo, newAdmissionNo].filter(Boolean))];
    const studentMatch = {
        schoolId,
        $or: [
            ...(studentId ? [{ student: studentId }] : []),
            ...(admissionValues.length > 0 ? [{ admissionNo: { $in: admissionValues } }] : []),
        ],
    };

    if (!schoolId || (!nameChanged && !admissionChanged && !classChanged && !sectionChanged)) {
        return {
            admissionNo: newAdmissionNo,
            academicYear: currentAcademicYear,
            className: newClassName,
            section: newSection,
            currentHistoryUpdated: (updatedStudent.history || []).some(
                (entry) =>
                    entry?.academicYear === currentAcademicYear
                    && entry?.className === newClassName
                    && entry?.section === newSection
            ),
            incidentsModified: 0,
            issuedLettersModified: 0,
            notificationsModified: 0,
            logsModified: 0,
        };
    }

    const globalIncidentSet = {};
    const globalLetterSet = {};
    const globalNotificationSet = {};
    const globalLogSet = {};

    if (nameChanged) {
        globalIncidentSet.studentsInvolved = [newName];
        globalIncidentSet['studentSnapshot.name'] = newName;
        globalLetterSet.studentName = newName;
        globalNotificationSet['studentDetails.studentsInvolved'] = [newName];
        globalLogSet['metadata.studentName'] = newName;
        globalLogSet['metadata.studentDetails.studentsInvolved'] = [newName];
    }

    if (admissionChanged) {
        globalIncidentSet.admissionNo = newAdmissionNo;
        globalIncidentSet['studentSnapshot.admissionNo'] = newAdmissionNo;
        globalLetterSet.admissionNo = newAdmissionNo;
        globalNotificationSet.targetAdmissionNumber = newAdmissionNo;
        globalNotificationSet['studentDetails.admissionNo'] = newAdmissionNo;
        globalLogSet['metadata.targetAdmissionNumber'] = newAdmissionNo;
        globalLogSet['metadata.admissionNo'] = newAdmissionNo;
        globalLogSet['metadata.studentAdmissionNumber'] = newAdmissionNo;
        globalLogSet['metadata.studentDetails.admissionNo'] = newAdmissionNo;
    }

    const currentYearSet = {};
    const currentYearLetterSet = {};
    const currentYearNotificationSet = {};
    const currentYearLogSet = {};

    if (classChanged) {
        currentYearSet.class = newClassName;
        currentYearSet['studentSnapshot.className'] = newClassName;
        currentYearLetterSet.className = newClassName;
        currentYearNotificationSet['studentDetails.class'] = newClassName;
        currentYearLogSet['metadata.class'] = newClassName;
        currentYearLogSet['metadata.className'] = newClassName;
        currentYearLogSet['metadata.studentDetails.class'] = newClassName;
    }

    if (sectionChanged) {
        currentYearSet.section = newSection;
        currentYearSet['studentSnapshot.section'] = newSection;
        currentYearLetterSet.section = newSection;
        currentYearNotificationSet['studentDetails.section'] = newSection;
        currentYearLogSet['metadata.section'] = newSection;
        currentYearLogSet['metadata.studentDetails.section'] = newSection;
    }

    const allIncidentIds = (nameChanged || admissionChanged)
        ? await Incident.find(studentMatch).distinct('_id')
        : [];
    const scopedIncidentIds = currentAcademicYear
        ? await Incident.find({ ...studentMatch, academicYear: currentAcademicYear }).distinct('_id')
        : [];

    const ops = [];
    if (Object.keys(globalIncidentSet).length > 0) {
        ops.push(Incident.updateMany(studentMatch, { $set: globalIncidentSet }));
    }
    if (Object.keys(currentYearSet).length > 0 && currentAcademicYear) {
        ops.push(Incident.updateMany(
            { ...studentMatch, academicYear: currentAcademicYear },
            { $set: currentYearSet }
        ));
    }

    if (Object.keys(globalLetterSet).length > 0 && admissionValues.length > 0) {
        ops.push(IssuedLetter.updateMany(
            { schoolId, admissionNo: { $in: admissionValues } },
            { $set: globalLetterSet }
        ));
    }
    if (Object.keys(currentYearLetterSet).length > 0 && currentAcademicYear && admissionValues.length > 0) {
        ops.push(IssuedLetter.updateMany(
            { schoolId, admissionNo: { $in: admissionValues }, academicYear: currentAcademicYear },
            { $set: currentYearLetterSet }
        ));
    }

    if (Object.keys(globalNotificationSet).length > 0) {
        const notificationConditions = [];
        if (allIncidentIds.length > 0) notificationConditions.push({ incident: { $in: allIncidentIds } });
        if (scopedIncidentIds.length > 0) notificationConditions.push({ incident: { $in: scopedIncidentIds } });
        if (admissionValues.length > 0) {
            notificationConditions.push(
                { targetAdmissionNumber: { $in: admissionValues } },
                { 'studentDetails.admissionNo': { $in: admissionValues } }
            );
        }
        if (notificationConditions.length > 0) {
            ops.push(Notification.updateMany(
                { schoolId, $or: notificationConditions },
                { $set: globalNotificationSet }
            ));
        }
    }
    if (Object.keys(currentYearNotificationSet).length > 0 && scopedIncidentIds.length > 0) {
        ops.push(Notification.updateMany(
            { schoolId, incident: { $in: scopedIncidentIds } },
            { $set: currentYearNotificationSet }
        ));
    }

    if (Object.keys(globalLogSet).length > 0 && admissionValues.length > 0) {
        ops.push(Log.updateMany(
            {
                schoolId,
                $or: [
                    { 'metadata.targetAdmissionNumber': { $in: admissionValues } },
                    { 'metadata.admissionNo': { $in: admissionValues } },
                    { 'metadata.studentAdmissionNumber': { $in: admissionValues } },
                    { 'metadata.studentDetails.admissionNo': { $in: admissionValues } },
                ],
            },
            { $set: globalLogSet }
        ));
    }
    if (Object.keys(currentYearLogSet).length > 0 && currentAcademicYear && admissionValues.length > 0) {
        ops.push(Log.updateMany(
            {
                schoolId,
                academicYear: currentAcademicYear,
                $or: [
                    { 'metadata.targetAdmissionNumber': { $in: admissionValues } },
                    { 'metadata.admissionNo': { $in: admissionValues } },
                    { 'metadata.studentAdmissionNumber': { $in: admissionValues } },
                    { 'metadata.studentDetails.admissionNo': { $in: admissionValues } },
                ],
            },
            { $set: currentYearLogSet }
        ));
    }

    const results = await Promise.all(ops);
    const modifiedByCollection = results.reduce((acc, result) => {
        acc.total += result.modifiedCount || 0;
        return acc;
    }, { total: 0 });

    return {
        admissionNo: newAdmissionNo,
        academicYear: currentAcademicYear,
        className: newClassName,
        section: newSection,
        currentHistoryUpdated: (updatedStudent.history || []).some(
            (entry) =>
                entry?.academicYear === currentAcademicYear
                && entry?.className === newClassName
                && entry?.section === newSection
        ),
        modifiedReferences: modifiedByCollection.total,
        allIncidentIds: allIncidentIds.map((id) => String(id)),
        currentYearIncidentIds: scopedIncidentIds.map((id) => String(id)),
    };
};

const updateStudent = async ({ studentId, input, actor }) => {
    const oldStudent = await Student.findOne(tenantFilter(actor, { _id: studentId }));
    if (!oldStudent) {
        throw new AppError('Student not found', 404);
    }

    const currentAcademicYear = await getCurrentAcademicYear(actor);
    const requestedAcademicYear = input?.academicYear
        ? validateAcademicYear(input.academicYear)
        : currentAcademicYear;
    const { studentInput, update } = buildStudentUpdateQueryForAcademicYear({
        oldStudent,
        currentAcademicYear,
        requestedAcademicYear,
        input,
    });

    if (studentInput.admissionNo) {
        const existingStudent = await Student.findOne({
            schoolId: actor.schoolId,
            admissionNo: studentInput.admissionNo,
            _id: { $ne: studentId },
        }).select('_id').lean();

        if (existingStudent) {
            throw new AppError('This Admission Number is already assigned to another student.', 400);
        }
    }

    const updatedStudent = await Student.findOneAndUpdate(
        tenantFilter(actor, { _id: studentId }),
        { $set: update },
        { new: true, runValidators: true }
    );

    if (!updatedStudent) {
        throw new AppError('Student not found', 404);
    }

    const selectedYearBefore = projectStudentForAcademicYear(oldStudent.toObject(), requestedAcademicYear) || oldStudent.toObject();

    await syncStudentReferences(oldStudent, {
        ...updatedStudent.toObject(),
        className: studentInput.className ?? oldStudent.className,
        section: studentInput.section ?? oldStudent.section,
    }, {
        academicYear: requestedAcademicYear,
        oldClassName: selectedYearBefore.className,
        oldSection: selectedYearBefore.section,
    });

    const oldStatus = oldStudent.status;
    const nextStatus = updatedStudent.status;
    const statusAction = oldStatus === 'Passed Out' && nextStatus === 'Active'
        ? 'STUDENT_REACTIVATED'
        : oldStatus !== 'Passed Out' && nextStatus === 'Passed Out'
            ? 'STUDENT_PASSED_OUT'
            : 'STUDENT_UPDATED';

    createLog(
        statusAction,
        actor,
        'Student',
        updatedStudent._id,
        {
            Name: updatedStudent.name,
            'Admission Number': updatedStudent.admissionNo,
            academicYear: requestedAcademicYear,
            previousStatus: oldStatus,
            status: nextStatus,
        }
    );

    return projectStudentForAcademicYear(updatedStudent.toObject(), requestedAcademicYear) || updatedStudent;
};

module.exports = {
    getFilters,
    getStudentsByFilter,
    getAllStudents,
    uploadStudents,
    previewStudentDelete,
    deleteStudent,
    createStudent,
    updateStudent,
    getStudentBehavioralSummary,
    _private: {
        buildStudentUpdateForAcademicYear,
        buildStudentUpdateQueryForAcademicYear,
        buildStudentListQuery,
        projectStudentForAcademicYear,
        hasAcademicYearHistory,
        createUploadValidationError,
        syncStudentReferences,
        getStudentDeleteImpact,
    },
};
