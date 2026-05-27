const mongoose = require('mongoose');

const passwordResetRequestSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        email: { type: String, required: true, lowercase: true, trim: true },
        status: {
            type: String,
            enum: ['pending', 'completed', 'rejected'],
            default: 'pending',
            index: true,
        },
        requestedAt: { type: Date, default: Date.now },
        completedAt: { type: Date, default: null },
        completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        temporaryPasswordHash: { type: String, default: null },
    },
    { timestamps: true }
);

passwordResetRequestSchema.index({ email: 1, status: 1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);
