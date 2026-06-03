const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
    {
        schoolId: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            index: true,
        },
        recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        type: { type: String, default: 'SYSTEM_ACTIVITY' },
        incident: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', default: null },
        entityType: { type: String, default: 'System' },
        entityId: { type: String, default: null },
        actionName: { type: String, required: true },
        message: { type: String, required: true },
        performedBy: { type: String, default: 'System' },
        performedByName: { type: String, default: 'System' },
        performedByRole: { type: String, default: null },
        targetLabel: { type: String, default: null },
        targetAdmissionNumber: { type: String, default: null },
        routePath: { type: String, default: null },
        metadata: { type: mongoose.Schema.Types.Mixed },
        read: { type: Boolean, default: false },
        // Student details for clear notification context
        studentDetails: {
            studentsInvolved: [{ type: String }],
            class: { type: String },
            section: { type: String },
            admissionNo: { type: String, default: null },
        }
    },
    { timestamps: true }
);

notificationSchema.index({ schoolId: 1, recipient: 1, createdAt: -1 });
notificationSchema.index({ schoolId: 1, recipient: 1, read: 1 });
notificationSchema.index({ schoolId: 1, recipient: 1, actionName: 1, createdAt: -1 });
notificationSchema.index({ schoolId: 1, recipient: 1, routePath: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
