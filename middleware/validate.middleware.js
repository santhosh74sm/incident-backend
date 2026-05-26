const logger = require('../utils/pinoLogger');
const s3StorageService = require('../services/s3StorageService');

const validate = (schema, source = 'body') => (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
        const files = Array.isArray(req.files)
            ? req.files
            : req.files && typeof req.files === 'object'
                ? Object.values(req.files).flat()
                : req.file
                    ? [req.file]
                    : [];

        files.forEach((file) => {
            if (file?.key) {
                s3StorageService.deleteObject(file.key).catch(() => {});
            }
            if (file?.path) {
                require('fs').unlink(file.path, () => {});
            }
        });

        if (process.env.NODE_ENV !== 'production') {
            logger.warn('Request validation failed', {
                source,
                path: req.path,
                errors: result.error.flatten().fieldErrors,
            });
        }

        return res.status(400).json({
            message: 'Validation failed',
            errors: result.error.flatten().fieldErrors,
        });
    }

    req[source] = result.data;
    next();
};

module.exports = validate;
