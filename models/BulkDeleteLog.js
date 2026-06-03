const mongoose = require('mongoose');

const failureSchema = new mongoose.Schema(
    {
        id: { type: String, default: '' },
        message: { type: String, default: '' },
    },
    { _id: false }
);

const progressSchema = new mongoose.Schema(
    {
        batch: { type: Number, required: true },
        processed: { type: Number, required: true },
        deleted: { type: Number, required: true },
        failed: { type: Number, required: true },
    },
    { _id: false }
);

const bulkDeleteLogSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        module: { type: String, enum: ['students', 'incidents', 'issued-letters'], required: true, index: true },
        mode: { type: String, enum: ['filtered', 'all'], required: true, index: true },
        filtersUsed: { type: mongoose.Schema.Types.Mixed, default: {} },
        recordsDeleted: { type: Number, default: 0 },
        failures: { type: [failureSchema], default: [] },
        durationMs: { type: Number, default: 0 },
        progress: { type: [progressSchema], default: [] },
    },
    { timestamps: true }
);

bulkDeleteLogSchema.index({ createdAt: -1 });
bulkDeleteLogSchema.index({ module: 1, createdAt: -1 });

module.exports = mongoose.model('BulkDeleteLog', bulkDeleteLogSchema);
