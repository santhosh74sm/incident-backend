'use strict';

/**
 * sseManager.js
 * Manages Server-Sent Event (SSE) client connections.
 *
 * Usage:
 *   sseManager.addClient(userId, res)   — register a connected browser tab
 *   sseManager.removeClient(userId, res) — clean up on disconnect
 *   sseManager.sendToUser(userId, event, data) — push event to all tabs of a user
 *   sseManager.broadcast(event, data)   — push to every connected client
 */

const logger = require('../utils/pinoLogger');

// Map<userId, Set<res>>
const clients = new Map();

const addClient = (userId, res) => {
    if (!clients.has(userId)) {
        clients.set(userId, new Set());
    }
    clients.get(userId).add(res);
    logger.debug('SSE client connected', { userId, total: clients.get(userId).size });
};

const removeClient = (userId, res) => {
    const userClients = clients.get(userId);
    if (!userClients) return;
    userClients.delete(res);
    if (userClients.size === 0) {
        clients.delete(userId);
    }
    logger.debug('SSE client disconnected', { userId });
};

/**
 * Format a Server-Sent Event frame.
 * @param {string} event  — event name
 * @param {*}      data   — any JSON-serializable payload
 */
const formatEvent = (event, data) => {
    const json = JSON.stringify(data);
    return `event: ${event}\ndata: ${json}\n\n`;
};

/**
 * Send an SSE event to all active connections for a specific user.
 */
const sendToUser = (userId, event, data) => {
    const userClients = clients.get(String(userId));
    if (!userClients || userClients.size === 0) return;

    const frame = formatEvent(event, data);
    const dead = [];

    userClients.forEach((res) => {
        try {
            res.write(frame);
        } catch {
            dead.push(res);
        }
    });

    // Clean up dead connections
    dead.forEach((res) => removeClient(String(userId), res));
};

/**
 * Send an SSE event to every connected client.
 */
const broadcast = (event, data) => {
    const frame = formatEvent(event, data);
    clients.forEach((userClients, userId) => {
        const dead = [];
        userClients.forEach((res) => {
            try {
                res.write(frame);
            } catch {
                dead.push(res);
            }
        });
        dead.forEach((res) => removeClient(userId, res));
    });
};

/**
 * Count total connected clients across all users.
 */
const getConnectionCount = () => {
    let total = 0;
    clients.forEach((set) => { total += set.size; });
    return total;
};

// ─── HEARTBEAT MECHANISM ──────────────────────────────────────────────────────
// Prevents the browser or proxies from timing out the SSE connection
// during long-running bulk upload operations.

setInterval(() => {
    clients.forEach((userClients, userId) => {
        const dead = [];
        userClients.forEach((res) => {
            try {
                res.write(':\n\n'); // Empty comment is a standard SSE heartbeat
            } catch {
                dead.push(res);
            }
        });
        dead.forEach((res) => removeClient(userId, res));
    });
}, 15000); // Send keep-alive every 15 seconds

module.exports = { addClient, removeClient, sendToUser, broadcast, getConnectionCount };
