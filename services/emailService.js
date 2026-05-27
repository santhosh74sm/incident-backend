'use strict';

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const ensureResendConfig = () => {
    if (!process.env.RESEND_API_KEY) {
        throw new Error('Email service is missing configuration: RESEND_API_KEY');
    }
};

const sendPasswordResetOtpEmail = async ({ to, otp }) => {
    ensureResendConfig();

    console.log('[OTP EMAIL] Sending password reset OTP with Resend', { to });

    try {
        const result = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to,
            subject: 'Password Reset OTP',
            html: `<h1>${otp}</h1>`,
        });

        console.log('[OTP EMAIL] Resend accepted password reset OTP email', {
            to,
            id: result?.data?.id || result?.id,
        });

        return result;
    } catch (error) {
        console.error('[OTP EMAIL] Resend delivery failed', {
            to,
            message: error.message,
            name: error.name,
            statusCode: error.statusCode,
            response: error.response,
        });

        throw error;
    }
};

module.exports = {
    sendPasswordResetOtpEmail,
};
