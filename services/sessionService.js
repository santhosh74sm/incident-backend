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
        schoolId: user.schoolId,
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

const revokeActiveFamilySessions = async (familyId, update = {}) => {
    await RefreshToken.updateMany(
        { familyId, revokedAt: null },
        { revokedAt: new Date(), ...update }
    );
};

const rotateRefreshSession = async ({ rawRefreshToken, req }) => {
    if (!rawRefreshToken) {
        throw new AppError('Refresh token missing', 401);
    }

    const tokenHash = hashToken(rawRefreshToken);
    const claimedAt = new Date();
    const session = await RefreshToken.findOneAndUpdate(
        { tokenHash, revokedAt: null },
        { revokedAt: claimedAt, revokedReason: 'rotated' },
        { returnDocument: 'after' }
    ).exec();

    if (!session) {
        const existingSession = await RefreshToken.findOne({ tokenHash }).exec();

        if (!existingSession) {
            throw new AppError('Refresh session not found', 401);
        }

        if (existingSession.revokedReason === 'rotated' || existingSession.replacedBy) {
            throw new AppError('Refresh session already rotated', 401);
        }

        existingSession.reuseDetectedAt = new Date();
        await existingSession.save();
        await revokeActiveFamilySessions(existingSession.familyId, {
            reuseDetectedAt: new Date(),
            revokedReason: 'reuse_detected',
        });
        throw new AppError('Refresh session reused', 401);
    }

    if (session.expiresAt <= new Date()) {
        session.reuseDetectedAt = new Date();
        session.revokedReason = 'expired';
        await session.save();
        await revokeActiveFamilySessions(session.familyId, {
            reuseDetectedAt: new Date(),
            revokedReason: 'expired',
        });
        throw new AppError('Refresh session expired', 401);
    }

    const user = await findUser(session.user, session.type);
    if (!user) {
        await revokeActiveFamilySessions(session.familyId, { revokedReason: 'account_not_found' });
        throw new AppError('Account not found', 401);
    }

    if ((user.tokenVersion ?? 0) !== (session.tokenVersion ?? 0)) {
        await revokeActiveFamilySessions(session.familyId, { revokedReason: 'token_version_mismatch' });
        throw new AppError('Session invalidated', 401);
    }

    const nextRawToken = await createRefreshSession({
        user,
        type: session.type,
        req,
        familyId: session.familyId,
    });

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
