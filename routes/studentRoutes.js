const express = require('express');
const router = express.Router();
const { 
    getFilters, getAllStudents, getStudentsByFilter, 
    deleteStudent, previewStudentDelete, uploadStudents, getStudentUploadStatus, createStudent,
    updateStudent, getStudentBehavioralSummary
} = require('../controllers/studentController');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const validate = require('../middleware/validate.middleware');
const { createStudentSchema, updateStudentSchema, studentFilterQuerySchema } = require('../validators/studentValidators');
const { objectIdParamSchema, paginationQuerySchema } = require('../validators/commonValidators');

// ─── Static routes (must come before /:id) ───────────────────────────────────
router.get('/filters', protect, getFilters);
router.get('/filter', protect, validate(studentFilterQuerySchema, 'query'), getStudentsByFilter);
router.get('/all', protect, getAllStudents);  // unpaginated — for dropdowns

// ─── Collection route (paginated) ────────────────────────────────────────────
router.get('/', protect, validate(paginationQuerySchema, 'query'), getAllStudents);
router.post('/', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(createStudentSchema), createStudent);

// ─── Upload ───────────────────────────────────────────────────────────────────
router.post('/upload', protect, authorize('Super Admin', 'Admin', 'Teacher'), upload.local.single('file'), upload.validateFileTypes, uploadStudents);
router.get('/upload/:jobId', protect, authorize('Super Admin', 'Admin', 'Teacher'), getStudentUploadStatus);

// ─── Dynamic ID routes ────────────────────────────────────────────────────────
router.get('/:id/behavioral-summary', protect, validate(objectIdParamSchema, 'params'), getStudentBehavioralSummary);
router.get('/:id/delete-preview', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), previewStudentDelete);
router.put('/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(updateStudentSchema), updateStudent);
router.delete('/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), deleteStudent);

module.exports = router;
