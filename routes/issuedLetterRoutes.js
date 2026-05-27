const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { objectIdParamSchema, incidentIdParamSchema, admissionNoParamSchema, paginationQuerySchema } = require('../validators/commonValidators');
const {
    batchIncidentIdsSchema,
    createIssuedLetterSchema,
    updateIssuedLetterSchema,
    studentLettersQuerySchema,
} = require('../validators/issuedLetterValidators');
const {
    getIssuedLetters,
    getIssuedLetterById,
    getLetterByIncident,
    getLettersByStudent,
    getLetterStatusByIncidentIds,
    createIssuedLetterFromIncident,
    updateIssuedLetter,
    deleteIssuedLetter,
    getFilters,
    downloadIssuedLetter
} = require('../controllers/issuedLetterController');

// All routes require authentication
router.use(protect);

// Get filters for dropdowns (Admin only)
router.get('/filters', authorize('Super Admin', 'Admin'), getFilters);

// Get letter status for multiple incidents (POST)
router.post('/status/batch', validate(batchIncidentIdsSchema), getLetterStatusByIncidentIds);

// Get letters by student admission number
router.get('/student/:admissionNo', validate(admissionNoParamSchema, 'params'), validate(studentLettersQuerySchema, 'query'), getLettersByStudent);

// Get letters by incident ID (for incident detail page)
router.get('/incident/:incidentId', validate(incidentIdParamSchema, 'params'), getLetterByIncident);

// Download generated letter as DOCX (Admin only)
router.get('/:id/download', authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), downloadIssuedLetter);

// Letter management routes
router.route('/')
    .get(authorize('Super Admin', 'Admin'), validate(paginationQuerySchema, 'query'), getIssuedLetters)
    .post(authorize('Super Admin', 'Admin', 'Teacher'), validate(createIssuedLetterSchema), createIssuedLetterFromIncident);

router.route('/:id')
    .get(authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), getIssuedLetterById)
    .put(authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), validate(updateIssuedLetterSchema), updateIssuedLetter)
    .delete(authorize('Super Admin', 'Admin'), validate(objectIdParamSchema, 'params'), deleteIssuedLetter);

module.exports = router;
