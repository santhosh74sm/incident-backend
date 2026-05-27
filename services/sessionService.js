const crypto = require('crypto');
const RefreshToken = require('../models/RefreshToken');
const User = require('../models/User');
const Student = require('../models/Student');
const generateToken = require('../config/generateToken');
const AppError = require('../utils/AppError');

const refreshTokenTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const createRawRefreshToken = () => crypto.randomBytes(48).toString('base64url');

const getRequestMetadata = (req) => ({
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.get('user-agent') || null,
});

const getUserModelName = (type) => (type === 'student' ? 'Student' : 'User');

const findUser = async (id, type) => {
    const model = type === 'student' ? Student : User;
    const user = await model.findById(id).select(type === 'student' ? '-password' : '-password').exec();
    if (user && type === 'student') user.role = 'Student';
    return user;
};

const createRefreshSession = async ({ user, type, req, familyId = crypto.randomUUID() }) => {
    const rawToken = createRawRefreshToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    const metadata = getRequestMetadata(req);

    await RefreshToken.create({
        user: user._id || user.id,
        userModel: getUserModelName(type),
        type,
        tokenHash,
        familyId,
        tokenVersion: user.tokenVersion ?? 0,
        expiresAt,
        ...metadata,
    });

    return rawToken;
};

const issueSession = async ({ user, type, req }) => ({
    accessToken: generateToken(user, type),
    refreshToken: await createRefreshSession({ user, type, req }),
});

const rotateRefreshSession = async ({ rawRefreshToken, req }) => {
    if (!rawRefreshToken) {
        throw new AppError('Refresh token missing', 401);
    }

    const tokenHash = hashToken(rawRefreshToken);
    const session = await RefreshToken.findOne({ tokenHash }).exec();

    if (!session) {
        throw new AppError('Refresh session not found', 401);
    }

    if (session.revokedAt || session.expiresAt <= new Date()) {
        session.reuseDetectedAt = new Date();
        await session.save();
        await RefreshToken.updateMany(
            { familyId: session.familyId, revokedAt: null },
            { revokedAt: new Date(), reuseDetectedAt: new Date() }
        );
        throw new AppError('Refresh session reused or expired', 401);
    }

    const user = await findUser(session.user, session.type);
    if (!user) {
        await RefreshToken.updateMany({ familyId: session.familyId, revokedAt: null }, { revokedAt: new Date() });
        throw new AppError('Account not found', 401);
    }

    if ((user.tokenVersion ?? 0) !== (session.tokenVersion ?? 0)) {
        await RefreshToken.updateMany({ familyId: session.familyId, revokedAt: null }, { revokedAt: new Date() });
        throw new AppError('Session invalidated', 401);
    }

    const nextRawToken = await createRefreshSession({
        user,
        type: session.type,
        req,
        familyId: session.familyId,
    });

    session.revokedAt = new Date();
    session.replacedBy = hashToken(nextRawToken);
    await session.save();

    return {
        user,
        type: session.type,
        accessToken: generateToken(user, session.type),
        refreshToken: nextRawToken,
    };
};

const revokeRefreshToken = async (rawRefreshToken) => {
    if (!rawRefreshToken) return;
    await RefreshToken.findOneAndUpdate(
        { tokenHash: hashToken(rawRefreshToken), revokedAt: null },
        { revokedAt: new Date() }
    );
};

const revokeUserSessions = async ({ userId, type }) => {
    await RefreshToken.updateMany(
        { user: userId, ...(type ? { type } : {}), revokedAt: null },
        { revokedAt: new Date() }
    );
};

module.exports = {
    issueSession,
    rotateRefreshSession,
    revokeRefreshToken,
    revokeUserSessions,
};
