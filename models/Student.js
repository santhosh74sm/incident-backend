const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const studentSchema = new mongoose.Schema(
    {
        admissionNo: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        schoolId: {
            type: String,
            required: true,
            immutable: true,
            uppercase: true,
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
        academicYear: {
            type: String,
            trim: true,
            index: true,
        },
        status: {
            type: String,
            enum: ['Active', 'Passed Out', 'Alumni'],
            default: 'Active',
            index: true,
        },
        history: [
            {
                academicYear: { type: String, required: true, trim: true },
                admissionNo: { type: String, trim: true },
                name: { type: String, trim: true },
                className: { type: String, required: true, trim: true },
                section: { type: String, required: true, trim: true, uppercase: true },
                status: { type: String, enum: ['Active', 'Passed Out', 'Alumni'], default: 'Active' },
                updatedAt: { type: Date, default: Date.now },
            },
        ],
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
        passwordChangedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// Compound indexes for fast class/section filtering and search
studentSchema.index({ schoolId: 1, admissionNo: 1 }, { unique: true });
studentSchema.index({ schoolId: 1, academicYear: 1, className: 1, section: 1 });
studentSchema.index({ schoolId: 1, name: 1 });
studentSchema.index({ schoolId: 1, academicYear: 1 });
studentSchema.index({ schoolId: 1, 'history.academicYear': 1 });

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
