const mongoose = require('mongoose');

const ensureDbReady = (req, res, next) => {
    if (mongoose.connection.readyState === 1) {
        next();
        return;
    }

    res.status(503).json({
        message: 'Database is reconnecting. Please retry shortly.',
        retryable: true
    });
};

module.exports = ensureDbReady;
