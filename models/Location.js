const mongoose = require('mongoose');

const locationSchema = mongoose.Schema({
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
        required: [true, 'Please add a location name'],
        trim: true
    }
}, {
    timestamps: true
});

locationSchema.index({ schoolId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Location', locationSchema);
