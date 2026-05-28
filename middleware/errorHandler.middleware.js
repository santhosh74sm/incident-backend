const logger = require('../utils/pinoLogger');

const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }

    let statusCode = err.statusCode || err.status || (res.statusCode === 200 ? 500 : res.statusCode);
    let message = err.message || 'Internal server error';
    let validationErrors;
    const isProduction = process.env.NODE_ENV === 'production';

    if (err.name === 'CastError' || err.name === 'BSONError') {
        statusCode = 400;
        message = 'Some search details are not valid.';
    } else if (err.name === 'ValidationError' && err.errors) {
        statusCode = 400;
        message = 'Validation failed';
        validationErrors = Object.fromEntries(
            Object.entries(err.errors).map(([key, val]) => [key, val?.message || String(val)])
        );
    } else if (err.code === 11000) {
        statusCode = 409;
        message = 'Duplicate record';
    }

    if (statusCode >= 500) {
        logger.error('Internal server error', {
            statusCode,
            path: req.path,
            method: req.method,
            error: err.message,
            stack: isProduction ? undefined : err.stack,
        });
    } else if (statusCode >= 400 && process.env.NODE_ENV !== 'production') {
        logger.warn('Client error', {
            statusCode,
            path: req.path,
            method: req.method,
            error: message,
        });
    }

    const payload = {
        message: statusCode >= 500 && isProduction ? 'Internal server error' : message,
    };

    if (typeof err.code === 'string' && statusCode < 500) {
        payload.code = err.code;
    }

    if (statusCode === 400 && validationErrors) {
        payload.errors = validationErrors;
    }

    if (!isProduction && statusCode >= 500) {
        payload.stack = err.stack;
    }

    res.status(statusCode).json(payload);
};

module.exports = errorHandler;
