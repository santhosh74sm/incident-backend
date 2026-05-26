const optionService = require('../services/optionService');

const getCategories = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.getCategories());
    } catch (error) {
        next(error);
    }
};

const addCategory = async (req, res, next) => {
    try {
        const category = await optionService.addCategory({ input: req.body, actor: req.user });
        res.status(201).json(category);
    } catch (error) {
        next(error);
    }
};

const updateCategory = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.updateCategory({
            id: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const deleteCategory = async (req, res, next) => {
    try {
        res.status(200).json(await optionService.deleteCategory({
            id: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = { getCategories, addCategory, updateCategory, deleteCategory };
