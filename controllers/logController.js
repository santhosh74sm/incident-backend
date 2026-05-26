const logService = require('../services/logService');

const getLogs = async (req, res, next) => {
    try {
        res.json(await logService.getLogs(req.query));
    } catch (error) {
        next(error);
    }
};

const getNotificationFeed = async (req, res, next) => {
    try {
        res.json(await logService.getNotificationFeed({
            limit: req.query.limit,
            role: req.user?.role,
        }));
    } catch (error) {
        next(error);
    }
};

const clearLogs = async (req, res, next) => {
    try {
        res.json(await logService.clearLogs());
    } catch (error) {
        next(error);
    }
};

module.exports = { getLogs, getNotificationFeed, clearLogs };
