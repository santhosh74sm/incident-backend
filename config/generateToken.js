const jwt = require('jsonwebtoken');
const env = require('./env');

const SECRETS = {
    staff: env.JWT_SECRET_STAFF,
    student: env.JWT_SECRET_STUDENT,
};

const generateToken = (user, type = 'staff') => {
    const secret = SECRETS[type];
    if (!secret) {
        throw new Error(`JWT secret is not configured for token type: ${type}`);
    }

    const id = user?._id || user?.id || user;
    const role = user?.role || (type === 'student' ? 'Student' : undefined);
    const schoolId = user?.schoolId;

    return jwt.sign(
        {
            sub: id.toString(),
            type,
            role,
            schoolId,
            tokenVersion: user?.tokenVersion ?? 0,
        },
        secret,
        {
            algorithm: 'HS256',
            expiresIn: env.JWT_ACCESS_EXPIRES_IN || '15m',
        }
    );
};

module.exports = generateToken;
