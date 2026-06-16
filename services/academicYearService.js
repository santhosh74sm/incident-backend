const SchoolWorkspace = require('../models/SchoolWorkspace');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
const Log = require('../models/Log');
const IssuedLetter = require('../models/IssuedLetter');
const BulkDeleteLog = require('../models/BulkDeleteLog');
const AppError = require('../utils/AppError');
const { assertSchoolId } = require('../utils/tenant');
const { createLog } = require('../utils/logger');

const ACADEMIC_YEAR_PATTERN = /^\d{4}-\d{2}$/;

const normalizeAcademicYear = (value) => String(value || '').trim();

const validateAcademicYear = (value) => {
    const academicYear = normalizeAcademicYear(value);
    if (!ACADEMIC_YEAR_PATTERN.test(academicYear)) {
        throw new AppError('Academic Year must use YYYY-YY format, for example 2026-27.', 400);
    }
    const startYear = Number(academicYear.slice(0, 4));
    const endYear = Number(academicYear.slice(5, 7));
    if (((startYear + 1) % 100) !== endYear) {
        throw new AppError('Academic Year end year must be the next year, for example 2026-27.', 400);
    }
    return academicYear;
};

const getNextAcademicYear = (academicYear) => {
    const current = validateAcademicYear(academicYear);
    const startYear = Number(current.slice(0, 4)) + 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const inferAcademicYearFromDate = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const month = safeDate.getMonth();
    const startYear = month >= 3 ? safeDate.getFullYear() : safeDate.getFullYear() - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const getWorkspace = async (schoolId) => {
    const normalizedSchoolId = assertSchoolId(schoolId);
    const workspace = await SchoolWorkspace.findOne({ schoolId: normalizedSchoolId });
    if (!workspace) {
        throw new AppError('School workspace not found.', 404);
    }
    return workspace;
};

const ensureWorkspaceAcademicYear = async (schoolId) => {
    const workspace = await getWorkspace(schoolId);
    if (workspace.currentAcademicYear) return workspace.currentAcademicYear;
    workspace.currentAcademicYear = inferAcademicYearFromDate(workspace.createdAt);
    await workspace.save();
    return workspace.currentAcademicYear;
};

const getCurrentAcademicYear = async (actorOrSchoolId) => {
    const schoolId = typeof actorOrSchoolId === 'string' ? actorOrSchoolId : actorOrSchoolId?.schoolId;
    return ensureWorkspaceAcademicYear(schoolId);
};

const getAcademicYearQuery = (academicYear) => {
    const normalized = normalizeAcademicYear(academicYear);
    if (!normalized || normalized.toLowerCase() === 'all') return null;
    return normalized;
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

const getPromotedClassName = (className) => {
    const normalizedClass = String(className || '').trim();
    if (!/^\d+$/.test(normalizedClass)) return null;
    const numericClass = Number(normalizedClass);
    if (!Number.isInteger(numericClass) || numericClass < 1 || numericClass >= 12) return null;
    return String(numericClass + 1);
};

const getPromotionTarget = (className) => {
    const normalizedClass = String(className || '').trim();
    if (normalizedClass === '12') {
        return { className: '12', status: 'Passed Out', isPassedOut: true };
    }

    const promotedClassName = getPromotedClassName(normalizedClass);
    if (!promotedClassName) return null;

    return { className: promotedClassName, status: 'Active', isPassedOut: false };
};

const buildPromotionUpdateForStudent = (student, nextAcademicYear) => {
    const promotionTarget = getPromotionTarget(student?.className);
    if (!promotionTarget) return null;

    const nextHistory = upsertStudentHistory(student.history || [], buildHistoryEntry({
        academicYear: nextAcademicYear,
        admissionNo: student.admissionNo,
        name: student.name,
        className: promotionTarget.className,
        section: student.section,
        status: promotionTarget.status,
    }));

    return {
        promotionTarget,
        update: {
            className: promotionTarget.className,
            section: student.section,
            academicYear: nextAcademicYear,
            status: promotionTarget.status,
            history: nextHistory,
        },
    };
};

const getActorId = (actor) => actor?.id || actor?._id || 'System';

const promoteActiveStudentsForAcademicYear = async ({ schoolId, previousAcademicYear, nextAcademicYear, actor, session }) => {
    let query = Student.find({
        schoolId,
        status: 'Active',
        $or: [
            { academicYear: previousAcademicYear },
            { 'history.academicYear': previousAcademicYear },
        ],
    });

    if (session) query = query.session(session);
    const students = await query;

    let promoted = 0;
    let passedOut = 0;
    let skipped = 0;

    for (const student of students) {
        const hasTargetHistory = (student.history || []).some((entry) => entry?.academicYear === nextAcademicYear);
        if (student.academicYear === nextAcademicYear && hasTargetHistory) {
            skipped += 1;
            continue;
        }

        const promotionUpdate = buildPromotionUpdateForStudent(student, nextAcademicYear);
        if (!promotionUpdate) {
            skipped += 1;
            continue;
        }

        let updateQuery = Student.updateOne(
            { _id: student._id, schoolId },
            { $set: promotionUpdate.update }
        );
        if (session) updateQuery = updateQuery.session(session);
        await updateQuery;

        if (promotionUpdate.promotionTarget.isPassedOut) {
            passedOut += 1;
            createLog(
                'STUDENT_PASSED_OUT',
                getActorId(actor),
                'Student',
                student._id,
                {
                    Name: student.name,
                    'Admission Number': student.admissionNo,
                    targetLabel: student.name,
                    targetAdmissionNumber: student.admissionNo,
                    admissionNo: student.admissionNo,
                    previousAcademicYear,
                    academicYear: nextAcademicYear,
                    previousStatus: student.status,
                    status: 'Passed Out',
                }
            );
        } else promoted += 1;
    }

    return { promoted, passedOut, skipped };
};

const changeAcademicYear = async ({ actor, academicYear }) => {
    if (!['Super Admin', 'super_admin'].includes(actor?.role)) {
        throw new AppError('Only Super Admin can change the Academic Year.', 403);
    }

    const schoolId = assertSchoolId(actor.schoolId);
    const workspace = await getWorkspace(schoolId);
    const previousAcademicYear = workspace.currentAcademicYear || inferAcademicYearFromDate(workspace.createdAt);
    const calculatedNextAcademicYear = getNextAcademicYear(previousAcademicYear);
    const nextAcademicYear = academicYear ? validateAcademicYear(academicYear) : calculatedNextAcademicYear;

    if (nextAcademicYear !== calculatedNextAcademicYear) {
        throw new AppError(`Academic Year can only be advanced to ${calculatedNextAcademicYear}.`, 400);
    }

    if (previousAcademicYear === nextAcademicYear) {
        return {
            schoolId: workspace.schoolId,
            currentAcademicYear: previousAcademicYear,
            previousAcademicYear,
            promotion: { promoted: 0, passedOut: 0, skipped: 0 },
        };
    }

    let promotion = { promoted: 0, passedOut: 0, skipped: 0 };

    workspace.currentAcademicYear = nextAcademicYear;
    await workspace.save();
    promotion = await promoteActiveStudentsForAcademicYear({
        schoolId,
        previousAcademicYear,
        nextAcademicYear,
        actor,
    });

    createLog(
        'ACADEMIC_YEAR_CHANGED',
        actor?._id || actor?.id || 'System',
        'System',
        null,
        {
            schoolId,
            targetLabel: `Academic Year ${previousAcademicYear} to ${nextAcademicYear}`,
            previousAcademicYear,
            academicYear: nextAcademicYear,
            promoted: promotion.promoted,
            passedOut: promotion.passedOut,
            skipped: promotion.skipped,
            summary: true,
        }
    );

    return {
        schoolId: workspace.schoolId,
        currentAcademicYear: workspace.currentAcademicYear,
        previousAcademicYear,
        promotion,
    };
};

const getAcademicYearSummary = async (actor) => {
    const currentAcademicYear = await getCurrentAcademicYear(actor);
    const schoolId = assertSchoolId(actor?.schoolId);

    const [studentYears, historyYears, incidentYears, logYears, letterYears, bulkDeleteYears] = await Promise.all([
        Student.distinct('academicYear', { schoolId }),
        Student.distinct('history.academicYear', { schoolId }),
        Incident.distinct('academicYear', { schoolId }),
        Log.distinct('academicYear', { schoolId }),
        IssuedLetter.distinct('academicYear', { schoolId }),
        BulkDeleteLog.distinct('academicYear', { schoolId }),
    ]);

    const academicYears = [...new Set([
        currentAcademicYear,
        ...studentYears,
        ...historyYears,
        ...incidentYears,
        ...logYears,
        ...letterYears,
        ...bulkDeleteYears,
    ].filter(Boolean))].sort();

    return { currentAcademicYear, academicYears };
};

module.exports = {
    validateAcademicYear,
    getNextAcademicYear,
    inferAcademicYearFromDate,
    getCurrentAcademicYear,
    getAcademicYearQuery,
    changeAcademicYear,
    getAcademicYearSummary,
    _private: {
        getPromotedClassName,
        getPromotionTarget,
        buildPromotionUpdateForStudent,
    },
};
