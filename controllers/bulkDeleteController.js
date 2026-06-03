'use strict';

const bulkDeleteService = require('../services/bulkDeleteService');

const previewBulkDelete = async (req, res, next) => {
    try {
        const result = await bulkDeleteService.previewBulkDelete({
            moduleName: req.params.module,
            payload: req.body || {},
            actor: req.user,
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
};

const executeBulkDelete = async (req, res, next) => {
    try {
        const result = await bulkDeleteService.executeBulkDelete({
            moduleName: req.params.module,
            payload: req.body || {},
            actor: req.user,
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    previewBulkDelete,
    executeBulkDelete,
};
