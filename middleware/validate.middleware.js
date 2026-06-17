const logger = require('../utils/pinoLogger');
const { deleteS3ObjectsOrThrow } = require('../services/s3CleanupService');

const validate = (schema, source = 'body') => async (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
        const files = Array.isArray(req.files)
            ? req.files
            : req.files && typeof req.files === 'object'
                ? Object.values(req.files).flat()
                : req.file
                    ? [req.file]
                    : [];

        const s3Keys = files.map((file) => file?.key).filter(Boolean);
        try {
            await deleteS3ObjectsOrThrow(s3Keys, {
                operation: 'requestValidationFailed',
                source,
                path: req.path,
            });
        } catch (cleanupError) {
            return next(cleanupError);
        }

        files.forEach((file) => {
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

        const fieldErrors = result.error.flatten().fieldErrors;
        const firstField = Object.keys(fieldErrors)[0];
        const firstMessage = firstField ? fieldErrors[firstField]?.[0] : '';
        const message = firstMessage
            ? `${firstField}: ${firstMessage}`
            : 'Please check the submitted fields and try again.';

        return res.status(400).json({
            message,
            errors: fieldErrors,
        });
    }

    req[source] = result.data;
    next();
};

module.exports = validate;
