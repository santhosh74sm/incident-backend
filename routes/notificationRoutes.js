'use strict';

const express = require('express');
const router = express.Router();
const {
    streamNotifications,
    getMyNotifications,
    getUnreadCount,
    markAsRead,
    markAsReadByIncident,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const {
    notificationIdParamSchema,
    notificationIncidentIdParamSchema,
} = require('../validators/notificationValidators');

// SSE stream — browser subscribes here for real-time push
router.get('/stream', protect, streamNotifications);

// REST fallback endpoints
router.get('/', protect, getMyNotifications);
router.get('/unread-count', protect, getUnreadCount);
router.put('/read-all', protect, markAllAsRead);
router.put('/read/:incidentId', protect, validate(notificationIncidentIdParamSchema, 'params'), markAsReadByIncident);
router.put('/:id/read', protect, validate(notificationIdParamSchema, 'params'), markAsRead);
router.delete('/', protect, deleteAllNotifications);
router.delete('/:id', protect, validate(notificationIdParamSchema, 'params'), deleteNotification);

module.exports = router;
