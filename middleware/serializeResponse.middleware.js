'use strict';

const { serializeValue } = require('../utils/serializeResponse');

const serializeJsonResponses = (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (payload) => originalJson(serializeValue(payload));

    next();
};

module.exports = serializeJsonResponses;
