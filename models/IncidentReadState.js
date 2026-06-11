const mongoose = require('mongoose');

const incidentReadStateSchema = new mongoose.Schema(
    {
        schoolId: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            index: true,
        },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        incident: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
        readAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

incidentReadStateSchema.index({ schoolId: 1, user: 1, incident: 1 }, { unique: true });
incidentReadStateSchema.index({ schoolId: 1, user: 1, readAt: -1 });

module.exports = mongoose.model('IncidentReadState', incidentReadStateSchema);
