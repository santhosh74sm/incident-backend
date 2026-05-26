const express = require('express');
const router = express.Router();
const {
    getEvidenceTypes,
    addEvidenceType,
    updateEvidenceType,
    deleteEvidenceType
} = require('../controllers/evidenceTypeController');
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { evidenceTypeSchema } = require('../validators/optionValidators');
const { objectIdParamSchema } = require('../validators/commonValidators');

// Public route for getting evidence types (for dropdown)
router.get('/', getEvidenceTypes);

// Admin and Teacher routes
router.post('/', protect, authorize('Admin', 'Teacher'), validate(evidenceTypeSchema), addEvidenceType);
router.put('/:id', protect, authorize('Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(evidenceTypeSchema), updateEvidenceType);
router.delete('/:id', protect, authorize('Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), deleteEvidenceType);

module.exports = router;
