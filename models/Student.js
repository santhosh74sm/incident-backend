const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const studentSchema = new mongoose.Schema(
    {
        admissionNo: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        className: {
            type: String,
            required: true,
            trim: true,
        },
        section: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },
        password: {
            type: String,
            select: false,
        },
        mustChangePassword: {
            type: Boolean,
            default: true,
        },
        tokenVersion: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true }
);

// Compound indexes for fast class/section filtering and search
studentSchema.index({ className: 1, section: 1 });
studentSchema.index({ name: 1 });
studentSchema.index({ className: 1 });

// NOTE: Cascade incident deletion is handled explicitly in studentController.js
// (deleteStudent) before calling student.deleteOne(). The pre-hook approach is
// intentionally NOT used here because pre('deleteOne') does not receive the
// document instance — making it unreliable for fetching the student's name
// needed to match studentsInvolved. Keeping cascade logic in the controller
// is explicit, testable, and consistent.

studentSchema.methods.matchPassword = function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Student', studentSchema);
