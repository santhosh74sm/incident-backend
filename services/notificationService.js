'use strict';

/**
 * notificationService.js
 * Business logic for notification CRUD.
 * After every write that affects a user's notification list,
 * the updated list is pushed via SSE (non-blocking, best-effort).
 */

const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const logger = require('../utils/pinoLogger');

const NOTIFICATION_LIMIT = 50;

// Cache TTL for notification pushes — prevent duplicate SSE pushes within 500ms
const pushDebounceMap = new Map();

// ─── SSE push helper (lazy import to avoid circular dependency) ───────────────

const pushToUser = async (userId) => {
    const key = String(userId);
    // Debounce: skip if a push for this user fired within the last 300ms
    if (pushDebounceMap.has(key)) return;
    pushDebounceMap.set(key, true);
    setTimeout(() => pushDebounceMap.delete(key), 300);

    try {
        const sseManager = require('../utils/sseManager');
        const notifications = await Notification.find({ recipient: userId })
            .populate('incident', 'title status class section studentsInvolved category admissionNo')
            .sort({ createdAt: -1 })
            .limit(NOTIFICATION_LIMIT)
            .lean();
        sseManager.sendToUser(String(userId), 'notifications', notifications);
    } catch (err) {
        logger.warn('SSE notification push failed', { userId: key, error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────

const trimUserNotifications = async (userId) => {
    const notificationsToKeep = await Notification.find({ recipient: userId })
        .sort({ createdAt: -1 })
        .limit(NOTIFICATION_LIMIT)
        .select('_id')
        .lean();

    if (notificationsToKeep.length >= NOTIFICATION_LIMIT) {
        await Notification.deleteMany({
            recipient: userId,
            _id: { $nin: notificationsToKeep.map((n) => n._id) },
        });
    }
};

const getMyNotifications = async (userId) => {
    const notifications = await Notification.find({ recipient: userId })
        .populate('incident', 'title status class section studentsInvolved category admissionNo')
        .sort({ createdAt: -1 })
        .limit(NOTIFICATION_LIMIT)
        .lean();

    trimUserNotifications(userId).catch((err) => {
        logger.error('Notification trim failed', { userId, error: err.message });
    });
    return notifications;
};

const getUnreadCount = async (userId) => ({
    count: await Notification.countDocuments({ recipient: userId, read: false }),
});

const assertObjectId = (id, message) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new AppError(message, 400);
    }
};

const markAsRead = async ({ notificationId, userId }) => {
    assertObjectId(notificationId, 'Invalid notification ID');

    const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipient: userId },
        { read: true },
        { new: true, lean: true }
    );

    if (!notification) {
        throw new AppError('Notification not found', 404);
    }

    return notification;
};

const markAsReadByIncident = async ({ incidentId, userId }) => {
    assertObjectId(incidentId, 'Invalid incident ID');

    await Notification.updateMany(
        { incident: incidentId, recipient: userId },
        { read: true }
    );

    return { message: 'Notifications marked as read' };
};

const markAllAsRead = async (userId) => {
    await Notification.updateMany({ recipient: userId, read: false }, { read: true });
    return { message: 'All notifications marked as read' };
};

const deleteNotification = async ({ notificationId, userId }) => {
    assertObjectId(notificationId, 'Invalid notification ID');

    const notification = await Notification.findOneAndDelete({
        _id: notificationId,
        recipient: userId,
    }).lean();

    if (!notification) {
        throw new AppError('Notification not found', 404);
    }

    return { message: 'Notification deleted' };
};

const deleteAllNotifications = async (userId) => {
    await Notification.deleteMany({ recipient: userId });
    return { message: 'All notifications deleted' };
};

/**
 * Insert notifications and push updates to all affected users via SSE.
 * Called by logger.js / incidentService after creating notifications.
 */
const insertAndPush = async (notificationDocuments) => {
    if (!notificationDocuments || notificationDocuments.length === 0) return;

    await Notification.insertMany(notificationDocuments, { ordered: false });

    // Deduplicate recipients and push updated list to each
    const recipientIds = [...new Set(notificationDocuments.map((n) => String(n.recipient)).filter(Boolean))];
    recipientIds.forEach((userId) => pushToUser(userId));
};

module.exports = {
    getMyNotifications,
    getUnreadCount,
    markAsRead,
    markAsReadByIncident,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
    insertAndPush,
    pushToUser,
};
