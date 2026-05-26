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

const router = express.Router();
const uploadRoot = path.resolve(__dirname, '..', 'uploads');

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

module.exports = router;
