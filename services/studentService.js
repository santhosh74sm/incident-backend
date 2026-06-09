const fs = require('fs');
const XLSX = require('xlsx');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
const IssuedLetter = require('../models/IssuedLetter');
const { createLog } = require('../utils/logger');
const pick = require('../utils/pick');
const AppError = require('../utils/AppError');
const { generateStudentInitialPassword } = require('./studentAuthService');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { safeSheetToJson } = require('../utils/spreadsheetSecurity');
const { tenantDoc, tenantFilter } = require('../utils/tenant');

const STUDENT_FIELDS = ['admissionNo', 'name', 'className', 'section'];

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const normalizeStudentInput = (input = {}) => pick(input, STUDENT_FIELDS);
const normalizeAdmissionNo = (value) => String(value || '').trim();

const getFilters = async (actor) => {
    const [classes, sections] = await Promise.all([
        Student.distinct('className', tenantFilter(actor)),
        Student.distinct('section', tenantFilter(actor)),
    ]);

    return {
        classes: classes.filter(Boolean).sort((a, b) => a - b),
        sections: sections.filter(Boolean).sort(),
    };
};

const getStudentsByFilter = async ({ className, section, search, page, limit, actor } = {}) => {
    const query = tenantFilter(actor);
    if (className) query.className = className;
    if (section) query.section = section;

    if (search && search.trim()) {
        const searchTerm = search.trim();
        const safe = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [
            { name: { $regex: safe, $options: 'i' } },
            { admissionNo: { $regex: safe, $options: 'i' } },
        ];
    }

    const shouldPaginate = page !== undefined || limit !== undefined;
    if (!shouldPaginate) {
        return Student.find(query).sort({ name: 1 }).lean();
    }

    const pagination = getPagination({ page, limit }, { defaultLimit: 20, maxLimit: 100 });
    const [students, total] = await Promise.all([
        Student.find(query).sort({ name: 1 }).skip(pagination.skip).limit(pagination.limit).lean(),
        Student.countDocuments(query),
    ]);

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
    const scopedQuery = tenantFilter(actor);
    if (!shouldPaginate) {
        return Student.find(scopedQuery).sort({ name: 1 }).lean();
    }

    const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });
    const [students, total] = await Promise.all([
        Student.find(scopedQuery).sort({ name: 1 }).skip(pagination.skip).limit(pagination.limit).lean(),
        Student.countDocuments(scopedQuery),
    ]);

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
            className: row.class ? row.class.toString() : '',
            section: row.section ? row.section.toString().toUpperCase() : '',
            password: credentials.hash,
            mustChangePassword: true,
        };
    }));

    return { students, generatedCredentials };
};

