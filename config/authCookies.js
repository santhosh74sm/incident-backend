const env = require('./env');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const isProduction = env.NODE_ENV === 'production';

const accessMaxAgeMs = Number(process.env.ACCESS_COOKIE_MAX_AGE_MS) || 15 * 60 * 1000;
const refreshMaxAgeMs = Number(process.env.REFRESH_COOKIE_MAX_AGE_MS) || 30 * ONE_DAY_MS;

const configuredOrigins = (env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const usesHttpsOrigin = configuredOrigins.some((origin) => origin.startsWith('https://'));
const forceSecureCookies = process.env.COOKIE_SECURE === 'true';
const useCrossSiteCookies = isProduction || usesHttpsOrigin || forceSecureCookies;

const baseCookieOptions = () => ({
    httpOnly: true,
    secure: useCrossSiteCookies,
    sameSite: useCrossSiteCookies ? 'none' : 'lax',
    path: '/',
});

const getAuthCookieOptions = () => ({
    ...baseCookieOptions(),
    maxAge: accessMaxAgeMs,
});

const getRefreshCookieOptions = () => ({
    ...baseCookieOptions(),
    maxAge: refreshMaxAgeMs,
});

const getClearAuthCookieOptions = () => {
    const { maxAge, ...options } = baseCookieOptions();
    return options;
};

const setAuthCookie = (res, token) => {
    res.cookie('token', token, getAuthCookieOptions());
};

const setRefreshCookie = (res, token) => {
    res.cookie('refreshToken', token, getRefreshCookieOptions());
};

const clearAuthCookie = (res) => {
    res.clearCookie('token', getClearAuthCookieOptions());
};

const clearRefreshCookie = (res) => {
    res.clearCookie('refreshToken', getClearAuthCookieOptions());
};

const clearSessionCookies = (res) => {
    clearAuthCookie(res);
    clearRefreshCookie(res);
};

module.exports = {
    getAuthCookieOptions,
    getRefreshCookieOptions,
    getClearAuthCookieOptions,
    setAuthCookie,
    setRefreshCookie,
    clearAuthCookie,
    clearRefreshCookie,
    clearSessionCookies,
};
