const mongoose = require('mongoose');

const incidentSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        description: { type: String },
        evidence: [
            {
                evidenceType: { type: String, required: true },
                fileUrl: { type: String, default: null },
            },
        ],
        category: { type: String, required: true },
        incidentCategory: { type: String }, // alias kept for legacy compatibility
        location: { type: String },
        severity: {
            type: String,
            enum: ['Low', 'Medium', 'High', 'Critical'],
            default: 'Low',
        },
        isHighPriority: { type: Boolean, default: false, index: true },
        approvalStatus: {
            type: String,
            enum: ['Pending', 'Approved', 'Rejected'],
            default: 'Pending',
        },
        status: {
            type: String,
            enum: ['Open', 'In Progress', 'Closed'],
            default: 'Open',
        },
        closureRequested: { type: Boolean, default: false },
        rejectionReason: { type: String, default: null },
        studentsInvolved: [{ type: String }],
        admissionNo: { type: String, index: true },
        class: { type: String },
        section: { type: String },
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', index: true },
        reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        assignedHandler: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        submittedAt: { type: Date, default: Date.now },
        incidentDate: { type: Date, default: Date.now },
        approvedAt: { type: Date },
        progressAt: { type: Date },
        openedAt: { type: Date },
        inProgressAt: { type: Date },
        closedAt: { type: Date },
        progressLogs: [
            {
                note: String,
                updatedBy: String,
                timestamp: { type: Date, default: Date.now },
            },
        ],
        actionTaken: { type: String },
        closureNote: { type: String },
    },
    { timestamps: true }
);

// Compound indexes for the most common query patterns
incidentSchema.index({ isHighPriority: 1, status: 1 });
incidentSchema.index({ admissionNo: 1, status: 1 });
incidentSchema.index({ student: 1, status: 1 });
incidentSchema.index({ reportedBy: 1, createdAt: -1 });
incidentSchema.index({ class: 1, section: 1 });
incidentSchema.index({ status: 1, createdAt: -1 });
incidentSchema.index({ assignedHandler: 1, status: 1 });
incidentSchema.index({ approvalStatus: 1, createdAt: -1 });
incidentSchema.index({ incidentDate: -1, createdAt: -1 });
incidentSchema.index({ category: 1, status: 1 });
incidentSchema.index({ location: 1 });

module.exports = mongoose.model('Incident', incidentSchema);
