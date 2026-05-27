const csurf = require('csurf');
const { getCsrfCookieOptions } = require('../config/authCookies');

const csrfProtection = csurf({
    cookie: {
        key: '_csrf',
        ...getCsrfCookieOptions(),
    },
    value: (req) => req.get('X-CSRF-Token') || req.body?._csrf || req.query?._csrf,
});

const issueCsrfToken = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ csrfToken: req.csrfToken() });
};

module.exports = {
    csrfProtection,
    issueCsrfToken,
};
