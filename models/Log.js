const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
    actionName: { type: String, required: true, index: true }, 
    performedBy: { type: String, required: true, index: true }, // User ID or Name
    entityType: { type: String, enum: ['Incident', 'Student', 'Letter', 'Analytics', 'System', 'Bulk Upload', 'Template', 'Category', 'Location', 'EvidenceType'], required: true, index: true },
    entityId: { type: String, index: true }, 
    metadata: { type: mongoose.Schema.Types.Mixed }, // JSON for details
}, { timestamps: true });

// Ensure high speed queries
logSchema.index({ createdAt: -1 });
logSchema.index({ entityType: 1, createdAt: -1 });
logSchema.index({ actionName: 1, createdAt: -1 });
logSchema.index({ performedBy: 1, createdAt: -1 });

module.exports = mongoose.model('Log', logSchema);
