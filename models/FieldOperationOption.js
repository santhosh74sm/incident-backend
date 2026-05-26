const mongoose = require('mongoose');

const fieldOperationOptionSchema = new mongoose.Schema({
    label: { 
        type: String, 
        required: true,
        trim: true 
    },
    type: { 
        type: String, 
        required: true,
        enum: ['assigner', 'handler'],
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

fieldOperationOptionSchema.index({ type: 1, order: 1 });

module.exports = mongoose.model('FieldOperationOption', fieldOperationOptionSchema);
