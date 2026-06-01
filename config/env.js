const dotenv = require('dotenv');
const path = require('path');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
dotenv.config({ quiet: true });

const isProduction = process.env.NODE_ENV === 'production';

const WEAK_JWT_SECRETS = new Set([
    'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET_STRING_BEFORE_DEPLOYING',
    'replace-with-64-character-random-staff-secret',
    'replace-with-64-character-random-student-secret',
]);

const isWeakJwtSecret = (value) => {
    if (!value || value.length < 32) return true;
    return WEAK_JWT_SECRETS.has(value);
};

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().default('5000'),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    JWT_SECRET_STAFF: z.string().min(32).optional(),
    JWT_SECRET_STUDENT: z.string().min(32).optional(),
    JWT_SECRET: z.string().min(32).optional(),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    ACCESS_COOKIE_MAX_AGE_MS: z.string().optional(),
    REFRESH_COOKIE_MAX_AGE_MS: z.string().optional(),
    REFRESH_TOKEN_TTL_DAYS: z.string().optional(),
    CORS_ORIGIN: z.string().optional().default(''),
    RATE_LIMIT_WINDOW_MS: z.string().optional(),
    RATE_LIMIT_MAX: z.string().optional(),
    AUTH_RATE_LIMIT_WINDOW_MS: z.string().optional(),
    AUTH_RATE_LIMIT_MAX: z.string().optional(),
    JSON_BODY_LIMIT: z.string().default('1mb'),
    URLENCODED_BODY_LIMIT: z.string().default('1mb'),
    UPLOAD_MAX_FILE_SIZE_BYTES: z.string().optional(),
    UPLOAD_MAX_FILES: z.string().optional(),
    KEEP_ALIVE_TIMEOUT_MS: z.string().optional(),
    HEADERS_TIMEOUT_MS: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_BUCKET_NAME: z.string().optional(),
    AWS_ACCESS_KEY: z.string().optional(),
    AWS_SECRET_KEY: z.string().optional(),
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    REFRESH_REUSE_GRACE_MS: z.string().optional(),
}).superRefine((env, ctx) => {
    if (!env.JWT_SECRET_STAFF) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET_STAFF'],
            message: 'JWT_SECRET_STAFF is required (min 32 characters, cryptographically random)',
        });
    } else if (isWeakJwtSecret(env.JWT_SECRET_STAFF)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET_STAFF'],
            message: 'JWT_SECRET_STAFF must not use a placeholder or weak value',
        });
    }

    if (!env.JWT_SECRET_STUDENT) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET_STUDENT'],
            message: 'JWT_SECRET_STUDENT is required (min 32 characters, cryptographically random)',
        });
    } else if (isWeakJwtSecret(env.JWT_SECRET_STUDENT)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET_STUDENT'],
            message: 'JWT_SECRET_STUDENT must not use a placeholder or weak value',
        });
    }

    if (env.JWT_SECRET && isWeakJwtSecret(env.JWT_SECRET)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET'],
            message: 'JWT_SECRET placeholder is not allowed; set JWT_SECRET_STAFF and JWT_SECRET_STUDENT',
        });
    }

    if (isProduction) {
        if (!env.CORS_ORIGIN) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['CORS_ORIGIN'],
                message: 'CORS_ORIGIN is required in production',
            });
        }

        ['AWS_REGION', 'AWS_BUCKET_NAME', 'AWS_ACCESS_KEY', 'AWS_SECRET_KEY'].forEach((key) => {
            if (!env[key]) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [key],
                    message: `${key} is required in production`,
                });
            }
        });
    }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('FATAL: Missing or invalid environment variables');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}

const env = parsed.data;

module.exports = env;
