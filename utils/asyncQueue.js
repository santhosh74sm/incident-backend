'use strict';

/**
 * asyncQueue.js
 * Lightweight in-process async job queue — no Redis required.
 *
 * Why: Heavy operations (letter generation and Excel upload)
 * must NOT block the HTTP response cycle. This queue runs jobs
 * concurrently (up to the configured limit) in the background via
 * setImmediate, keeping the event loop free for incoming requests.
 *
 * Usage:
 *   const { letterQueue } = require('./asyncQueue');
 *   const job = letterQueue.push(async () => generateLetter(...));
 *   const result = await job.promise;   // optional — await completion
 *
 * For production scale with multiple Node processes, replace with
 * BullMQ + Redis by swapping push() to enqueue a BullMQ job.
 */

const logger = require('./pinoLogger');

/**
 * Creates a named async queue.
 * @param {{ concurrency?: number, name?: string }} options
 */
const runWithTimeout = async (fn, timeoutMs, name) => {
    if (!timeoutMs || timeoutMs <= 0) {
        return fn();
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`[${name}] job timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([fn(), timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
};

const createQueue = ({ concurrency = 1, name = 'queue', jobTimeoutMs = 300000 } = {}) => {
    const pending = [];   // waiting jobs { fn, resolve, reject }
    let running   = 0;    // currently executing count
    let accepting = true;
    const idleWaiters = [];

    const notifyIdle = () => {
        if (running > 0 || pending.length > 0) return;
        while (idleWaiters.length > 0) {
            idleWaiters.shift()();
        }
    };

    const drain = () => {
        while (running < concurrency && pending.length > 0) {
            const { fn, resolve, reject } = pending.shift();
            running++;

            setImmediate(async () => {
                try {
                    const result = await runWithTimeout(fn, jobTimeoutMs, name);
                    resolve(result);
                } catch (err) {
                    logger.error(`[${name}] job failed`, { error: err.message });
                    reject(err);
                } finally {
                    running--;
                    drain();
                    notifyIdle();
                }
            });
        }
        notifyIdle();
    };

    /**
     * Push a job onto the queue.
     * @param {() => Promise<any>} fn  Async function to run.
     * @returns {{ promise: Promise<any> }}
     */
    const push = (fn) => {
        if (!accepting) {
            return { promise: Promise.reject(new Error(`[${name}] queue is shutting down`)) };
        }
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        pending.push({ fn, resolve, reject });
        drain();
        return { promise };
    };

    const size   = () => pending.length;
    const active = () => running;
    const waitForIdle = (timeoutMs = 5000) => {
        if (running === 0 && pending.length === 0) return Promise.resolve(true);

        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            idleWaiters.push(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    };

    const shutdown = async ({ timeoutMs = 5000, dropPending = true } = {}) => {
        accepting = false;

        if (dropPending) {
            while (pending.length > 0) {
                const job = pending.shift();
                job.reject(new Error(`[${name}] queue stopped before job started`));
            }
        }

        return waitForIdle(timeoutMs);
    };

    return { push, size, active, waitForIdle, shutdown, name };
};

// ─── Shared application queues ────────────────────────────────────────────────

/**
 * letterQueue — DOCX letter generation.
 * Concurrency 3: allows 3 letters to render in parallel (pure JS, low CPU).
 */
const letterQueue = createQueue({
    concurrency: 3,
    name: 'letter-gen',
    jobTimeoutMs: Number(process.env.LETTER_QUEUE_JOB_TIMEOUT_MS) || 120000,
});

/**
 * bulkQueue — Excel bulk incident upload.
 * Concurrency 1: serialized to avoid DB write storms on large files.
 */
const bulkQueue = createQueue({
    concurrency: 1,
    name: 'bulk-upload',
    jobTimeoutMs: Number(process.env.BULK_QUEUE_JOB_TIMEOUT_MS) || 600000,
});

module.exports = { createQueue, letterQueue, bulkQueue };
