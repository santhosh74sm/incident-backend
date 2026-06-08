const crypto = require('crypto');
const logger = require('../utils/pinoLogger');

const CSRF_COOKIE_NAME = 'csrfToken';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_RESPONSE_HEADER_NAME = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const configuredOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';
const usesHttpsOrigin = configuredOrigins.some((origin) => origin.startsWith('https://'));
const forceSecureCookies = process.env.COOKIE_SECURE === 'true';
const useCrossSiteCookies = isProduction || usesHttpsOrigin || forceSecureCookies;

const csrfCookieOptions = {
    httpOnly: false,
    secure: useCrossSiteCookies,
    sameSite: useCrossSiteCookies ? 'none' : 'lax',
    path: '/',
};

const createCsrfToken = () => crypto.randomBytes(32).toString('base64url');

const setCsrfCookie = (res, token = createCsrfToken()) => {
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions);
    res.setHeader(CSRF_RESPONSE_HEADER_NAME, token);
    return token;
};

const clearCsrfCookie = (res) => {
    res.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions);
};

const constantTimeEqual = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));

    if (leftBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const isExemptPath = (req) => {
    const path = req.path || '';
    return (
        path === '/api/auth/login' ||
        path === '/api/auth/register' ||
        path === '/api/auth/workspaces' ||
        path === '/api/auth/admin-exists' ||
        path === '/api/auth/bootstrap-status'
    );
};

const csrfProtection = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
        setCsrfCookie(res, req.cookies?.[CSRF_COOKIE_NAME] || undefined);
        next();
        return;
    }

    if (isExemptPath(req)) {
        next();
        return;
    }

    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = req.get(CSRF_HEADER_NAME);

    if (!constantTimeEqual(cookieToken, headerToken)) {
        logger.warn('CSRF validation failed', {
            path: req.path,
            method: req.method,
            ip: req.ip,
            hasCookieToken: Boolean(cookieToken),
            hasHeaderToken: Boolean(headerToken),
        });
        return res.status(403).json({
            code: 'CSRF_TOKEN_INVALID',
            message: 'Security check failed. Please refresh and try again.',
        });
    }

    next();
};

module.exports = {
    CSRF_COOKIE_NAME,
    CSRF_RESPONSE_HEADER_NAME,
    clearCsrfCookie,
    csrfProtection,
    setCsrfCookie,
};
