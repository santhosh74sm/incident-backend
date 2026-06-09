const optionService = require('../services/optionService');

const getLocations = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.getLocations(req.user, {
            includeUnknown: String(req.query.includeUnknown || '').toLowerCase() === 'true',
        }));
    } catch (error) {
        next(error);
    }
};

const addLocation = async (req, res, next) => {
    try {
        const location = await optionService.addLocation({ input: req.body, actor: req.user });
        res.status(201).json(location);
    } catch (error) {
        next(error);
    }
};

const updateLocation = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.updateLocation({
            id: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const deleteLocation = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.deleteLocation({
            id: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = { getLocations, addLocation, updateLocation, deleteLocation };
