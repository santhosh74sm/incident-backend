'use strict';

const { serializeValue } = require('../utils/serializeResponse');

const serializeJsonResponses = (req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = (payload) => originalJson(serializeValue(payload));
    res.send = (payload) => {
        if (
            payload &&
            typeof payload === 'object' &&
            !Buffer.isBuffer(payload) &&
            !(payload instanceof Uint8Array)
        ) {
            return originalJson(serializeValue(payload));
        }

        return originalSend(payload);
    };

    next();
};

module.exports = serializeJsonResponses;
