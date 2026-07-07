const rateLimit = require('express-rate-limit');

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

const rateLimitHandler = (req, res) => {
    res.status(429).json({
        message: 'Too many requests. Please wait a moment and retry.',
        retryable: true,
    });
};

const rateLimitOptions = {
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    handler: rateLimitHandler,
};

const isProduction = process.env.NODE_ENV === 'production';
const defaultGlobalMax = isProduction ? 150 : 3000;

const globalApiRateLimiter = rateLimit({
    ...rateLimitOptions,
    limit: Number(process.env.RATE_LIMIT_MAX) || defaultGlobalMax,
});

const authSensitiveRateLimiter = rateLimit({
    ...rateLimitOptions,
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || windowMs,
    limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || (process.env.NODE_ENV === 'production' ? 10 : 100),
    message: undefined,
    handler: (req, res) => {
        res.status(429).json({
            message: 'Too many authentication attempts. Please try again later.',
            retryable: true,
        });
    },
});

module.exports = {
    globalApiRateLimiter,
    authSensitiveRateLimiter,
};
