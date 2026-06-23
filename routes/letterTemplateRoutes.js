const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const upload = require('../middleware/uploadMiddleware');
const { objectIdParamSchema, categoryParamSchema } = require('../validators/commonValidators');
const {
    templateBodySchema,
    templateUploadSchema,
    templateDocumentDeleteSchema,
} = require('../validators/letterTemplateValidators');
const {
    getIncidentCategories,
    getLetterTemplates,
    getLetterTemplateById,
    createLetterTemplate,
    uploadTemplateFile,
    uploadTemplateFileController,
    updateLetterTemplate,
    deleteLetterTemplate,
    deleteTemplateDocument,
    downloadTemplate,
    downloadReferenceGuide,
    getSmartTags,
    getAvailablePlaceholders,
    getTemplateByCategory
} = require('../controllers/letterTemplateController');

// Get incident categories for dropdown - accessible by all authenticated users
router.get('/categories', protect, getIncidentCategories);

// Get available placeholders/smart tags - accessible by all authenticated users
/** @deprecated Use client-side tag guide in LetterTemplates.jsx; alias of /smart-tags */
router.get('/placeholders', protect, getAvailablePlaceholders);
router.get('/smart-tags', protect, getSmartTags);

// Get template by category - for Create Incident flow
router.get('/category/:category', protect, validate(categoryParamSchema, 'params'), getTemplateByCategory);

// Download Reference Guide - accessible by all authenticated users
/** @deprecated Frontend builds the reference guide client-side; retained for external API consumers */
router.get('/reference-guide', protect, downloadReferenceGuide);

// Template management routes
router.route('/')
    .get(protect, getLetterTemplates)
    .post(protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(templateBodySchema), createLetterTemplate);

router.route('/:id')
    .get(protect, validate(objectIdParamSchema, 'params'), getLetterTemplateById)
    .put(protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(templateBodySchema), updateLetterTemplate)
    .delete(protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), validate(templateDocumentDeleteSchema, 'query'), deleteTemplateDocument);

// Full template removal
router.delete('/document/:id', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(objectIdParamSchema, 'params'), deleteLetterTemplate);

// Upload template file
router.put(
    '/:id/upload',
    protect,
    authorize('Super Admin', 'Admin', 'Teacher'),
    validate(objectIdParamSchema, 'params'),
    uploadTemplateFile,
    upload.validateFileTypes,
    upload.uploadValidatedFilesToS3,
    validate(templateUploadSchema),
    uploadTemplateFileController
);

// Download template file - accessible by all authenticated users
router.get('/:id/download', protect, validate(objectIdParamSchema, 'params'), downloadTemplate);

module.exports = router;
