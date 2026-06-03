const optionService = require('../services/optionService');

const getEvidenceTypes = async (req, res, next) => {
    try {
        res.json(await optionService.getEvidenceTypes(req.user));
    } catch (error) {
        next(error);
    }
};

const addEvidenceType = async (req, res, next) => {
    try {
        const evidenceType = await optionService.addEvidenceType({ input: req.body, actor: req.user });
        res.status(201).json(evidenceType);
    } catch (error) {
        next(error);
    }
};

const updateEvidenceType = async (req, res, next) => {
    try {
        res.json(await optionService.updateEvidenceType({
            id: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const deleteEvidenceType = async (req, res, next) => {
    try {
        res.json(await optionService.deleteEvidenceType({
            id: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getEvidenceTypes,
    addEvidenceType,
    updateEvidenceType,
    deleteEvidenceType,
};
