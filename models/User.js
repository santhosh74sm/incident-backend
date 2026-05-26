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

        // Normalised role — only 'Admin' and 'Teacher' are used for staff accounts.
        // 'teacher' (lowercase) is kept in the enum for backward-compat with any
        // existing documents; authMiddleware normalises it to 'Teacher' on every
        // authenticated request so the rest of the app only sees the capitalised form.
        role: {
            type: String,
            enum: ['Admin', 'Teacher', 'teacher'],
            required: true,
        },

        class: {
            type: String,
            default: '',
        },

        // Password-reset OTP flow
        passwordResetOtp: { type: String, default: undefined },
        passwordResetOtpExpires: { type: Date, default: undefined },
        passwordResetVerifiedToken: { type: String, default: undefined },
        passwordResetVerifiedExpires: { type: Date, default: undefined },
    },
    { timestamps: true }
);

userSchema.methods.matchPassword = async function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
