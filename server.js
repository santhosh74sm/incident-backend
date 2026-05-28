const express = require('express');
const env = require('./config/env');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const { globalApiRateLimiter } = require('./middleware/rateLimit.middleware');
const cookieParser = require('cookie-parser');
const { csrfProtection } = require('./middleware/csrf.middleware');
const connectDB = require('./config/db.js');
const ensureDbReady = require('./middleware/dbReadyMiddleware');
const errorHandler = require('./middleware/errorHandler.middleware');
const logger = require('./utils/pinoLogger');

const authRoutes = require('./routes/authRoutes');
const incidentRoutes = require('./routes/incidentRoutes');
const letterTemplateRoutes = require('./routes/letterTemplateRoutes');
const studentRoutes = require('./routes/studentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const logRoutes = require('./routes/logRoutes');
const evidenceTypeRoutes = require('./routes/evidenceTypeRoutes');
const fieldOperationRoutes = require('./routes/fieldOperationRoutes');
const issuedLetterRoutes = require('./routes/issuedLetterRoutes');
const searchRoutes = require('./routes/searchRoutes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            connectSrc: ["'self'", ...((env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean))],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
}));

const defaultAllowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001'
];

const allowedOrigins = [
    ...(env.NODE_ENV === 'production' ? [] : defaultAllowedOrigins),
    ...(env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        const error = new Error('Not allowed by CORS');
        error.statusCode = 403;
        callback(error);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Cache-Control', 'X-CSRF-Token'],
    exposedHeaders: ['Content-Disposition', 'X-S3-File-Url', 'X-CSRF-Token'],
    optionsSuccessStatus: 204,
    maxAge: 86400
};

app.use(cors(corsOptions));
app.use(cookieParser());
app.use(compression({
    threshold: Number(process.env.COMPRESSION_THRESHOLD_BYTES) || 1024,
    filter: (req, res) => {
        if (req.headers.accept?.includes('text/event-stream')) return false;
        return compression.filter(req, res);
    }
}));

app.use('/api', globalApiRateLimiter);

app.use(express.json({ limit: env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ limit: env.URLENCODED_BODY_LIMIT || '1mb', extended: true }));
app.use(csrfProtection);

app.get(['/api/auth/csrf', '/api/auth/csrf-token'], (req, res) => {
    logger.info('CSRF bootstrap route hit', {
        path: req.path,
        origin: req.get('origin') || null,
        hasCsrfCookie: Boolean(req.cookies?.csrfToken),
    });
    res.json({ csrfToken: res.getHeader('X-CSRF-Token') || null });
});

app.use('/api/uploads', require('./routes/fileRoutes'));

app.use('/api', ensureDbReady);

app.use('/api/auth', authRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/letter-templates', letterTemplateRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/evidence-types', evidenceTypeRoutes);
app.use('/api/field-operation-options', fieldOperationRoutes);
app.use('/api/issued-letters', issuedLetterRoutes);
app.use('/api/search', searchRoutes);

app.get('/health', (req, res) => {
    const { letterQueue, bulkQueue } = require('./utils/asyncQueue');
    res.status(200).json({
        status: 'healthy',
        database: require('mongoose').connection.readyState === 1 ? 'connected' : 'reconnecting',
        timestamp: new Date().toISOString(),
        queues: {
            letterGen:   { active: letterQueue.active(), pending: letterQueue.size() },
            bulkUpload:  { active: bulkQueue.active(),  pending: bulkQueue.size() },
        },
    });
});

app.use((req, res) => {
    res.status(404).json({
        message: 'Page not found',
        path: req.path,
        method: req.method
    });
});

app.use(errorHandler);

const PORT = env.PORT || 5000;
let server;

const startServer = async () => {
    try {
        await connectDB();
        server = app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT} (${process.env.NODE_ENV || 'development'} mode)`);
            logger.info('Registered security bootstrap routes', {
                csrfRoutes: ['/api/auth/csrf', '/api/auth/csrf-token'],
                authMount: '/api/auth',
                allowedOrigins,
            });
        });

        server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 120000;
        server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS) || 121000;
    } catch (error) {
        logger.fatal('Server startup failed', { error: error.message });
        process.exit(1);
    }
};

startServer();

let isShuttingDown = false;

const withTimeout = (promise, timeoutMs, label) =>
    Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => {
            logger.warn(`${label} timed out during shutdown`);
            resolve(false);
        }, timeoutMs)),
    ]);

const closeHttpServer = () => new Promise((resolve) => {
    if (!server) {
        resolve(true);
        return;
    }

    server.close((err) => {
        if (err) logger.error('HTTP server close error', { error: err.message });
        else logger.info('HTTP server closed');
        resolve(!err);
    });
});

const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received: shutting down quickly`);
    const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5000;
    const connectionTimeoutMs = Math.min(shutdownTimeoutMs, 5000);

    setTimeout(() => {
        logger.error('Forced shutdown timeout reached');
        process.exit(1);
    }, shutdownTimeoutMs + 1000).unref();

    if (server) {
        server.keepAliveTimeout = 1000;
        server.headersTimeout = 2000;
    }

    const mongoose = require('mongoose');
    const { letterQueue, bulkQueue } = require('./utils/asyncQueue');

    await withTimeout(closeHttpServer(), 1000, 'HTTP server close');

    await Promise.allSettled([
        withTimeout(letterQueue.shutdown({ timeoutMs: connectionTimeoutMs }), connectionTimeoutMs, 'letter queue drain'),
        withTimeout(bulkQueue.shutdown({ timeoutMs: connectionTimeoutMs }), connectionTimeoutMs, 'bulk queue drain'),
        withTimeout(
            mongoose.connection.close(false)
                .then(() => {
                    logger.info('MongoDB connection closed');
                    return true;
                })
                .catch((err) => {
                    logger.error('MongoDB close error', { error: err.message });
                    return false;
                }),
            connectionTimeoutMs,
            'MongoDB close'
        ),
    ]);

    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    logger.fatal('Uncaught Exception', { error: err.message, stack: err.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', { reason: String(reason) });
});

module.exports = app;
