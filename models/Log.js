const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
    schoolId: { type: String, required: true, uppercase: true, trim: true },
    academicYear: { type: String, trim: true },
    actionName: { type: String, required: true, index: true }, 
    performedBy: { type: String, required: true, index: true }, // User ID or Name
    entityType: { type: String, enum: ['Incident', 'Student', 'Letter', 'Analytics', 'System', 'Bulk Upload', 'Template', 'Category', 'Location', 'EvidenceType', 'User', 'Staff'], required: true, index: true },
    entityId: { type: String, index: true },
    targetLabel: { type: String, default: null, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed }, // JSON for details
}, { timestamps: true });

// Ensure high speed queries
logSchema.index({ schoolId: 1, createdAt: -1 });
logSchema.index({ schoolId: 1, academicYear: 1, createdAt: -1 });
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });
logSchema.index({ schoolId: 1, entityType: 1, createdAt: -1 });
logSchema.index({ schoolId: 1, actionName: 1, createdAt: -1 });
logSchema.index({ schoolId: 1, performedBy: 1, createdAt: -1 });

module.exports = mongoose.model('Log', logSchema);
