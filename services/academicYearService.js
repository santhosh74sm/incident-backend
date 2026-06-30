const SchoolWorkspace = require('../models/SchoolWorkspace');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
const IncidentReadState = require('../models/IncidentReadState');
const Log = require('../models/Log');
const IssuedLetter = require('../models/IssuedLetter');
const BulkDeleteLog = require('../models/BulkDeleteLog');
const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const { assertSchoolId } = require('../utils/tenant');
const logger = require('../utils/pinoLogger');

const ACADEMIC_YEAR_PATTERN = /^\d{4}-\d{2}$/;
const activeAcademicYearChanges = new Set();

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

const getPreviousAcademicYear = (academicYear) => {
    const current = validateAcademicYear(academicYear);
    const startYear = Number(current.slice(0, 4)) - 1;
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

const logRollbackStep = (step, message, metadata = {}) => {
    logger.info(message, {
        file: 'services/academicYearService.js',
        functionName: 'reverseAcademicYearUpdate',
        step,
        ...metadata,
    });
};

const logRollbackFailure = (step, error, metadata = {}) => {
    logger.error('Reverse Academic Year Update failed', {
        file: 'services/academicYearService.js',
        functionName: 'reverseAcademicYearUpdate',
        step,
        error: error?.message,
        stack: error?.stack,
        ...metadata,
    });
};

const findLatestPromotionLog = async ({ schoolId, currentAcademicYear, session }) => {
    const query = Log.findOne({
        schoolId,
        academicYear: currentAcademicYear,
        actionName: 'ACADEMIC_YEAR_CHANGED',
        'metadata.academicYear': currentAcademicYear,
    }).sort({ createdAt: -1 }).lean();
    if (session) query.session(session);
    return query;
};

const getHistoryEntryForYear = (student, academicYear) =>
    (student.history || []).find((entry) => entry?.academicYear === academicYear);

const getHistoryWithoutYear = (student, academicYear) =>
    (student.history || []).filter((entry) => entry?.academicYear !== academicYear);

const validateRollbackIntegrity = async ({ schoolId, removedAcademicYear, previousAcademicYear, session }) => {
    const promotedYearStudentCount = await Student.countDocuments({ schoolId, academicYear: removedAcademicYear }).session(session);
    const promotedYearHistoryCount = await Student.countDocuments({ schoolId, 'history.academicYear': removedAcademicYear }).session(session);
    const promotedYearIncidentCount = await Incident.countDocuments({ schoolId, academicYear: removedAcademicYear }).session(session);
    const promotedYearLetterCount = await IssuedLetter.countDocuments({ schoolId, academicYear: removedAcademicYear }).session(session);
    const promotedYearBulkDeleteCount = await BulkDeleteLog.countDocuments({ schoolId, academicYear: removedAcademicYear }).session(session);
    const duplicateAdmissionNos = await Student.aggregate([
        { $match: { schoolId } },
        { $group: { _id: '$admissionNo', count: { $sum: 1 } } },
        { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
        { $limit: 1 },
    ]).session(session);
    const duplicateHistoryYears = await Student.aggregate([
        { $match: { schoolId } },
        { $project: {
            duplicateYears: {
                $let: {
                    vars: { years: { $ifNull: ['$history.academicYear', []] } },
                    in: { $gt: [{ $size: '$$years' }, { $size: { $setUnion: ['$$years', []] } }] },
                },
            },
        } },
        { $match: { duplicateYears: true } },
        { $limit: 1 },
    ]).session(session);
    const validIncidentIds = await Incident.distinct('_id', { schoolId }).session(session);
    const orphanNotificationCount = await Notification.countDocuments({ schoolId, incident: { $ne: null, $nin: validIncidentIds } }).session(session);
    const orphanLetterCount = await IssuedLetter.countDocuments({ schoolId, incident: { $nin: validIncidentIds } }).session(session);

    if (
        promotedYearStudentCount > 0 ||
        promotedYearHistoryCount > 0 ||
        promotedYearIncidentCount > 0 ||
        promotedYearLetterCount > 0 ||
        promotedYearBulkDeleteCount > 0 ||
        duplicateAdmissionNos.length > 0 ||
        duplicateHistoryYears.length > 0 ||
        orphanNotificationCount > 0 ||
        orphanLetterCount > 0
    ) {
        throw new AppError('Rollback validation failed. No changes were saved.', 409);
    }

    const restoredPreviousYearStudents = await Student.countDocuments({
        schoolId,
        academicYear: previousAcademicYear,
    }).session(session);

    if (restoredPreviousYearStudents < 1) {
        throw new AppError('Rollback validation failed because no previous-year students remain active.', 409);
    }
};

const promoteActiveStudentsForAcademicYear = async ({ schoolId, previousAcademicYear, nextAcademicYear, actor, session }) => {
    let query = Student.find({
        schoolId,
        status: 'Active',
        $or: [
            { academicYear: previousAcademicYear },
            { 'history.academicYear': previousAcademicYear },
        ],
    }).lean();

    if (session) query = query.session(session);
    const students = await query;

    let promoted = 0;
    let passedOut = 0;
    let skipped = 0;
    const bulkOps = [];
    const auditLogs = [];

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

        bulkOps.push({
            updateOne: {
                filter: { _id: student._id, schoolId },
                update: { $set: promotionUpdate.update },
            },
        });

        if (promotionUpdate.promotionTarget.isPassedOut) {
            passedOut += 1;
            auditLogs.push({
                schoolId,
                academicYear: nextAcademicYear,
                actionName: 'STUDENT_PASSED_OUT',
                performedBy: String(getActorId(actor)),
                entityType: 'Student',
                entityId: String(student._id),
                targetLabel: student.name,
                metadata: {
                    Name: student.name,
                    'Admission Number': student.admissionNo,
                    targetLabel: student.name,
                    targetAdmissionNumber: student.admissionNo,
                    admissionNo: student.admissionNo,
                    previousAcademicYear,
                    academicYear: nextAcademicYear,
                    previousStatus: student.status,
                    status: 'Passed Out',
                },
            });
        } else promoted += 1;
    }

    if (bulkOps.length > 0) {
        await Student.bulkWrite(bulkOps, { ordered: true, session });
    }

    return { promoted, passedOut, skipped, auditLogs };
};

const changeAcademicYear = async ({ actor, academicYear }) => {
    if (!['Super Admin', 'super_admin'].includes(actor?.role)) {
        throw new AppError('Only Super Admin can change the Academic Year.', 403);
    }

    const schoolId = assertSchoolId(actor.schoolId);
    if (activeAcademicYearChanges.has(schoolId)) {
        throw new AppError('Academic Year change is already in progress. Please wait for it to finish.', 409);
    }
    activeAcademicYearChanges.add(schoolId);

    let session = null;

    try {
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
        session = await SchoolWorkspace.startSession();

        await session.withTransaction(async () => {
            const workspaceUpdate = await SchoolWorkspace.updateOne(
                { schoolId, currentAcademicYear: previousAcademicYear },
                { $set: { currentAcademicYear: nextAcademicYear } },
                { session }
            );

            if (workspaceUpdate.matchedCount !== 1) {
                throw new AppError('Academic Year change could not be completed because the workspace changed. No changes were saved.', 409);
            }

            const promotionResult = await promoteActiveStudentsForAcademicYear({
                schoolId,
                previousAcademicYear,
                nextAcademicYear,
                actor,
                session,
            });
            promotion = {
                promoted: promotionResult.promoted,
                passedOut: promotionResult.passedOut,
                skipped: promotionResult.skipped,
            };

            const summaryLog = {
                schoolId,
                academicYear: nextAcademicYear,
                actionName: 'ACADEMIC_YEAR_CHANGED',
                performedBy: String(actor?._id || actor?.id || 'System'),
                entityType: 'System',
                entityId: null,
                targetLabel: `Academic Year ${previousAcademicYear} to ${nextAcademicYear}`,
                metadata: {
                    schoolId,
                    targetLabel: `Academic Year ${previousAcademicYear} to ${nextAcademicYear}`,
                    previousAcademicYear,
                    academicYear: nextAcademicYear,
                    promoted: promotion.promoted,
                    passedOut: promotion.passedOut,
                    skipped: promotion.skipped,
                    summary: true,
                },
            };

            await Log.create([summaryLog, ...promotionResult.auditLogs], { ordered: true, session });
        });

        return {
            schoolId: workspace.schoolId,
            currentAcademicYear: nextAcademicYear,
            previousAcademicYear,
            promotion,
        };
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('Academic Year change failed. No changes were saved.', 500);
    } finally {
        activeAcademicYearChanges.delete(schoolId);
        if (session) await session.endSession();
    }
};

const reverseAcademicYearUpdate = async ({ actor }) => {
    if (!['Super Admin', 'super_admin'].includes(actor?.role)) {
        throw new AppError('Only Super Admin can reverse the Academic Year update.', 403);
    }

    const schoolId = assertSchoolId(actor.schoolId);
    if (activeAcademicYearChanges.has(schoolId)) {
        throw new AppError('Academic Year change is already in progress. Please wait for it to finish.', 409);
    }
    activeAcademicYearChanges.add(schoolId);

    const startedAt = Date.now();
    let session = null;
    let currentStep = 'start';

    try {
        currentStep = 'find_workspace';
        logRollbackStep(1, 'Starting Reverse Academic Year Update.', { schoolId, actorId: String(getActorId(actor)) });
        const workspace = await getWorkspace(schoolId);
        const removedAcademicYear = workspace.currentAcademicYear || inferAcademicYearFromDate(workspace.createdAt);
        logRollbackStep(2, 'Finding current academic year.', { schoolId, removedAcademicYear, collection: 'SchoolWorkspace', documentId: String(workspace._id) });

        currentStep = 'start_transaction';
        session = await SchoolWorkspace.startSession();
        let rollbackResult = null;

        await session.withTransaction(async () => {
            currentStep = 'find_promotion_log';
            logRollbackStep(3, 'Finding audit log for last academic year promotion.', { schoolId, removedAcademicYear, collection: 'Log' });
            const promotionLog = await findLatestPromotionLog({ schoolId, currentAcademicYear: removedAcademicYear, session });
            if (!promotionLog?.metadata?.previousAcademicYear) {
                throw new AppError(`No ACADEMIC_YEAR_CHANGED audit log found for current Academic Year ${removedAcademicYear}. Rollback cannot continue safely.`, 409, 'ACADEMIC_YEAR_ROLLBACK_LOG_MISSING');
            }
            logRollbackStep(4, 'Audit log found.', {
                schoolId,
                removedAcademicYear,
                collection: 'Log',
                documentId: String(promotionLog._id),
                metadata: promotionLog.metadata,
            });

            const previousAcademicYear = promotionLog.metadata.previousAcademicYear;
            currentStep = 'validate_years';
            logRollbackStep(5, 'Finding previous academic year.', { schoolId, previousAcademicYear, removedAcademicYear });
            validateAcademicYear(previousAcademicYear);

            if (getNextAcademicYear(previousAcademicYear) !== removedAcademicYear) {
                throw new AppError(`Current Academic Year ${removedAcademicYear} is not the next year after recorded previous Academic Year ${previousAcademicYear}. Rollback cannot continue safely.`, 409, 'ACADEMIC_YEAR_ROLLBACK_YEAR_MISMATCH');
            }

            currentStep = 'load_students';
            logRollbackStep(6, 'Loading promoted students and history snapshots.', { schoolId, previousAcademicYear, removedAcademicYear, collection: 'Student' });
            const studentsQuery = Student.find({
                schoolId,
                $or: [
                    { academicYear: removedAcademicYear },
                    { 'history.academicYear': removedAcademicYear },
                ],
            }).lean().session(session);
            const affectedStudents = await studentsQuery;
            logRollbackStep(7, 'Promoted student records loaded.', { schoolId, affectedStudentCount: affectedStudents.length, collection: 'Student' });

            const expectedPromotionCount = Number(promotionLog.metadata.promoted || 0) + Number(promotionLog.metadata.passedOut || 0);
            const restorableStudents = affectedStudents.filter((student) => getHistoryEntryForYear(student, previousAcademicYear));

            if (expectedPromotionCount > 0 && restorableStudents.length === 0) {
                throw new AppError(
                    `Student history snapshot missing for Academic Year ${previousAcademicYear}. The promotion audit log expected ${expectedPromotionCount} promoted students, but zero restorable previous-year snapshots were found. Rollback cannot continue safely.`,
                    409,
                    'ACADEMIC_YEAR_ROLLBACK_STUDENT_HISTORY_MISSING'
                );
            }

            const studentOps = [];
            let studentsRestored = 0;
            let passedOutStudentsRestored = 0;
            let promotedYearOnlyStudentsRemoved = 0;
            const promotionCreatedAt = promotionLog.createdAt ? new Date(promotionLog.createdAt) : null;

            for (const student of affectedStudents) {
                const previousEntry = getHistoryEntryForYear(student, previousAcademicYear);

                if (!previousEntry) {
                    const createdAfterPromotion = promotionCreatedAt && student.createdAt && new Date(student.createdAt) >= promotionCreatedAt;
                    if (student.academicYear === removedAcademicYear && createdAfterPromotion) {
                        logRollbackStep(8, 'Deleting promoted-year-only student created after promotion.', {
                            schoolId,
                            collection: 'Student',
                            documentId: String(student._id),
                            admissionNo: student.admissionNo,
                            removedAcademicYear,
                        });
                        studentOps.push({
                            deleteOne: {
                                filter: { _id: student._id, schoolId, academicYear: removedAcademicYear },
                            },
                        });
                        promotedYearOnlyStudentsRemoved += 1;
                        continue;
                    }

                    throw new AppError(
                        `Student history snapshot missing for student ${student.name || student.admissionNo || student._id} (${student._id}) in Academic Year ${previousAcademicYear}. Rollback cannot safely restore class and section.`,
                        409,
                        'ACADEMIC_YEAR_ROLLBACK_STUDENT_SNAPSHOT_MISSING'
                    );
                }

                const wasPassedOutByPromotion = student.status === 'Passed Out' || getHistoryEntryForYear(student, removedAcademicYear)?.status === 'Passed Out';
                if (!previousEntry.className || !previousEntry.section) {
                    throw new AppError(
                        `Student history snapshot incomplete for student ${student.name || student.admissionNo || student._id} (${student._id}) in Academic Year ${previousAcademicYear}. Missing class or section.`,
                        409,
                        'ACADEMIC_YEAR_ROLLBACK_STUDENT_SNAPSHOT_INCOMPLETE'
                    );
                }

                const update = {
                    academicYear: previousAcademicYear,
                    className: previousEntry.className,
                    section: previousEntry.section,
                    status: previousEntry.status || 'Active',
                    history: getHistoryWithoutYear(student, removedAcademicYear),
                };

                if (previousEntry.admissionNo) update.admissionNo = previousEntry.admissionNo;
                if (previousEntry.name) update.name = previousEntry.name;

                studentOps.push({
                    updateOne: {
                        filter: { _id: student._id, schoolId },
                        update: { $set: update },
                    },
                });
                studentsRestored += 1;
                if (wasPassedOutByPromotion && update.status === 'Active' && update.className === '12') {
                    passedOutStudentsRestored += 1;
                }
            }
            logRollbackStep(9, 'Prepared student restore operations.', {
                schoolId,
                collection: 'Student',
                studentsRestored,
                passedOutStudentsRestored,
                promotedYearOnlyStudentsRemoved,
                operationCount: studentOps.length,
            });

            currentStep = 'load_year_records';
            logRollbackStep(10, 'Loading promoted year incident records.', { schoolId, removedAcademicYear, collection: 'Incident' });
            const incidentIds = await Incident.find({ schoolId, academicYear: removedAcademicYear })
                .select('_id')
                .lean()
                .session(session);
            const incidentObjectIds = incidentIds.map((incident) => incident._id);
            const incidentStringIds = incidentObjectIds.map((id) => String(id));

            currentStep = 'delete_year_records';
            logRollbackStep(11, 'Deleting promoted year records.', { schoolId, removedAcademicYear });
            const incidentReadStateDelete = incidentObjectIds.length
                ? await IncidentReadState.deleteMany({ schoolId, incident: { $in: incidentObjectIds } }).session(session)
                : { deletedCount: 0 };
            const notificationDelete = incidentObjectIds.length
                ? await Notification.deleteMany({
                    schoolId,
                    $or: [
                        { incident: { $in: incidentObjectIds } },
                        { entityType: 'Incident', entityId: { $in: incidentStringIds } },
                    ],
                }).session(session)
                : { deletedCount: 0 };
            const issuedLetterDelete = await IssuedLetter.deleteMany({ schoolId, academicYear: removedAcademicYear }).session(session);
            const incidentDelete = await Incident.deleteMany({ schoolId, academicYear: removedAcademicYear }).session(session);
            const bulkDeleteLogDelete = await BulkDeleteLog.deleteMany({ schoolId, academicYear: removedAcademicYear }).session(session);
            const logDelete = await Log.deleteMany({ schoolId, academicYear: removedAcademicYear }).session(session);
            const remainingIncidentIds = await Incident.distinct('_id', { schoolId }).session(session);
            const orphanNotificationDelete = await Notification.deleteMany({
                schoolId,
                incident: { $ne: null, $nin: remainingIncidentIds },
            }).session(session);
            const orphanIssuedLetterDelete = await IssuedLetter.deleteMany({
                schoolId,
                incident: { $nin: remainingIncidentIds },
            }).session(session);

            if (studentOps.length > 0) {
                currentStep = 'restore_students';
                logRollbackStep(12, 'Applying student restore operations.', { schoolId, collection: 'Student', operationCount: studentOps.length });
                await Student.bulkWrite(studentOps, { ordered: true, session });
            }

            currentStep = 'restore_workspace_year';
            logRollbackStep(13, 'Restoring workspace current academic year.', { schoolId, collection: 'SchoolWorkspace', fromAcademicYear: removedAcademicYear, toAcademicYear: previousAcademicYear });
            const workspaceUpdate = await SchoolWorkspace.updateOne(
                { schoolId, currentAcademicYear: removedAcademicYear },
                { $set: { currentAcademicYear: previousAcademicYear } },
                { session }
            );

            if (workspaceUpdate.matchedCount !== 1) {
                throw new AppError('Academic Year rollback could not be completed because the workspace changed. No changes were saved.', 409);
            }

            currentStep = 'validate';
            logRollbackStep(14, 'Running rollback validation.', { schoolId, previousAcademicYear, removedAcademicYear });
            await validateRollbackIntegrity({
                schoolId,
                removedAcademicYear,
                previousAcademicYear,
                session,
            });

            const recordsDeleted = {
                students: promotedYearOnlyStudentsRemoved,
                incidents: incidentDelete.deletedCount || 0,
                incidentReadStates: incidentReadStateDelete.deletedCount || 0,
                notifications: notificationDelete.deletedCount || 0,
                orphanNotifications: orphanNotificationDelete.deletedCount || 0,
                issuedLetters: issuedLetterDelete.deletedCount || 0,
                orphanIssuedLetters: orphanIssuedLetterDelete.deletedCount || 0,
                bulkDeleteLogs: bulkDeleteLogDelete.deletedCount || 0,
                logs: logDelete.deletedCount || 0,
            };

            const durationMs = Date.now() - startedAt;
            currentStep = 'write_audit_log';
            logRollbackStep(15, 'Writing rollback audit log.', { schoolId, collection: 'Log', previousAcademicYear, removedAcademicYear, recordsDeleted });
            const auditLog = {
                schoolId,
                academicYear: previousAcademicYear,
                actionName: 'ACADEMIC_YEAR_ROLLBACK_COMPLETED',
                performedBy: String(getActorId(actor)),
                entityType: 'System',
                entityId: null,
                targetLabel: `Academic Year rollback ${removedAcademicYear} to ${previousAcademicYear}`,
                metadata: {
                    schoolId,
                    targetLabel: `Academic Year rollback ${removedAcademicYear} to ${previousAcademicYear}`,
                    previousAcademicYear,
                    removedAcademicYear,
                    studentsRestored,
                    passedOutStudentsRestored,
                    promotedYearOnlyStudentsRemoved,
                    recordsDeleted,
                    executionTimeMs: durationMs,
                    rollbackStatus: 'success',
                    summary: true,
                },
            };

            await Log.create([auditLog], { ordered: true, session });
            logRollbackStep(16, 'Rollback completed inside transaction.', { schoolId, previousAcademicYear, removedAcademicYear, durationMs });

            rollbackResult = {
                schoolId,
                currentAcademicYear: previousAcademicYear,
                previousAcademicYear,
                removedAcademicYear,
                studentsRestored,
                passedOutStudentsRestored,
                promotedYearOnlyStudentsRemoved,
                recordsDeleted,
                executionTimeMs: durationMs,
            };
        });

        logRollbackStep(17, 'Reverse Academic Year Update committed.', { schoolId, result: rollbackResult });
        return rollbackResult;
    } catch (error) {
        logRollbackFailure(currentStep, error, { schoolId });
        if (error instanceof AppError) throw error;
        throw new AppError(`Rollback failed. Reason: ${error.message || 'Unexpected server error'}. No changes were made.`, 500, 'ACADEMIC_YEAR_ROLLBACK_FAILED');
    } finally {
        activeAcademicYearChanges.delete(schoolId);
        if (session) await session.endSession();
    }
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
    getPreviousAcademicYear,
    inferAcademicYearFromDate,
    getCurrentAcademicYear,
    getAcademicYearQuery,
    changeAcademicYear,
    reverseAcademicYearUpdate,
    getAcademicYearSummary,
    _private: {
        getPromotedClassName,
        getPromotionTarget,
        buildPromotionUpdateForStudent,
    },
};
