const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const s3StorageService = require('../services/s3StorageService');
const { validateDocxBuffer } = require('../utils/docxSecurity');

const uploadDir = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const localStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const randomName = crypto.randomBytes(16).toString('hex');
        cb(null, `${randomName}${extension}`);
    }
});

const allowedExtensions = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.txt',
    '.csv'
]);

const allowedFileTypes = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/csv',
    'application/octet-stream',
]);

const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.csv']);
const spreadsheetFallbackMimeTypes = new Set([
    'application/octet-stream',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const fileFilter = (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    const mimeType = String(file.mimetype || '').toLowerCase();

    if (allowedFileTypes.has(mimeType) && allowedExtensions.has(extension)) {
        cb(null, true);
        return;
    }

    if (spreadsheetExtensions.has(extension) && spreadsheetFallbackMimeTypes.has(mimeType)) {
        cb(null, true);
        return;
    }

    const error = new Error(`File type not allowed: ${file.originalname}`);
    error.statusCode = 400;
    cb(error, false);
};

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: {
        fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES) || 10 * 1024 * 1024,
        files: Number(process.env.UPLOAD_MAX_FILES) || 10
    }
});

const localUpload = multer({
    storage: localStorage,
    fileFilter,
    limits: {
        fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES) || 10 * 1024 * 1024,
        files: Number(process.env.UPLOAD_MAX_FILES) || 10
    }
});

const signaturesByExtension = {
    jpg: ['jpg'],
    jpeg: ['jpg'],
    png: ['png'],
    gif: ['gif'],
    webp: ['webp'],
    pdf: ['pdf'],
    docx: ['zip', 'docx'],
    xlsx: ['zip', 'xlsx'],
    pptx: ['zip', 'pptx'],
};

const textExtensions = new Set(['txt', 'csv']);
const legacyOfficeExtensions = new Set(['doc', 'xls', 'ppt']);
const zipOfficeExtensions = new Set(['docx', 'xlsx', 'pptx']);

const getUploadedFiles = (req) => {
    if (Array.isArray(req.files)) return req.files;
    if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
    if (req.file) return [req.file];
    return [];
};

const removeFile = (filePath) => {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
};

const validateFileTypes = async (req, res, next) => {
    const files = getUploadedFiles(req);
    if (files.length === 0) return next();

    try {
        const { fileTypeFromBuffer } = await import('file-type');

        for (const file of files) {
            const extension = path.extname(file.originalname).toLowerCase().replace('.', '');
            let buffer;

            if (file.buffer) {
                buffer = file.buffer.subarray(0, 4100);
            } else if (file.path) {
                const fd = await fs.promises.open(file.path, 'r');
                buffer = Buffer.alloc(4100);
                await fd.read(buffer, 0, 4100, 0);
                await fd.close();
            } else {
                return res.status(400).json({ message: `File type could not be verified: ${file.originalname}` });
            }

            if (textExtensions.has(extension)) {
                if (buffer.includes(0)) {
                    removeFile(file.path);
                    return res.status(400).json({ message: `File type not allowed: ${file.originalname}` });
                }
                continue;
            }

            if (legacyOfficeExtensions.has(extension)) {
                continue;
            }

            const detected = await fileTypeFromBuffer(buffer);
            const allowedDetectedTypes = signaturesByExtension[extension] || [];

            if (zipOfficeExtensions.has(extension) && buffer[0] === 0x50 && buffer[1] === 0x4b) {
                if (extension === 'docx') {
                    const fullBuffer = file.buffer || await fs.promises.readFile(file.path);
                    validateDocxBuffer(fullBuffer);
                }
                continue;
            }

            if (!detected || !allowedDetectedTypes.includes(detected.ext)) {
                removeFile(file.path);
                return res.status(400).json({ message: `File type not allowed: ${file.originalname}` });
            }
        }

        next();
    } catch (error) {
        files.forEach((file) => removeFile(file.path));
        next(error);
    }
};

const uploadValidatedFilesToS3 = async (req, res, next) => {
    const files = getUploadedFiles(req);
    if (files.length === 0) return next();

    try {
        await Promise.all(files.map(async (file) => {
            if (!file.buffer || file.location) return;

            const result = await s3StorageService.uploadBuffer({
                buffer: file.buffer,
                folder: 'uploads',
                filename: file.originalname,
                contentType: file.mimetype,
            });

            file.key = result.key;
            file.location = result.url;
            file.filename = path.basename(result.key);
            delete file.buffer;
        }));

        next();
    } catch (error) {
        next(error);
    }
};

module.exports = upload;
module.exports.local = localUpload;
module.exports.validateFileTypes = validateFileTypes;
module.exports.uploadValidatedFilesToS3 = uploadValidatedFilesToS3;
