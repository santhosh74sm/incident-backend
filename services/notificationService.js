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

const pushToUsers = async (recipients = []) => {
    const pendingRecipients = [];
    const seen = new Set();
    recipients.forEach(({ userId, schoolId = null }) => {
        const key = String(userId || '');
        if (!key || seen.has(key) || pushDebounceMap.has(key)) return;
        seen.add(key);
        pushDebounceMap.set(key, true);
        setTimeout(() => pushDebounceMap.delete(key), 300);
        pendingRecipients.push({ userId: key, schoolId });
    });
    if (pendingRecipients.length === 0) return;

    try {
        const groupsBySchool = new Map();
        pendingRecipients.forEach((recipient) => {
            const schoolKey = recipient.schoolId ? String(recipient.schoolId) : '';
            if (!groupsBySchool.has(schoolKey)) groupsBySchool.set(schoolKey, []);
            groupsBySchool.get(schoolKey).push(recipient);
        });

        const groupedResults = await Promise.all([...groupsBySchool.entries()].map(async ([schoolId, schoolRecipients]) => {
            const recipientIds = schoolRecipients.map(({ userId }) => new mongoose.Types.ObjectId(userId));
            return Notification.aggregate([
                {
                    $match: {
                        recipient: { $in: recipientIds },
                        ...(schoolId ? { schoolId } : {}),
                    },
                },
                { $sort: { createdAt: -1 } },
                { $group: { _id: '$recipient', notifications: { $push: '$$ROOT' } } },
                { $project: { notifications: { $slice: ['$notifications', NOTIFICATION_LIMIT] } } },
            ]).allowDiskUse(true);
        }));

        const resultByRecipient = new Map();
        const notificationsToPopulate = [];
        groupedResults.flat().forEach((entry) => {
            const notifications = entry.notifications || [];
            resultByRecipient.set(String(entry._id), notifications);
            notificationsToPopulate.push(...notifications);
        });
        await Notification.populate(notificationsToPopulate, {
            path: 'incident',
            select: 'title status class section studentsInvolved category admissionNo',
        });

        const sseManager = require('../utils/sseManager');
        pendingRecipients.forEach(({ userId }) => {
            sseManager.sendToUser(userId, 'notifications', resultByRecipient.get(userId) || []);
        });
    } catch (err) {
        logger.warn('SSE notification batch push failed', {
            userIds: pendingRecipients.map(({ userId }) => userId),
            error: err.message,
        });
    }
};

const pushToUser = async (userId, schoolId = null) => pushToUsers([{ userId, schoolId }]);

// ─────────────────────────────────────────────────────────────────────────────

const getMyNotifications = async (userId, schoolId) => {
    const notifications = await Notification.find({ recipient: userId, schoolId })
        .populate('incident', 'title status class section studentsInvolved category admissionNo')
        .sort({ createdAt: -1 })
        .limit(NOTIFICATION_LIMIT)
        .lean();

    return notifications;
};

const getUnreadCount = async (userId, schoolId) => ({
    count: await Notification.countDocuments({ recipient: userId, schoolId, read: false }),
});

const assertObjectId = (id, message) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new AppError(message, 400);
    }
};

const markAsRead = async ({ notificationId, userId, schoolId }) => {
    assertObjectId(notificationId, 'Invalid notification ID');

    const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipient: userId, schoolId },
        { read: true },
        { new: true, lean: true }
    );

    if (!notification) {
        throw new AppError('Notification not found', 404);
    }

    return notification;
};

const markAsReadByIncident = async ({ incidentId, userId, schoolId }) => {
    assertObjectId(incidentId, 'Invalid incident ID');

    await Notification.updateMany(
        { incident: incidentId, recipient: userId, schoolId },
        { read: true }
    );

    return { message: 'Notifications marked as read.' };
};

const markAllAsRead = async (userId, schoolId) => {
    await Notification.updateMany({ recipient: userId, schoolId, read: false }, { read: true });
    return { message: 'All notifications marked as read.' };
};

const deleteNotification = async ({ notificationId, userId, schoolId }) => {
    assertObjectId(notificationId, 'Invalid notification ID');

    const notification = await Notification.findOneAndDelete({
        _id: notificationId,
        recipient: userId,
        schoolId,
    }).lean();

    if (!notification) {
        throw new AppError('Notification not found', 404);
    }

    return { message: 'Notification deleted.' };
};

const deleteAllNotifications = async (userId, schoolId) => {
    await Notification.deleteMany({ recipient: userId, schoolId });
    return { message: 'All notifications deleted.' };
};

/**
 * Insert notifications and push updates to all affected users via SSE.
 * Called by logger.js / incidentService after creating notifications.
 */
const insertAndPush = async (notificationDocuments, options = {}) => {
    if (!notificationDocuments || notificationDocuments.length === 0) return;

    await Notification.insertMany(notificationDocuments, { ordered: false, ...options });

    // Refresh every affected recipient from one grouped query per school.
    const recipientsById = new Map();
    notificationDocuments.forEach((document) => {
        const userId = String(document.recipient || '');
        if (userId && !recipientsById.has(userId)) {
            recipientsById.set(userId, { userId, schoolId: document.schoolId });
        }
    });
    await pushToUsers([...recipientsById.values()]);
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
    pushToUsers,
    pushToUser,
};
