'use strict';

const logger = require('../utils/pinoLogger');
const s3StorageService = require('./s3StorageService');
const { decryptS3KeyToken } = require('../utils/protectedFileUrl');

const extractS3KeyFromProtectedUrl = (fileUrl) => {
    const value = String(fileUrl || '');
    if (!value) return '';

    const decodeKey = (key) => {
        try {
            return decodeURIComponent(key);
        } catch {
            return key;
        }
    };

    const protectedMatch = value.match(/\/api\/uploads\/s3\/([^?#]+)/i);
    if (protectedMatch) {
        const tokenOrKey = decodeKey(protectedMatch[1]);
        const decryptedKey = decryptS3KeyToken(tokenOrKey);
        return decryptedKey || tokenOrKey;
    }

    try {
        const url = new URL(value);
        const bucket = process.env.AWS_BUCKET_NAME;
        const host = url.hostname.toLowerCase();
        const pathKey = decodeKey(url.pathname.replace(/^\/+/, ''));

        if (bucket && (
            host === `${bucket}.s3.amazonaws.com` ||
            host.startsWith(`${bucket}.s3.`) ||
            host === 's3.amazonaws.com' ||
            /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)
        )) {
            if ((host === 's3.amazonaws.com' || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)) && pathKey.startsWith(`${bucket}/`)) {
                return pathKey.slice(bucket.length + 1);
            }
            return pathKey;
        }
    } catch {
    }

    if (/^schools\/[^?#]+/i.test(value)) {
        return decodeKey(value.split('?')[0].split('#')[0]);
    }

    return '';
};

const getIncidentEvidenceKeys = (incident) =>
    (incident?.evidence || [])
        .map((entry) => extractS3KeyFromProtectedUrl(entry?.fileUrl))
        .filter(Boolean);

const buildCleanupError = (message, failures) => {
    const error = new Error(message);
    error.statusCode = 500;
    error.s3CleanupFailed = true;
    error.failures = failures;
    return error;
};

const deleteS3ObjectsOrThrow = async (keys = [], context = {}) => {
    const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
    if (uniqueKeys.length === 0) return { deletedKeys: [] };

    const results = await Promise.allSettled(
        uniqueKeys.map((key) => s3StorageService.deleteObject(key))
    );

    const failures = results
        .map((result, index) => ({ result, key: uniqueKeys[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, key }) => ({
            key,
            message: result.reason?.message || 'Unknown S3 delete failure',
        }));

    if (failures.length > 0) {
        logger.error('S3 cleanup failed', {
            ...context,
            failures,
            attemptedKeys: uniqueKeys,
        });
        throw buildCleanupError('Could not safely delete related S3 files. Database records were not deleted.', failures);
    }

    return { deletedKeys: uniqueKeys };
};

const deleteS3ObjectOrThrow = async (key, context = {}) =>
    deleteS3ObjectsOrThrow(key ? [key] : [], context);

const deleteIncidentEvidenceFromS3OrThrow = async (incidents, context = {}) => {
    const incidentList = Array.isArray(incidents) ? incidents : [incidents];
    const keys = incidentList.flatMap(getIncidentEvidenceKeys);

    return deleteS3ObjectsOrThrow(keys, {
        resourceType: 'IncidentEvidence',
        ...context,
    });
};

const deleteS3PrefixObjectsOrThrow = async (prefix, context = {}) => {
    if (!prefix) return { deletedKeys: [] };

    let keys;
    try {
        keys = await s3StorageService.listKeysByPrefix(prefix);
    } catch (error) {
        logger.error('S3 prefix listing failed', {
            ...context,
            prefix,
            message: error?.message || 'Unknown S3 list failure',
        });
        throw buildCleanupError('Could not safely inspect related S3 files. Database records were not deleted.', [{
            key: prefix,
            message: error?.message || 'Unknown S3 list failure',
        }]);
    }

    return deleteS3ObjectsOrThrow(keys, {
        ...context,
        prefix,
    });
};

const getIncidentReportExportKeys = async (incidentIds, context = {}) => {
    if (!s3StorageService.isConfigured()) return [];

    const ids = Array.isArray(incidentIds) ? incidentIds : [incidentIds];
    const keys = [];

    for (const incidentId of ids.filter(Boolean)) {
        const prefix = context.schoolId
            ? `schools/${context.schoolId}/exports/reports/${incidentId}/`
            : `exports/reports/${incidentId}/`;
        try {
            keys.push(...await s3StorageService.listKeysByPrefix(prefix));
        } catch (error) {
            logger.error('S3 incident report export listing failed', {
                ...context,
                prefix,
                incidentId,
                message: error?.message || 'Unknown S3 list failure',
            });
            throw buildCleanupError('Could not safely inspect related S3 report exports. Database records were not deleted.', [{
                key: prefix,
                message: error?.message || 'Unknown S3 list failure',
            }]);
        }
    }

    return keys;
};

const deleteIncidentReportExportsFromS3OrThrow = async (incidentIds, context = {}) => {
    const keys = await getIncidentReportExportKeys(incidentIds, context);
    return deleteS3ObjectsOrThrow(keys, {
        resourceType: 'IncidentReportExport',
        ...context,
    });
};

const deleteIncidentFilesFromS3OrThrow = async (incidents, context = {}) => {
    const incidentList = Array.isArray(incidents) ? incidents : [incidents];
    const incidentIds = incidentList.map((incident) => incident?._id || incident?.id).filter(Boolean);
    const evidenceKeys = incidentList.flatMap(getIncidentEvidenceKeys);
    const reportKeys = await getIncidentReportExportKeys(incidentIds, context);

    return deleteS3ObjectsOrThrow([...evidenceKeys, ...reportKeys], {
        resourceType: 'IncidentFiles',
        ...context,
    });
};

module.exports = {
    deleteIncidentFilesFromS3OrThrow,
    deleteIncidentEvidenceFromS3OrThrow,
    deleteIncidentReportExportsFromS3OrThrow,
    deleteS3ObjectOrThrow,
    deleteS3ObjectsOrThrow,
    deleteS3PrefixObjectsOrThrow,
    extractS3KeyFromProtectedUrl,
    getIncidentEvidenceKeys,
    getIncidentReportExportKeys,
};
