'use strict';

const crypto = require('crypto');
const env = require('../config/env');

const TOKEN_PREFIX = 'v1';
const AAD = Buffer.from('incident-tracker:s3-key:v1');

const getEncryptionKey = (secret) => crypto
    .createHash('sha256')
    .update(secret)
    .digest();

const getActiveEncryptionKey = () => getEncryptionKey(env.FILE_URL_SECRET);

const getLegacyDecryptionKeys = () => {
    const legacySecrets = [
        env.JWT_SECRET_STAFF,
        env.JWT_SECRET_STUDENT,
        env.JWT_SECRET,
    ].filter(Boolean);

    return [...new Set(legacySecrets)]
        .filter((secret) => secret !== env.FILE_URL_SECRET)
        .map(getEncryptionKey);
};

const encode = (buffer) => Buffer.from(buffer).toString('base64url');
const decode = (value) => Buffer.from(String(value || ''), 'base64url');

const encryptS3Key = (key) => {
    const normalizedKey = String(key || '');
    const iv = crypto
        .createHmac('sha256', getActiveEncryptionKey())
        .update(normalizedKey)
        .digest()
        .subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getActiveEncryptionKey(), iv);
    cipher.setAAD(AAD);

    const encrypted = Buffer.concat([
        cipher.update(normalizedKey, 'utf8'),
        cipher.final(),
    ]);

    return [TOKEN_PREFIX, encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join('.');
};

const decryptS3KeyToken = (token) => {
    const [prefix, iv, authTag, encrypted] = String(token || '').split('.');
    if (prefix !== TOKEN_PREFIX || !iv || !authTag || !encrypted) {
        return null;
    }

    const candidateKeys = [getActiveEncryptionKey(), ...getLegacyDecryptionKeys()];

    for (const key of candidateKeys) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(iv));
            decipher.setAAD(AAD);
            decipher.setAuthTag(decode(authTag));

            return Buffer.concat([
                decipher.update(decode(encrypted)),
                decipher.final(),
            ]).toString('utf8');
        } catch {
            // Try the next key so existing production evidence links remain readable after migration.
        }
    }

    return null;
};

const buildProtectedS3Url = (key) => `/api/uploads/s3/${encodeURIComponent(encryptS3Key(key))}`;

const protectS3UrlValue = (value) => {
    if (typeof value !== 'string') return value;

    const match = value.match(/^(\/api\/uploads\/s3\/)(schools\/[^?#]+)([?#].*)?$/);
    if (!match) return value;

    return `${match[1]}${encodeURIComponent(encryptS3Key(decodeURIComponent(match[2])))}${match[3] || ''}`;
};

module.exports = {
    buildProtectedS3Url,
    decryptS3KeyToken,
    protectS3UrlValue,
};
