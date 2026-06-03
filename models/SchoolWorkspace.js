const mongoose = require('mongoose');

const schoolWorkspaceSchema = new mongoose.Schema(
    {
        schoolId: {
            type: String,
            required: true,
            unique: true,
            immutable: true,
            trim: true,
            uppercase: true,
            index: true,
        },
        schoolName: {
            type: String,
            required: true,
            trim: true,
        },
        superAdminName: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        status: {
            type: String,
            enum: ['active', 'suspended', 'archived'],
            default: 'active',
            index: true,
        },
    },
    { timestamps: true }
);

schoolWorkspaceSchema.index({ schoolName: 1 });
schoolWorkspaceSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SchoolWorkspace', schoolWorkspaceSchema);
