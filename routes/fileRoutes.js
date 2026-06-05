'use strict';

/**
 * fileRoutes.js
 * Auth-gated static file serving for the uploads directory.
 * Replaces express.static — all files require a valid JWT session.
 * Path traversal is prevented by resolving each segment through path.basename.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { filenameParamSchema } = require('../validators/fileValidators');
const s3StorageService = require('../services/s3StorageService');
const { decryptS3KeyToken } = require('../utils/protectedFileUrl');

const router = express.Router();
const uploadRoot = path.resolve(__dirname, '..', 'uploads');

const MIME_BY_EXTENSION = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
};

const INLINE_MIME_TYPES = new Set([
    'application/pdf',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/csv',
    'text/plain',
]);

const sanitizeHeaderFilename = (filename) => {
    const base = path.basename(String(filename || 'file')).replace(/["\r\n\\]/g, '_');
    return base || 'file';
};

const encodeRfc5987 = (value) =>
    encodeURIComponent(value)
        .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/\*/g, '%2A');

const normalizeMimeType = (contentType, key) => {
    const rawType = String(contentType || '').split(';')[0].trim().toLowerCase();
    const extension = path.extname(key || '').toLowerCase();
    const inferred = MIME_BY_EXTENSION[extension];

    if (!rawType || rawType === 'application/octet-stream' || rawType === 'binary/octet-stream') {
        return inferred || 'application/octet-stream';
    }

    return contentType;
};

const isInlinePreviewable = (contentType) => {
    const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
    return INLINE_MIME_TYPES.has(normalized);
};

const buildContentDisposition = ({ key, contentType, requestedDisposition }) => {
    const filename = sanitizeHeaderFilename(path.basename(key));
    const encodedFilename = encodeRfc5987(filename);
    const wantsAttachment = requestedDisposition === 'attachment' || requestedDisposition === 'download';
    const dispositionType = wantsAttachment || !isInlinePreviewable(contentType) ? 'attachment' : 'inline';

    return `${dispositionType}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
};

// Ensure the uploads root exists at startup
if (!fs.existsSync(uploadRoot)) {
    fs.mkdirSync(uploadRoot, { recursive: true });
}

/**
 * GET /api/uploads/:filename
 * Serves any file under the uploads directory to authenticated users only.
 * Sanitizes the path to prevent directory traversal attacks.
 */
router.get('/:filename', protect, validate(filenameParamSchema, 'params'), (req, res) => {
    const rawPath = req.params.filename || '';

    // Sanitize: split on both / and \, take basename of each segment, rejoin
    const safeRelativePath = rawPath
        .split(/[/\\]+/)
        .filter(Boolean)
        .map((segment) => path.basename(segment))
        .join(path.sep);

    const resolvedPath = path.resolve(uploadRoot, safeRelativePath);

    // Ensure the resolved path is strictly inside uploadRoot (guard against symlinks)
    if (!resolvedPath.startsWith(uploadRoot + path.sep) && resolvedPath !== uploadRoot) {
        return res.status(403).json({ message: 'Access denied' });
    }

    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
        return res.status(404).json({ message: 'File not found' });
    }

    return res.sendFile(resolvedPath);
});

router.get(/^\/s3\/(.+)/, protect, async (req, res, next) => {
    try {
        const requestedKey = decodeURIComponent(req.params[0] || '').replace(/^\/+/, '');
        const key = decryptS3KeyToken(requestedKey) || requestedKey;
        const requestedDisposition = String(req.query.disposition || req.query.responseContentDisposition || '').toLowerCase();

        if (!key || key.includes('..') || key.includes('\\')) {
            return res.status(400).json({ message: 'Invalid file key' });
        }

        const allowedPrefix = `schools/${req.user.schoolId}/`;
        if (!key.startsWith(allowedPrefix)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const object = await s3StorageService.getObjectStream(key);
        const contentType = normalizeMimeType(object.contentType, key);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', buildContentDisposition({ key, contentType, requestedDisposition }));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (object.contentLength) {
            res.setHeader('Content-Length', object.contentLength);
        }
        object.body.on('error', next);
        return object.body.pipe(res);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
