const mongoose = require('mongoose');

const categorySchema = mongoose.Schema({
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
        required: [true, 'Please add a category name'],
        trim: true
    }
}, {
    timestamps: true
});

categorySchema.index({ schoolId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Category', categorySchema);