const uploadStudents = async ({ filePath, actor }) => {
    if (!filePath) {
        throw new AppError('No file uploaded. Please attach an Excel file.', 400);
    }

    try {
        const workbook = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false, cellNF: false });
        const data = safeSheetToJson(XLSX, workbook.Sheets[workbook.SheetNames[0]]);

        if (!data || data.length === 0) {
            throw new AppError('Excel file is empty or has no valid rows.', 400);
        }

        const validRows = data.filter((row) => row.admissionNo != null);
        if (validRows.length === 0) {
            throw new AppError('No valid rows with admissionNo found in the file.', 400);
        }

        const admissionNumbers = validRows.map((row) => normalizeAdmissionNo(row.admissionNo)).filter(Boolean);
        
        // Use lean() for fast pre-upload checks
        const existingStudents = await Student.find(tenantFilter(actor, {
            admissionNo: { $in: admissionNumbers },
        })).select('admissionNo').lean();

        const existingIds = new Set(existingStudents.map((s) => s.admissionNo));
        const seenInExcel = new Set();
        const finalValidRows = [];
        const failedRows = [];

        for (let i = 0; i < validRows.length; i++) {
            const row = validRows[i];
            const rowNum = i + 2;
            const admNo = normalizeAdmissionNo(row.admissionNo);
            
            if (existingIds.has(admNo)) {
                failedRows.push(`Row ${rowNum}: Admission No ${admNo} already exists in DB`);
            } else if (seenInExcel.has(admNo)) {
                failedRows.push(`Row ${rowNum}: Duplicate Admission No ${admNo} in Excel`);
            } else {
                seenInExcel.add(admNo);
                finalValidRows.push(row);
            }
        }

        if (finalValidRows.length === 0 && data.length > 0) {
            throw new AppError('No valid new students to insert. All rows are duplicates or invalid.', 400);
        }

        const { students, generatedCredentials } = await buildStudentsFromUploadRows(finalValidRows, actor);

        let insertedCount = 0;
        if (students.length > 0) {
            try {
                // Bulk insert with { ordered: false, lean: true } for maximum performance
                const inserted = await Student.insertMany(students, { ordered: false, lean: true });
                insertedCount = inserted.length;
            } catch (error) {
                if (error.name === 'BulkWriteError' || error.writeErrors) {
                    insertedCount = students.length - (error.writeErrors?.length || 0);
                    error.writeErrors.forEach(we => {
                        failedRows.push(`Failed to insert record: ${we.errmsg}`);
                    });
                } else {
                    throw error;
                }
            }
        }

        createLog(
            'STUDENT_BULK_UPLOAD',
            getActorId(actor),
            'Student',
            null,
            {
                targetLabel: `${insertedCount} students imported`,
                Count: insertedCount,
                Action: 'Insert',
                summary: true,
                uploadType: 'Student',
            }
        );

        return { 
            message: `Successfully processed upload. Inserted ${insertedCount} new student(s).`, 
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

    const relatedIncidentQuery = {
        schoolId: actor.schoolId,
        $or: [
            { admissionNo: student.admissionNo },
            { studentsInvolved: student.name },
        ],
    };

    const relatedIncidents = await Incident.find(relatedIncidentQuery).select('_id').lean();
    const { deleteIncident } = require('./incidentService');
    const { deleteIssuedLetter } = require('./issuedLetterService');

    for (const incident of relatedIncidents) {
        await deleteIncident(incident._id, actor);
    }

    const remainingLetters = await IssuedLetter.find({
        schoolId: actor.schoolId,
        admissionNo: student.admissionNo,
    }).select('_id').lean();
    for (const letter of remainingLetters) {
        await deleteIssuedLetter(letter._id, actor);
    }
    await Student.findOneAndDelete(tenantFilter(actor, { _id: studentId }));

    createLog(
        'ADMIN_DELETE_USER',
        getActorId(actor),
        'Student',
        student._id,
        { Name: student.name, 'Admission Number': student.admissionNo, Role: 'Student' }
    );

    return { message: 'Deleted' };
};

const createStudent = async ({ input, actor }) => {
    const studentInput = normalizeStudentInput(input);
    const existingStudent = await Student.findOne(tenantFilter(actor, { admissionNo: studentInput.admissionNo })).select('_id').lean();

    if (existingStudent) {
        throw new AppError('Admission Number already exists. Duplicate IDs are not allowed.', 400);
    }

    const credentials = await generateStudentInitialPassword();
    const student = await Student.create({
        ...tenantDoc(actor),
        ...studentInput,
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
    };
};

const syncStudentReferences = async (oldStudent, updatedStudent) => {
    if (
        oldStudent.admissionNo === updatedStudent.admissionNo &&
        oldStudent.name === updatedStudent.name &&
        oldStudent.className === updatedStudent.className &&
        oldStudent.section === updatedStudent.section
    ) {
        return;
    }

    await Incident.updateMany(
        { schoolId: oldStudent.schoolId, admissionNo: oldStudent.admissionNo },
        {
            $set: {
                admissionNo: updatedStudent.admissionNo,
                class: updatedStudent.className,
                section: updatedStudent.section,
            },
        }
    );

    if (oldStudent.name !== updatedStudent.name) {
        await Incident.updateMany(
            { schoolId: oldStudent.schoolId, admissionNo: updatedStudent.admissionNo, studentsInvolved: oldStudent.name },
            { $set: { 'studentsInvolved.$[elem]': updatedStudent.name } },
            { arrayFilters: [{ elem: oldStudent.name }] }
        );
    }

    await IssuedLetter.updateMany(
        { schoolId: oldStudent.schoolId, admissionNo: oldStudent.admissionNo },
        {
            $set: {
                admissionNo: updatedStudent.admissionNo,
                studentName: updatedStudent.name,
                className: updatedStudent.className,
                section: updatedStudent.section,
            },
        }
    );
};

const updateStudent = async ({ studentId, input, actor }) => {
    const oldStudent = await Student.findOne(tenantFilter(actor, { _id: studentId }));
    if (!oldStudent) {
        throw new AppError('Student not found', 404);
    }

    const studentInput = normalizeStudentInput(input);

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
        studentInput,
        { new: true, runValidators: true }
    );

    if (!updatedStudent) {
        throw new AppError('Student not found', 404);
    }

    await syncStudentReferences(oldStudent, updatedStudent);

    createLog(
        'STUDENT_UPDATED',
        getActorId(actor),
        'Student',
        updatedStudent._id,
        {
            Name: updatedStudent.name,
            'Admission Number': updatedStudent.admissionNo,
        }
    );

    return updatedStudent;
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
};
