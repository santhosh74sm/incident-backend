const fs = require('fs');
const crypto = require('crypto');
const studentService = require('../services/studentService');
const { bulkQueue } = require('../utils/asyncQueue');

const studentUploadJobs = new Map();
const activeStudentUploadsByUser = new Map();
const STUDENT_UPLOAD_JOB_TTL_MS = 30 * 60 * 1000;

const getUserId = (user = {}) => String(user.id || user._id || '');
const getSchoolId = (user = {}) => String(user.schoolId || '');
const getJobOwnerKey = (user = {}) => `${getSchoolId(user)}:${getUserId(user)}`;

const cleanupFile = (filePath) => {
    if (filePath) fs.unlink(filePath, () => {});
};

const scheduleJobCleanup = (jobId) => {
    setTimeout(() => {
        studentUploadJobs.delete(jobId);
    }, STUDENT_UPLOAD_JOB_TTL_MS).unref?.();
};

const serializeStudentUploadJob = (job) => ({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
});

const formatStudentUploadError = (error) => ({
    message: error.message || 'Student upload failed. No changes were saved.',
    failedRows: error.failedRows,
    failedCount: error.failedCount,
});

const getFilters = async (req, res, next) => {
    try {
        res.json(await studentService.getFilters(req.user, req.query));
    } catch (error) {
        next(error);
    }
};

const getStudentsByFilter = async (req, res, next) => {
    try {
        res.json(await studentService.getStudentsByFilter({ ...req.query, actor: req.user }));
    } catch (error) {
        next(error);
    }
};

const getAllStudents = async (req, res, next) => {
    try {
        res.json(await studentService.getAllStudents(req.query, req.user));
    } catch (error) {
        next(error);
    }
};

const uploadStudents = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded. Please attach an Excel file.' });
        }

        const filePath = req.file.path;
        const actor = { ...req.user };
        const uploadAcademicYear = req.body?.academicYear;
        const ownerKey = getJobOwnerKey(actor);
        const existingJobId = activeStudentUploadsByUser.get(ownerKey);
        const existingJob = existingJobId ? studentUploadJobs.get(existingJobId) : null;

        if (existingJob && ['queued', 'processing'].includes(existingJob.status)) {
            cleanupFile(filePath);
            return res.status(202).json({
                ...serializeStudentUploadJob(existingJob),
                message: 'A student upload is already in progress.',
            });
        }

        const job = {
            id: crypto.randomUUID(),
            userId: getUserId(actor),
            schoolId: getSchoolId(actor),
            status: 'queued',
            progress: { stage: 'Queued', percent: 1 },
            message: 'Student upload queued for processing.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            result: null,
            error: null,
        };

        studentUploadJobs.set(job.id, job);
        activeStudentUploadsByUser.set(ownerKey, job.id);

        const updateProgress = (stage, percent) => {
            job.progress = { stage, percent };
            job.updatedAt = new Date().toISOString();
        };

        bulkQueue.push(async () => {
            job.status = 'processing';
            job.startedAt = new Date().toISOString();
            job.message = 'Student upload is processing.';
            updateProgress('Processing spreadsheet', 25);

            try {
                const result = await studentService.uploadStudents({
                    filePath,
                    actor,
                    uploadAcademicYear,
                });
                job.status = 'completed';
                job.progress = { stage: 'Completed', percent: 100 };
                job.result = result;
                job.message = result.message || 'Student upload completed successfully.';
            } catch (error) {
                job.status = 'failed';
                job.progress = { stage: 'Failed', percent: 100 };
                job.error = formatStudentUploadError(error);
                job.message = job.error.message;
            } finally {
                job.finishedAt = new Date().toISOString();
                job.updatedAt = job.finishedAt;
                activeStudentUploadsByUser.delete(ownerKey);
                scheduleJobCleanup(job.id);
            }
        }).promise.catch((error) => {
            job.status = 'failed';
            job.progress = { stage: 'Failed', percent: 100 };
            job.error = formatStudentUploadError(error);
            job.message = job.error.message;
            job.finishedAt = new Date().toISOString();
            job.updatedAt = job.finishedAt;
            activeStudentUploadsByUser.delete(ownerKey);
            cleanupFile(filePath);
            scheduleJobCleanup(job.id);
        });

        return res.status(202).json({
            ...serializeStudentUploadJob(job),
            statusUrl: `/api/students/upload/${job.id}`,
        });
    } catch (error) {
        if (req.file?.path) cleanupFile(req.file.path);
        next(error);
    }
};

const getStudentUploadStatus = async (req, res, next) => {
    try {
        const job = studentUploadJobs.get(req.params.jobId);
        if (!job) {
            return res.status(404).json({ message: 'Student upload job not found.' });
        }

        if (job.userId !== getUserId(req.user) || job.schoolId !== getSchoolId(req.user)) {
            return res.status(403).json({ message: 'You are not allowed to view this student upload job.' });
        }

        return res.json(serializeStudentUploadJob(job));
    } catch (error) {
        next(error);
    }
};

const deleteStudent = async (req, res, next) => {
    try {
        res.json(await studentService.deleteStudent({
            studentId: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const previewStudentDelete = async (req, res, next) => {
    try {
        res.json(await studentService.previewStudentDelete({
            studentId: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const createStudent = async (req, res, next) => {
    try {
        const student = await studentService.createStudent({
            input: req.body,
            actor: req.user,
        });
        res.status(201).json(student);
    } catch (error) {
        next(error);
    }
};

const getStudentBehavioralSummary = async (req, res, next) => {
    try {
        res.json(await studentService.getStudentBehavioralSummary(req.params.id, req.user));
    } catch (error) {
        next(error);
    }
};

const updateStudent = async (req, res, next) => {
    try {
        res.json(await studentService.updateStudent({
            studentId: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getFilters,
    getStudentsByFilter,
    getAllStudents,
    uploadStudents,
    getStudentUploadStatus,
    deleteStudent,
    previewStudentDelete,
    createStudent,
    updateStudent,
    getStudentBehavioralSummary,
};
