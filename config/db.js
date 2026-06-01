const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/pinoLogger');

mongoose.set('bufferCommands', false);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectDB = async (attempt = 1) => {
    if (!env.MONGO_URI) {
        throw new Error('MONGO_URI environment variable is not set');
    }

    const maxAttempts = Number(process.env.MONGO_CONNECT_MAX_ATTEMPTS) || 5;
    const retryDelayMs = Number(process.env.MONGO_CONNECT_RETRY_DELAY_MS) || 3000;

    try {
        const conn = await mongoose.connect(env.MONGO_URI, {
            maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,
            minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 2,
            serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 5000,
            socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
            heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS) || 10000,
            // autoIndex: true is safe here — Mongoose deduplicates index creation.
            // In production, you can run `npm run migrate:indexes` to create them manually.
            autoIndex: true
        });

        logger.info('MongoDB connected', { host: conn.connection.host });
        return conn;
    } catch (error) {
        if (attempt >= maxAttempts) {
            console.error(error);
            throw error;
        }

        logger.warn('MongoDB connection attempt failed, retrying', { attempt, error: error.message });
        await wait(retryDelayMs);
        return connectDB(attempt + 1);
    }
};

mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected. Driver will keep trying to reconnect.');
});

mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
});

mongoose.connection.on('error', (err) => {
    console.error(err);
});

module.exports = connectDB;
