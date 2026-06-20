const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
        schoolId: { type: String, required: true, uppercase: true, trim: true },
        userModel: { type: String, enum: ['User', 'Student'], required: true },
        type: { type: String, enum: ['staff', 'student'], required: true },
        tokenHash: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        tokenVersion: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true, index: true },
        revokedAt: { type: Date, default: null },
        replacedBy: { type: String, default: null },
        reuseDetectedAt: { type: Date, default: null },
        ipAddress: { type: String, default: null },
        userAgent: { type: String, default: null },
    },
    { timestamps: true }
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ schoolId: 1, user: 1, familyId: 1 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
