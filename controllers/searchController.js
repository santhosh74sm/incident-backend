const searchService = require('../services/searchService');

const globalSearch = async (req, res, next) => {
    try {
        res.json(await searchService.globalSearch(req.query?.query));
    } catch (error) {
        error.message = 'Search failed';
        next(error);
    }
};

module.exports = { globalSearch };
