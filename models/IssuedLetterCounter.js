const mongoose = require('mongoose');

const issuedLetterCounterSchema = new mongoose.Schema({
    _id: {
        type: String,
        required: true,
    },
    schoolId: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        index: true,
    },
    scope: {
        type: String,
        required: true,
        trim: true,
        index: true,
    },
    year: {
        type: Number,
        required: true,
        index: true,
    },
    seq: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
    },
}, {
    timestamps: true,
    collection: 'sequence_counters',
});

issuedLetterCounterSchema.index({ schoolId: 1, scope: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('IssuedLetterCounter', issuedLetterCounterSchema);
