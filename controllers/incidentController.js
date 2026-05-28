/**
 * incidentController.js
 * Thin HTTP adapter — delegates ALL business logic to incidentService.
 * Handles only: request parsing, response formatting, HTTP status codes.
 */

'use strict';

const incidentService = require('../services/incidentService');
const { bulkQueue } = require('../utils/asyncQueue');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Create Incident(s)
// ─────────────────────────────────────────────────────────────────────────────

const createIncident = async (req, res, next) => {
    try {
        const { createdIncidents, failedStudents, generatedLetters, isBulkSubmission } = await incidentService.createIncidents({
            body: req.body,
            files: req.files,
            user: req.user,
        });

        if (isBulkSubmission) {
            return res.status(201).json({
                success: true,
                createdCount: createdIncidents.length,
                failedCount: failedStudents.length,
                failedStudents,
                lettersGenerated: generatedLetters.length,
                incidents: createdIncidents.map((i) => ({ _id: i._id, admissionNo: i.admissionNo, studentsInvolved: i.studentsInvolved })),
                letterGenerated: generatedLetters.length > 0 ? {
                    id: generatedLetters[0]._id,
                    letterNumber: generatedLetters[0].letterNumber,
                    templateName: generatedLetters[0].templateName || generatedLetters[0].title,
                } : null,
                message: `Successfully created incidents and letters for ${createdIncidents.length} student${createdIncidents.length !== 1 ? 's' : ''}${failedStudents.length > 0 ? ` (${failedStudents.length} failed)` : ''}`,
            });
        }

        // Single incident response (legacy)
        const incident = createdIncidents[0];
        const letterGenerated = generatedLetters.length > 0 ? {
            id: generatedLetters[0]._id,
            letterNumber: generatedLetters[0].letterNumber,
            templateName: generatedLetters[0].templateName || generatedLetters[0].title,
        } : null;

        return res.status(201).json({
            ...incident.toObject(),
            letterGenerated,
            letterMessage: letterGenerated ? `Letter ${generatedLetters[0].letterNumber} auto-generated` : null,
        });
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. List Incidents
// ─────────────────────────────────────────────────────────────────────────────

const getIncidents = async (req, res, next) => {
    try {
        const result = await incidentService.listIncidents({ user: req.user, query: req.query });

        if (result.paginated) {
            return res.json({ data: result.data, pagination: result.pagination });
        }

        return res.json(result.data);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2.1. Location Distribution
// ─────────────────────────────────────────────────────────────────────────────

const getIncidentLocationDistribution = async (req, res, next) => {
    try {
        const data = await incidentService.getLocationDistribution({ user: req.user, query: req.query });
        res.json(data);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Get Single Incident
// ─────────────────────────────────────────────────────────────────────────────

const getIncidentById = async (req, res, next) => {
    try {
        const incident = await incidentService.getIncidentById(req.params.id, req.user);
        res.json(incident);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Approve & Assign Handler
// ─────────────────────────────────────────────────────────────────────────────

const approveAndAssign = async (req, res, next) => {
    try {
        const result = await incidentService.approveAndAssign(req.params.id, req.body.handlerId, req.user);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Add Progress Note
// ─────────────────────────────────────────────────────────────────────────────

const addProgressNote = async (req, res, next) => {
    try {
        const incident = await incidentService.addProgressNote(req.params.id, req.body.note, req.user);
        res.json(incident);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. Request Closure
// ─────────────────────────────────────────────────────────────────────────────

const requestClosure = async (req, res, next) => {
    try {
        const result = await incidentService.requestClosure(req.params.id, req.body.actionTaken, req.user);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. Finalize Closure (Admin)
// ─────────────────────────────────────────────────────────────────────────────

const finalizeClosure = async (req, res, next) => {
    try {
        const result = await incidentService.finalizeClosure(req.params.id, req.body.note, req.user);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7.1. Reject Closure (Admin)
// ─────────────────────────────────────────────────────────────────────────────

const rejectClosure = async (req, res, next) => {
    try {
        const result = await incidentService.rejectClosure(req.params.id, req.body.reason, req.user);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. Delete Incident (Admin)
// ─────────────────────────────────────────────────────────────────────────────

const deleteIncident = async (req, res, next) => {
    try {
        const result = await incidentService.deleteIncident(req.params.id, req.user);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. Upload Incidents from Excel (Admin)
// ─────────────────────────────────────────────────────────────────────────────

const uploadIncidents = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Please choose an Excel file to upload.' });
        }

        // Validate the file synchronously before queuing
        const filePath = req.file.path;
        const user     = req.user;
        const body     = req.body;

        // Enqueue the heavy Excel processing — respond immediately
        const job = bulkQueue.push(() => incidentService.processExcelUpload(filePath, user, body));

        // Await the job result (it runs via setImmediate, freeing event loop)
        const { createdIncidents, lettersGenerated, lettersFailed, errors, validationResults } = await job.promise;

        res.status(201).json({
            message: `Successfully uploaded ${createdIncidents.length} incidents with database validation`,
            uploaded: createdIncidents.length,
            lettersAutoGenerated: lettersGenerated.length,
            lettersFailed: lettersFailed.length > 0 ? lettersFailed : undefined,
            errors: errors.length > 0 ? errors : undefined,
            validationResults,
        });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({
                message: error.message,
                errors: error.errors,
                validationResults: error.validationResults,
                hint: error.hint,
                suggestion: 'Please correct the errors in your Excel file and try again.',
            });
        }
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. Download Upload Template
// ─────────────────────────────────────────────────────────────────────────────

const downloadTemplate = async (req, res, next) => {
    try {
        const format = req.query.format || 'xlsx';
        const result = await incidentService.buildDownloadTemplate(format);

        if (result.format === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="incident_upload_template.csv"');
            if (result.url) res.setHeader('X-S3-File-Url', result.url);
            return res.send(result.content);
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="incident_upload_template.xlsx"');
        if (result.url) res.setHeader('X-S3-File-Url', result.url);
        return res.send(result.buffer);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. Export Incident Case Report (DOCX)
// ─────────────────────────────────────────────────────────────────────────────

const exportIncidentReport = async (req, res, next) => {
    try {
        const { buffer, filename, url } = await incidentService.buildCaseReportDocx(req.params.id);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (url) res.setHeader('X-S3-File-Url', url);
        return res.send(buffer);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. Add Evidence to Incident
// ─────────────────────────────────────────────────────────────────────────────

const addIncidentEvidence = async (req, res, next) => {
    try {
        const incident = await incidentService.addEvidence(req.params.id, req.files, req.body.evidenceDetails, req.user);
        res.json({ message: 'Evidence added successfully', incident });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    createIncident,
    getIncidents,
    getIncidentLocationDistribution,
    getIncidentById,
    approveAndAssign,
    addProgressNote,
    requestClosure,
    finalizeClosure,
    rejectClosure,
    deleteIncident,
    uploadIncidents,
    downloadTemplate,
    exportIncidentReport,
    addIncidentEvidence,
};
