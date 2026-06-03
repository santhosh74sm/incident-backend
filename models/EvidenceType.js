const mongoose = require('mongoose');

const evidenceTypeSchema = new mongoose.Schema({
    schoolId: {
        type: String,
        required: true,
        immutable: true,
        uppercase: true,
        trim: true,
        index: true
    },
    name: { 
        type: String, 
        required: true, 
        trim: true 
    },
    description: { 
        type: String, 
        trim: true 
    },
    createdBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    }
}, { timestamps: true });

evidenceTypeSchema.index({ schoolId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('EvidenceType', evidenceTypeSchema);
