'use strict';

/**
 * notificationController.js
 * Thin HTTP adapter for notification operations.
 * Includes SSE stream endpoint for real-time push delivery.
 */

const notificationService = require('../services/notificationService');
const sseManager = require('../utils/sseManager');
const logger = require('../utils/pinoLogger');

// ─────────────────────────────────────────────────────────────────────────────
// SSE stream — GET /api/notifications/stream
// Browser connects once; server pushes events whenever notifications change.
// ─────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15000; // 15s — matches sseManager global heartbeat

const streamNotifications = async (req, res) => {
    const userId = String(req.user._id || req.user.id);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Register this connection
    sseManager.addClient(userId, res);

    // Send current notifications immediately on connect
    try {
        const notifications = await notificationService.getMyNotifications(userId);
        res.write(`event: init\ndata: ${JSON.stringify(notifications)}\n\n`);
    } catch {
        res.write(`event: init\ndata: []\n\n`);
    }

    // Heartbeat to keep the connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch {
            clearInterval(heartbeat);
        }
    }, HEARTBEAT_INTERVAL_MS);

    // Clean up on client disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        sseManager.removeClient(userId, res);
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// REST endpoints
// ─────────────────────────────────────────────────────────────────────────────

const getMyNotifications = async (req, res, next) => {
    try {
        res.json(await notificationService.getMyNotifications(req.user.id));
    } catch (error) {
        next(error);
    }
};

const getUnreadCount = async (req, res, next) => {
    try {
        res.json(await notificationService.getUnreadCount(req.user.id));
    } catch (error) {
        next(error);
    }
};

const markAsRead = async (req, res, next) => {
    try {
        const result = await notificationService.markAsRead({
            notificationId: req.params.id,
            userId: req.user.id,
        });

        // Push updated list to all this user's SSE connections
        notificationService
            .getMyNotifications(req.user.id)
            .then((notifications) => sseManager.sendToUser(String(req.user._id || req.user.id), 'notifications', notifications))
            .catch((err) => {
                logger.error('SSE notification refresh failed', { error: err.message });
            });

        res.json(result);
    } catch (error) {
        next(error);
    }
};

const markAsReadByIncident = async (req, res, next) => {
    try {
        const result = await notificationService.markAsReadByIncident({
            incidentId: req.params.incidentId,
            userId: req.user.id,
        });

        notificationService
            .getMyNotifications(req.user.id)
            .then((notifications) => sseManager.sendToUser(String(req.user._id || req.user.id), 'notifications', notifications))
            .catch((err) => {
                logger.error('SSE notification refresh failed', { error: err.message });
            });

        res.json(result);
    } catch (error) {
        next(error);
    }
};

const markAllAsRead = async (req, res, next) => {
    try {
        const result = await notificationService.markAllAsRead(req.user.id);

        notificationService
            .getMyNotifications(req.user.id)
            .then((notifications) => sseManager.sendToUser(String(req.user._id || req.user.id), 'notifications', notifications))
            .catch((err) => {
                logger.error('SSE notification refresh failed', { error: err.message });
            });

        res.json(result);
    } catch (error) {
        next(error);
    }
};

const deleteNotification = async (req, res, next) => {
    try {
        const result = await notificationService.deleteNotification({
            notificationId: req.params.id,
            userId: req.user.id,
        });

        notificationService
            .getMyNotifications(req.user.id)
            .then((notifications) => sseManager.sendToUser(String(req.user._id || req.user.id), 'notifications', notifications))
            .catch((err) => {
                logger.error('SSE notification refresh failed', { error: err.message });
            });

        res.json(result);
    } catch (error) {
        next(error);
    }
};

const deleteAllNotifications = async (req, res, next) => {
    try {
        const result = await notificationService.deleteAllNotifications(req.user.id);
        sseManager.sendToUser(String(req.user._id || req.user.id), 'notifications', []);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    streamNotifications,
    getMyNotifications,
    getUnreadCount,
    markAsRead,
    markAsReadByIncident,
    markAllAsRead,
    deleteNotification,
    deleteAllNotifications,
};
