const logService = require('../services/logService');

const getLogs = async (req, res, next) => {
    try {
        res.json(await logService.getLogs(req.query, req.user));
    } catch (error) {
        next(error);
    }
};

const getNotificationFeed = async (req, res, next) => {
    try {
        res.json(await logService.getNotificationFeed({
            limit: req.query.limit,
            role: req.user?.role,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const clearLogs = async (req, res, next) => {
    try {
        res.json(await logService.clearLogs(req.user));
    } catch (error) {
        next(error);
    }
};

module.exports = { getLogs, getNotificationFeed, clearLogs };
