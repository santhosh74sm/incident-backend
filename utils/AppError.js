class AppError extends Error {
    constructor(message, statusCode = 500, code = undefined) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.status = statusCode;
        this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;
