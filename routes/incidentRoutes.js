/**
 * incidentRoutes.js
 * All incident-related API routes.
 * HTTP methods aligned with frontend apiClient (PUT for workflow transitions).
 */

'use strict';

const express = require('express');
const router = express.Router();

const {
    createIncident,
    getIncidents,
    getIncidentSummary,
    getIncidentById,
    markIncidentRead,
    getIncidentLocationDistribution,
    getProfessionalAnalytics,
    getProfessionalAnalyticsDetails,
    addProgressNote,
    requestClosure,
    finalizeClosure,
    approveAndAssign,
    deleteIncident,
    uploadIncidents,
    downloadTemplate,
    rejectClosure,
    exportIncidentReport,
    addIncidentEvidence,
    deleteIncidentEvidence,
    updateIncidentDescription,
} = require('../controllers/incidentController');

const incidentService = require('../services/incidentService');

const { getCategories, addCategory, updateCategory, deleteCategory } = require('../controllers/categoryController');
const { getLocations, addLocation, updateLocation, deleteLocation } = require('../controllers/locationController');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const validate = require('../middleware/validate.middleware');
const {
    createIncidentSchema,
    listIncidentsQuerySchema,
    approveAndAssignSchema,
    progressNoteSchema,
    requestClosureSchema,
    finalizeClosureSchema,
    rejectClosureSchema,
    addEvidenceSchema,
    updateDescriptionSchema,
    evidenceParamSchema,
    templateFormatQuerySchema,
} = require('../validators/incidentValidators');
const { objectIdParamSchema } = require('../validators/commonValidators');
const { nameSchema } = require('../validators/optionValidators');

// ─── Static reference data routes ────────────────────────────────────────────
router.get('/categories', protect, getCategories);
router.post('/categories', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(nameSchema), addCategory);
router.put('/categories/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(nameSchema), updateCategory);
router.delete('/categories/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), deleteCategory);

router.get('/locations', protect, getLocations);
router.post('/locations', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(nameSchema), addLocation);
router.put('/locations/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(nameSchema), updateLocation);
router.delete('/locations/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), deleteLocation);

// ─── Distinct filters (static — must precede /:id) ───────────────────────────
router.get('/classes', protect, async (req, res, next) => {
    try {
        res.json(await incidentService.getDistinctClasses(req.user));
    } catch (err) {
        next(err);
    }
});

router.get('/sections', protect, async (req, res, next) => {
    try {
        res.json(await incidentService.getDistinctSections(req.user));
    } catch (err) {
        next(err);
    }
});

router.get('/location-distribution', protect, validate(listIncidentsQuerySchema, 'query'), getIncidentLocationDistribution);
router.get('/summary', protect, validate(listIncidentsQuerySchema, 'query'), getIncidentSummary);
router.get('/analytics', protect, validate(listIncidentsQuerySchema, 'query'), getProfessionalAnalytics);
router.get('/analytics/details', protect, validate(listIncidentsQuerySchema, 'query'), getProfessionalAnalyticsDetails);

// ─── Template download ────────────────────────────────────────────────────────
router.get('/template', protect, validate(templateFormatQuerySchema, 'query'), downloadTemplate);

// ─── Bulk upload from Excel ───────────────────────────────────────────────────
router.post(
    '/upload',
    protect,
    upload.local.single('file'),
    upload.validateFileTypes,
    uploadIncidents
);

// ─── Collection routes ────────────────────────────────────────────────────────
router
    .route('/')
    .get(protect, validate(listIncidentsQuerySchema, 'query'), getIncidents)
    .post(
        protect,
        upload.array('evidence', 10),
        upload.validateFileTypes,
        upload.uploadValidatedFilesToS3,
        validate(createIncidentSchema),
        createIncident,
        upload.cleanupUploadedS3OnError
    );

// ─── Single incident — must be defined BEFORE workflow sub-routes ─────────────
router.put('/:id/read', protect, validate(objectIdParamSchema, 'params'), markIncidentRead);
router.get('/:id', protect, validate(objectIdParamSchema, 'params'), getIncidentById);
router.delete('/:id', protect, authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), deleteIncident);

// ─── Export Case Report ───────────────────────────────────────────────────────
router.get('/:id/export-report', protect, validate(objectIdParamSchema, 'params'), exportIncidentReport);

// ─── Workflow transitions (PUT — aligned with frontend apiClient) ─────────────
router.put('/:id/approve', protect, authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), validate(approveAndAssignSchema), approveAndAssign);
router.put('/:id/progress', protect, validate(objectIdParamSchema, 'params'), validate(progressNoteSchema), addProgressNote);
router.put('/:id/description', protect, validate(objectIdParamSchema, 'params'), validate(updateDescriptionSchema), updateIncidentDescription);
router.put('/:id/request-closure', protect, validate(objectIdParamSchema, 'params'), validate(requestClosureSchema), requestClosure);
router.put('/:id/finalize-closure', protect, authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), validate(finalizeClosureSchema), finalizeClosure);
router.put('/:id/reject-closure', protect, authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), validate(rejectClosureSchema), rejectClosure);

// ─── Evidence upload ──────────────────────────────────────────────────────────
router.put(
    '/:id/add-evidence',
    protect,
    validate(objectIdParamSchema, 'params'),
    upload.array('evidence', 10),
    upload.validateFileTypes,
    upload.uploadValidatedFilesToS3,
    validate(addEvidenceSchema),
    addIncidentEvidence,
    upload.cleanupUploadedS3OnError
);

router.delete(
    '/:id/evidence/:evidenceId',
    protect,
    validate(evidenceParamSchema, 'params'),
    deleteIncidentEvidence
);

module.exports = router;
