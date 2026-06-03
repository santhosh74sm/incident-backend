const optionService = require('../services/optionService');

const getOptions = async (req, res, next) => {
    try {
        res.json(await optionService.getFieldOperationOptions(req.query.type, req.user));
    } catch (error) {
        next(error);
    }
};

const addOption = async (req, res, next) => {
    try {
        const option = await optionService.addFieldOperationOption({ input: req.body, actor: req.user });
        res.status(201).json(option);
    } catch (error) {
        next(error);
    }
};

const deleteOption = async (req, res, next) => {
    try {
        res.json(await optionService.deleteFieldOperationOption(req.params.id, req.user));
    } catch (error) {
        next(error);
    }
};

const reorderOptions = async (req, res, next) => {
    try {
        res.json(await optionService.reorderFieldOperationOptions(req.body.options, req.user));
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getOptions,
    addOption,
    deleteOption,
    reorderOptions,
};
