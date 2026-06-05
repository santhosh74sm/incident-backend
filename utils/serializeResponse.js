'use strict';

const mongoose = require('mongoose');
const { protectS3UrlValue } = require('./protectedFileUrl');

const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;
const PRIVATE_RESPONSE_KEYS = new Set(['schoolId']);

const serializeValue = (value, seen = new WeakMap()) => {
    if (value == null) return value;
    if (isObjectId(value)) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value;

    if (Array.isArray(value)) {
        return value.map((item) => serializeValue(item, seen));
    }

    if (typeof value !== 'object') return protectS3UrlValue(value);

    const plainValue = typeof value.toObject === 'function'
        ? value.toObject({ virtuals: true })
        : value;

    if (plainValue instanceof Map) {
        return serializeValue(Object.fromEntries(plainValue), seen);
    }

    if (seen.has(plainValue)) return seen.get(plainValue);

    const output = {};
    seen.set(plainValue, output);

    for (const [key, entry] of Object.entries(plainValue)) {
        if (PRIVATE_RESPONSE_KEYS.has(key)) continue;
        if (key === '__v') continue;
        if (key === '_id') {
            if (output.id == null && entry != null) {
                output.id = serializeValue(entry, seen);
            }
            continue;
        }
        output[key] = serializeValue(entry, seen);
    }

    return output;
};

module.exports = {
    serializeValue,
};
