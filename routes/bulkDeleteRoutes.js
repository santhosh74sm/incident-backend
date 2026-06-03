const express = require('express');
const router = express.Router();

const { protect, authorize } = require('../middleware/authMiddleware');
const {
    previewBulkDelete,
    executeBulkDelete,
} = require('../controllers/bulkDeleteController');

router.use(protect, authorize('Super Admin'));

router.post('/:module/preview', previewBulkDelete);
router.post('/:module/execute', executeBulkDelete);

module.exports = router;
