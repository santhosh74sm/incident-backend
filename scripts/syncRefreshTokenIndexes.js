const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const RefreshToken = require('../models/RefreshToken');

const EXPECTED_INDEXES = [
    {
        name: 'tokenHash_1',
        key: { tokenHash: 1 },
        options: { unique: true, name: 'tokenHash_1' },
    },
    {
        name: 'expiresAt_1',
        key: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, name: 'expiresAt_1' },
    },
    {
        name: 'schoolId_1_user_1_familyId_1',
        key: { schoolId: 1, user: 1, familyId: 1 },
        options: { name: 'schoolId_1_user_1_familyId_1' },
    },
    {
        name: 'user_1',
        key: { user: 1 },
        options: { name: 'user_1' },
    },
    {
        name: 'schoolId_1',
        key: { schoolId: 1 },
        options: { name: 'schoolId_1' },
    },
    {
        name: 'familyId_1',
        key: { familyId: 1 },
        options: { name: 'familyId_1' },
    },
];

const normalizeKey = (key) => JSON.stringify(key || {});

const getMissingIndexes = (existingIndexes) => {
    const existingByName = new Map(existingIndexes.map((index) => [index.name, index]));
    const existingKeys = new Set(existingIndexes.map((index) => normalizeKey(index.key)));

    return EXPECTED_INDEXES.filter((expected) => {
        const byName = existingByName.get(expected.name);
        if (byName && normalizeKey(byName.key) === normalizeKey(expected.key)) {
            if (expected.options.unique && !byName.unique) return true;
            if (
                Object.prototype.hasOwnProperty.call(expected.options, 'expireAfterSeconds') &&
                byName.expireAfterSeconds !== expected.options.expireAfterSeconds
            ) {
                return true;
            }
            return false;
        }

        return !existingKeys.has(normalizeKey(expected.key));
    });
};

const summarizeIndexes = (indexes) =>
    indexes.map((index) => ({
        name: index.name,
        key: index.key,
        unique: Boolean(index.unique),
        expireAfterSeconds: index.expireAfterSeconds,
    }));

const syncRefreshTokenIndexes = async ({ apply = false } = {}) => {
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI environment variable is not set.');
    }

    await mongoose.connect(process.env.MONGO_URI, {
        autoIndex: false,
        maxPoolSize: 2,
        serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
    });

    try {
        const existingBefore = await RefreshToken.collection.indexes();
        const missing = getMissingIndexes(existingBefore);
        const expiredTokenCount = await RefreshToken.countDocuments({ expiresAt: { $lte: new Date() } });

        console.log(JSON.stringify({
            collection: RefreshToken.collection.name,
            mode: apply ? 'apply' : 'audit',
            existingBefore: summarizeIndexes(existingBefore),
            expiredTokenCount,
            missing: missing.map(({ name, key, options }) => ({ name, key, options })),
        }, null, 2));

        if (!apply || missing.length === 0) {
            return;
        }

        for (const index of missing) {
            await RefreshToken.collection.createIndex(index.key, index.options);
        }

        const existingAfter = await RefreshToken.collection.indexes();
        console.log(JSON.stringify({
            collection: RefreshToken.collection.name,
            mode: 'verified',
            existingAfter: summarizeIndexes(existingAfter),
            expiredTokenCount: await RefreshToken.countDocuments({ expiresAt: { $lte: new Date() } }),
            missingAfter: getMissingIndexes(existingAfter).map(({ name, key, options }) => ({ name, key, options })),
        }, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    syncRefreshTokenIndexes({ apply: process.argv.includes('--apply') })
        .catch((error) => {
            console.error(JSON.stringify({
                error: error.message,
                code: error.code,
                codeName: error.codeName,
            }, null, 2));
            process.exit(1);
        });
}

module.exports = syncRefreshTokenIndexes;
