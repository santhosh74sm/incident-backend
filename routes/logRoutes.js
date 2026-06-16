const express = require('express');
const router = express.Router();
const { getLogs, getNotificationFeed, clearLogs } = require('../controllers/logController');
const { protect, authorize } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { paginationQuerySchema } = require('../validators/commonValidators');

router.get('/notifications', protect, authorize('Super Admin', 'Admin', 'Teacher'), validate(paginationQuerySchema, 'query'), getNotificationFeed);

router.route('/')
    .get(protect, authorize('Super Admin'), validate(paginationQuerySchema, 'query'), getLogs)
    .delete(protect, authorize('Super Admin'), clearLogs);

module.exports = router;
