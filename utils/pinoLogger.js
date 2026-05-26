/**
 * pinoLogger.js
 * Structured logger — uses Pino when available, falls back to console with
 * a structured JSON envelope so log aggregators still get parseable output.
 *
 * Usage:
 *   const logger = require('./utils/pinoLogger');
 *   logger.info('Server started', { port: 5000 });
 *   logger.error('DB failed', { error: err.message });
 *
 * To enable full Pino:  npm install pino pino-pretty
 * Then set LOG_PRETTY=true in .env for development output.
 */

'use strict';

let pino;
try {
    pino = require('pino');
} catch {
    pino = null;
}

const createPinoLogger = () => {
    const isPretty = process.env.LOG_PRETTY === 'true' && process.env.NODE_ENV !== 'production';
    const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

    if (isPretty) {
        try {
            return pino({
                level,
                transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
            });
        } catch {
            // pino-pretty not installed — fall through to standard pino
        }
    }

    return pino({ level });
};

const createConsoleLogger = () => {
    const level = process.env.LOG_LEVEL || 'info';
    const levels = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    const currentLevel = levels[level] ?? 2;

    const log = (levelName, message, meta = {}) => {
        if ((levels[levelName] ?? 2) < currentLevel) return;
        const entry = JSON.stringify({
            level: levelName,
            time: new Date().toISOString(),
            msg: message,
            ...meta,
        });
        if (levelName === 'error' || levelName === 'fatal') {
            process.stderr.write(entry + '\n');
        } else {
            process.stdout.write(entry + '\n');
        }
    };

    return {
        trace: (msg, meta) => log('trace', msg, meta),
        debug: (msg, meta) => log('debug', msg, meta),
        info: (msg, meta) => log('info', msg, meta),
        warn: (msg, meta) => log('warn', msg, meta),
        error: (msg, meta) => log('error', msg, meta),
        fatal: (msg, meta) => log('fatal', msg, meta),
        child: () => createConsoleLogger(),
    };
};

const logger = pino ? createPinoLogger() : createConsoleLogger();

module.exports = logger;
