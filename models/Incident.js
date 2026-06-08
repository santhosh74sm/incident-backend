const mongoose = require('mongoose');

const incidentSchema = new mongoose.Schema(
    {
        schoolId: {
            type: String,
            required: true,
            immutable: true,
            uppercase: true,
            trim: true,
            index: true,
        },
        title: { type: String, required: true },
        description: { type: String },
        evidence: [
            {
                evidenceType: { type: String, required: true },
                fileUrl: { type: String, default: null },
                originalName: { type: String, default: '' },
                mimeType: { type: String, default: '' },
                fileSize: { type: Number, default: 0 },
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
        class: { type: String, alias: 'className' },
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
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// Compound indexes for the most common query patterns
incidentSchema.index({ schoolId: 1, isHighPriority: 1, status: 1 });
incidentSchema.index({ schoolId: 1, admissionNo: 1, status: 1 });
incidentSchema.index({ schoolId: 1, student: 1, status: 1 });
incidentSchema.index({ schoolId: 1, reportedBy: 1, createdAt: -1 });
incidentSchema.index({ schoolId: 1, class: 1, section: 1 });
incidentSchema.index({ schoolId: 1, status: 1, createdAt: -1 });
incidentSchema.index({ schoolId: 1, assignedHandler: 1, status: 1 });
incidentSchema.index({ schoolId: 1, approvalStatus: 1, createdAt: -1 });
incidentSchema.index({ schoolId: 1, incidentDate: -1, createdAt: -1 });
incidentSchema.index({ schoolId: 1, category: 1, status: 1 });
incidentSchema.index({ schoolId: 1, location: 1 });

module.exports = mongoose.model('Incident', incidentSchema);
