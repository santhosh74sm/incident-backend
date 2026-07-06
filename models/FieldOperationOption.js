const mongoose = require('mongoose');

const fieldOperationOptionSchema = new mongoose.Schema({
    schoolId: {
        type: String,
        required: true,
        immutable: true,
        uppercase: true,
        trim: true,
        index: true
    },
    label: { 
        type: String, 
        required: true,
        trim: true 
    },
    type: { 
        type: String, 
        required: true,
        enum: ['assigner', 'handler', 'updated'],
        index: true
    },
    isDefault: {
        type: Boolean,
        default: false
    },
    order: { 
        type: Number, 
        default: 0 
    }
}, { timestamps: true });

fieldOperationOptionSchema.index({ schoolId: 1, type: 1, order: 1 });
fieldOperationOptionSchema.index({ schoolId: 1, type: 1, label: 1 }, { unique: true });

module.exports = mongoose.model('FieldOperationOption', fieldOperationOptionSchema);
