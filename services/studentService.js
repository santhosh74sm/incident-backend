const fs = require('fs');
const XLSX = require('xlsx');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
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

const STUDENT_FIELDS = ['admissionNo', 'name', 'className', 'section', 'status'];

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

    return {
        ...student,
        academicYear,
        name: historyEntry?.name || student.name,
        admissionNo: historyEntry?.admissionNo || student.admissionNo,
        className: historyEntry?.className || student.className,
        section: historyEntry?.section || student.section,
        status: historyEntry?.status || student.status,
        selectedAcademicYear: academicYear,
    };
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

const buildStudentUpdateForAcademicYear = ({ academicYear, existingStudent, input }) => {
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

    return {
        academicYear,
        studentInput,
        update: {
            ...studentInput,
            academicYear,
            history: identityCorrectedHistory,
        },
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

const getFilters = async (actor) => {
    const currentAcademicYear = await getCurrentAcademicYear(actor);
    const [classes, sections] = await Promise.all([
        Student.distinct('className', tenantFilter(actor, { academicYear: currentAcademicYear, status: 'Active' })),
        Student.distinct('section', tenantFilter(actor, { academicYear: currentAcademicYear, status: 'Active' })),
    ]);

    return {
        classes: classes.filter(Boolean).sort((a, b) => a - b),
        sections: sections.filter(Boolean).sort(),
        currentAcademicYear,
    };
};

const buildStudentListQuery = ({ className, section, search, includeArchived, academicYear, actor } = {}) => {
    const query = tenantFilter(actor);
    const andConditions = [];
    const selectedAcademicYear = academicYear ? getAcademicYearQuery(academicYear) : null;
    if (String(includeArchived || '').toLowerCase() !== 'true') {
        query.status = 'Active';
    }
    if (selectedAcademicYear) {
        andConditions.push({ $or: [
            { academicYear: selectedAcademicYear },
            { 'history.academicYear': selectedAcademicYear },
        ] });
    }
    if (className && !selectedAcademicYear) query.className = className;
    if (section && !selectedAcademicYear) query.section = section;

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

    return { query, selectedAcademicYear };
};

const getStudentsByFilter = async ({ className, section, search, page, limit, includeArchived, academicYear, actor } = {}) => {
    const { query, selectedAcademicYear } = buildStudentListQuery({
        className,
        section,
        search,
        includeArchived,
        academicYear,
        actor,
    });
    const shouldPaginate = page !== undefined || limit !== undefined;
    if (!shouldPaginate) {
        const students = await Student.find(query).sort({ name: 1 }).lean();
        return students
            .map((student) => projectStudentForAcademicYear(student, selectedAcademicYear))
            .filter(Boolean)
            .filter((student) => !className || student.className === className)
            .filter((student) => !section || student.section === section);
    }

    const pagination = getPagination({ page, limit }, { defaultLimit: 20, maxLimit: 100 });
    const allStudents = (await Student.find(query).sort({ name: 1 }).lean())
        .map((student) => projectStudentForAcademicYear(student, selectedAcademicYear))
        .filter(Boolean)
        .filter((student) => !className || student.className === className)
        .filter((student) => !section || student.section === section);
    const students = allStudents.slice(pagination.skip, pagination.skip + pagination.limit);
    const total = allStudents.length;

    return {
        data: students,
        pagination: buildPaginationMeta({
            page: pagination.page,
            limit: pagination.limit,
            total,
        }),
    };
};

const getAllStudents = async (query = {}, actor = null) => {
    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const { query: scopedQuery, selectedAcademicYear } = buildStudentListQuery({
        includeArchived: query.includeArchived,
        academicYear: query.academicYear,
        actor,
    });
    if (!shouldPaginate) {
        const students = await Student.find(scopedQuery).sort({ name: 1 }).lean();
        return students
            .map((student) => projectStudentForAcademicYear(student, selectedAcademicYear))
            .filter(Boolean);
    }

    const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });
    const allStudents = (await Student.find(scopedQuery).sort({ name: 1 }).lean())
        .map((student) => projectStudentForAcademicYear(student, selectedAcademicYear))
        .filter(Boolean);
    const students = allStudents.slice(pagination.skip, pagination.skip + pagination.limit);
    const total = allStudents.length;

    return {
        data: students,
        pagination: buildPaginationMeta({
            page: pagination.page,
            limit: pagination.limit,
            total,
        }),
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
                failedRows.push(`Row ${rowNum}: Duplicate Admission No ${admNo} for Academic Year ${academicYear} in this upload`);
            } else if (hasAcademicYearHistory(existingByAdmission.get(admNo), academicYear)) {
                failedRows.push(`Row ${rowNum}: Duplicate academic year record exists for Admission No ${admNo} in ${academicYear}. Update the student through User Management.`);
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

        for (const row of finalValidRows) {
            const className = normalizeClassName(row.class);
            const section = normalizeSection(row.section);
            const existing = existingByAdmission.get(row.admissionNo);

            if (existing) {
                const { update } = buildStudentUpdateForAcademicYear({
                    academicYear: row.academicYear,
                    existingStudent: existing,
                    input: {
                        name: row.name,
                        className,
                        section,
                        status: 'Active',
                    },
                });
                await Student.updateOne(
                    tenantFilter(actor, { admissionNo: row.admissionNo }),
                    { $set: update },
                    { runValidators: true }
                );
                const updatedExisting = {
                    ...existing,
                    ...update,
                    schoolId: existing.schoolId || actor.schoolId,
                    history: update.history,
                };
                await syncStudentReferences(existing, updatedExisting);
                existingByAdmission.set(row.admissionNo, {
                    ...updatedExisting,
                });
                updatedCount += 1;
            } else {
                const credentials = await generateStudentInitialPassword();
                generatedCredentials.push({ admissionNo: row.admissionNo, tempPassword: credentials.plaintext });
                const createdStudent = await Student.create({
                    schoolId: actor.schoolId,
                    admissionNo: row.admissionNo,
                    name: row.name,
                    className,
                    section,
                    academicYear: row.academicYear,
                    history: [buildHistoryEntry({
                        academicYear: row.academicYear,
                        admissionNo: row.admissionNo,
                        name: row.name,
                        className,
                        section,
                    })],
                    password: credentials.hash,
                    mustChangePassword: true,
                });
                existingByAdmission.set(row.admissionNo, createdStudent.toObject());
                insertedCount += 1;
            }
        }

        createLog(
            'STUDENT_BULK_UPLOAD',
            getActorId(actor),
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

const deleteStudent = async ({ studentId, actor }) => {
    const student = await Student.findOne(tenantFilter(actor, { _id: studentId })).lean();
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    await Student.findOneAndUpdate(
        tenantFilter(actor, { _id: studentId }),
        { status: student.className === '12' ? 'Passed Out' : 'Alumni' },
        { runValidators: true }
    );

    createLog(
        'ADMIN_DELETE_USER',
        getActorId(actor),
        'Student',
        student._id,
        { Name: student.name, 'Admission Number': student.admissionNo, Role: 'Student' }
    );

    return { message: 'Student archived successfully.' };
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
        getActorId(actor),
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

    createLog(
        'STUDENT_UPDATED',
        getActorId(actor),
        'Student',
        updatedStudent._id,
        {
            Name: updatedStudent.name,
            'Admission Number': updatedStudent.admissionNo,
            academicYear: requestedAcademicYear,
        }
    );

    return projectStudentForAcademicYear(updatedStudent.toObject(), requestedAcademicYear) || updatedStudent;
};

module.exports = {
    getFilters,
    getStudentsByFilter,
    getAllStudents,
    uploadStudents,
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
    },
};
