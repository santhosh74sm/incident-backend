const { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const s3 = require('../config/s3');
const { buildProtectedS3Url } = require('../utils/protectedFileUrl');

const getBucketName = () => {
    if (!process.env.AWS_BUCKET_NAME) {
        throw new Error('AWS_BUCKET_NAME is required for S3 file storage');
    }

    return process.env.AWS_BUCKET_NAME;
};

const buildS3Url = (key) => {
    const bucket = getBucketName();
    const region = process.env.AWS_REGION;
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');

    return region
        ? `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`
        : `https://${bucket}.s3.amazonaws.com/${encodedKey}`;
};

const buildProtectedUrl = (key) => buildProtectedS3Url(key);

const streamToBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

const buildRandomKey = (folder, filename) => {
    const extension = path.extname(filename || '').toLowerCase();
    const randomName = crypto.randomBytes(16).toString('hex');
    const cleanFolder = String(folder || 'uploads').replace(/^\/+|\/+$/g, '');

    return `${cleanFolder}/${randomName}${extension}`;
};

const sanitizeDispositionFilename = (filename) => {
    const base = path.basename(String(filename || 'file')).replace(/["\r\n\\]/g, '_');
    return base || 'file';
};

const uploadBuffer = async ({ buffer, key, folder = 'uploads', filename, contentType }) => {
    const s3Key = key || buildRandomKey(folder, filename);
    const safeFilename = sanitizeDispositionFilename(filename || path.basename(s3Key));

    await s3.send(new PutObjectCommand({
        Bucket: getBucketName(),
        Key: s3Key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        ContentDisposition: `inline; filename="${safeFilename}"`,
    }));

    return {
        key: s3Key,
        url: buildProtectedUrl(s3Key),
    };
};

const getBuffer = async (key) => {
    const result = await s3.send(new GetObjectCommand({
        Bucket: getBucketName(),
        Key: key,
    }));

    return streamToBuffer(result.Body);
};

const getObjectStream = async (key) => {
    const result = await s3.send(new GetObjectCommand({
        Bucket: getBucketName(),
        Key: key,
    }));

    return {
        body: result.Body,
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        contentDisposition: result.ContentDisposition,
    };
};

const listKeysByPrefix = async (prefix) => {
    if (!prefix) return [];

    const keys = [];
    let ContinuationToken;

    do {
        const result = await s3.send(new ListObjectsV2Command({
            Bucket: getBucketName(),
            Prefix: prefix,
            ContinuationToken,
        }));

        (result.Contents || []).forEach((item) => {
            if (item.Key) keys.push(item.Key);
        });
        ContinuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (ContinuationToken);

    return keys;
};

const deleteObject = async (key) => {
    if (!key) return;

    await s3.send(new DeleteObjectCommand({
        Bucket: getBucketName(),
        Key: key,
    }));
};

module.exports = {
    buildRandomKey,
    buildProtectedUrl,
    buildS3Url,
    deleteObject,
    getBuffer,
    getObjectStream,
    listKeysByPrefix,
    uploadBuffer,
};
