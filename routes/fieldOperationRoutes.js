const express = require('express');
const router = express.Router();
const {
    getOptions,
    addOption,
    deleteOption,
    reorderOptions
} = require('../controllers/fieldOperationController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { fieldOperationOptionSchema, reorderOptionsSchema } = require('../validators/optionValidators');
const { objectIdParamSchema } = require('../validators/commonValidators');

router.get('/', getOptions);
router.post('/', protect, validate(fieldOperationOptionSchema), addOption);
router.delete('/:id', protect, validate(objectIdParamSchema, 'params'), deleteOption);
router.put('/reorder', protect, validate(reorderOptionsSchema), reorderOptions);

module.exports = router;
