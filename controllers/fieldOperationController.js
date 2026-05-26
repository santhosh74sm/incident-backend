const optionService = require('../services/optionService');

const getOptions = async (req, res, next) => {
    try {
        res.json(await optionService.getFieldOperationOptions(req.query.type));
    } catch (error) {
        next(error);
    }
};

const addOption = async (req, res, next) => {
    try {
        const option = await optionService.addFieldOperationOption({ input: req.body });
        res.status(201).json(option);
    } catch (error) {
        next(error);
    }
};

const deleteOption = async (req, res, next) => {
    try {
        res.json(await optionService.deleteFieldOperationOption(req.params.id));
    } catch (error) {
        next(error);
    }
};

const reorderOptions = async (req, res, next) => {
    try {
        res.json(await optionService.reorderFieldOperationOptions(req.body.options));
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
