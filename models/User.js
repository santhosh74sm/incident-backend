const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },

        password: {
            type: String,
            required: true,
        },

        tokenVersion: {
            type: Number,
            default: 0,
        },
        mustChangePassword: {
            type: Boolean,
            default: false,
        },
        passwordChangedAt: {
            type: Date,
            default: null,
        },

        // Normalised staff role. Lowercase variants are retained for legacy documents.
        // Lowercase variants are kept for backward-compat with existing documents;
        // authMiddleware normalises them on every authenticated request.
        role: {
            type: String,
            enum: ['Super Admin', 'Admin', 'Teacher', 'teacher', 'admin', 'super_admin'],
            required: true,
        },

        class: {
            type: String,
            default: '',
        },

    },
    { timestamps: true }
);

userSchema.methods.matchPassword = async function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
