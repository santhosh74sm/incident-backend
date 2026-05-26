'use strict';

/**
 * emailService.js
 *
 * Single-responsibility: build and deliver transactional emails.
 *
 * Architecture decisions:
 *  - One persistent pooled transporter (created lazily on first use).
 *    A connection pool keeps the SMTP socket alive between sends, eliminating
 *    the ~800 ms TCP+TLS handshake cost on every OTP request.
 *  - Transporter is replaced (not reused) only when a hard auth/config error
 *    is detected, so a bad App Password doesn't silently poison the pool.
 *  - verifySmtpConnection() reuses the same pool transporter so the verified
 *    connection is the one that actually sends mail.
 *  - All timeouts are tight (8 s) so background failures surface quickly.
 */

const nodemailer = require('nodemailer');

// ─── Constants ────────────────────────────────────────────────────────────────
const REQUIRED_MAIL_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
const DEFAULT_SMTP_PORT   = 587;
const MAIL_TIMEOUT_MS     = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 8000;

// ─── Config helpers ───────────────────────────────────────────────────────────
const getSmtpConfig = () => {
    const port = Number(process.env.SMTP_PORT) || DEFAULT_SMTP_PORT;

    // secure=true  → implicit TLS (port 465, wraps the socket in TLS immediately)
    // secure=false → STARTTLS  (port 587, upgrades a plain connection to TLS)
    // Cloud platforms (Render, Railway, Heroku) block port 465 outbound.
    // Default to false so STARTTLS on 587 works out of the box.
    const secure =
        String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ||
        (String(process.env.SMTP_SECURE || '').toLowerCase() !== 'false' && port === 465);

    return { port, secure };
};

const ensureMailConfig = () => {
    const missing = REQUIRED_MAIL_KEYS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        throw new Error(`Email service is missing configuration: ${missing.join(', ')}`);
    }
};

const auditMailConfig = () => {
    const missing = REQUIRED_MAIL_KEYS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.warn(
            `⚠️  EMAIL SERVICE: Missing SMTP env vars: ${missing.join(', ')}. ` +
            'Password-reset emails will fail until these are configured.'
        );
        return false;
    }
    return true;
};

// ─── Pooled transporter (singleton, lazy-initialised) ─────────────────────────
//
// nodemailer pool keeps up to `maxConnections` (default 5) SMTP sockets open.
// Subsequent sends reuse an idle socket — no TCP+TLS handshake overhead.
let _poolTransporter = null;

const getTransporter = () => {
    if (_poolTransporter) return _poolTransporter;

    ensureMailConfig();

    const { port, secure } = getSmtpConfig();

    _poolTransporter = nodemailer.createTransport({
        pool: true,               // ← enables connection pooling
        maxConnections: 3,        // keep up to 3 sockets open
        maxMessages: Infinity,    // no per-connection message cap
        host: process.env.SMTP_HOST,
        port,
        secure,                   // false = STARTTLS (port 587), true = implicit TLS (port 465)
        connectionTimeout : MAIL_TIMEOUT_MS,
        greetingTimeout   : MAIL_TIMEOUT_MS,
        socketTimeout     : MAIL_TIMEOUT_MS,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        tls: {
            // rejectUnauthorized: false allows the TLS handshake to succeed even when
            // Render's egress proxy presents a cert that doesn't match smtp.gmail.com.
            // This does NOT disable encryption — the connection is still fully encrypted.
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
        },
    });

    // Tear down the pool on hard auth errors so the next call rebuilds it
    // with fresh credentials (useful after an App Password rotation).
    _poolTransporter.on('error', (err) => {
        if (err.code === 'EAUTH' || err.responseCode === 535) {
            console.error(
                '❌ CRITICAL SMTP ERROR: Auth failure detected on pool — resetting transporter.',
                { message: err.message, code: err.code }
            );
            _poolTransporter = null;
        }
    });

    return _poolTransporter;
};

// ─── Startup SMTP verification (non-blocking, uses the pool transporter) ──────
const verifySmtpConnection = async () => {
    if (!auditMailConfig()) return;

    const { port, secure } = getSmtpConfig();

    console.log('📧 SMTP CONFIG (startup check):', {
        host    : process.env.SMTP_HOST,
        port,
        secure,
        user    : process.env.SMTP_USER,
        pool    : true,
        timeout : `${MAIL_TIMEOUT_MS}ms`,
    });

    try {
        await getTransporter().verify();
        console.log('✅ SMTP connection verified — pooled transporter is ready.');
    } catch (error) {
        // ── Verbose critical error (includes stack for full trace) ──────────
        console.error('❌ CRITICAL SMTP ERROR:', {
            message     : error.message,
            stack       : error.stack,
            code        : error.code,
            command     : error.command,
            responseCode: error.responseCode,
            response    : error.response,
        });

        // ── Actionable fix guide ─────────────────────────────────────────────
        if (error.code === 'EAUTH' || error.responseCode === 535) {
            console.error(
                '🔑 FIX → AUTH FAILURE (Invalid Login / 535):\n' +
                '   1. Go to https://myaccount.google.com/apppasswords\n' +
                '   2. Delete the old App Password and generate a new 16-char one.\n' +
                '   3. Update SMTP_PASS in your .env (no spaces, no quotes).\n' +
                '   4. Restart the server.'
            );
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
            console.error(
                '🌐 FIX → CONNECTION REFUSED / TIMEOUT:\n' +
                '   • Render/Railway/Heroku block outbound port 465.\n' +
                '     → Set SMTP_PORT=587 and SMTP_SECURE=false in your env vars.\n' +
                '   • Verify SMTP_HOST=smtp.gmail.com is correct.'
            );
        } else if (error.code === 'ESOCKET') {
            console.error(
                '🔌 FIX → TLS/SSL SOCKET ERROR:\n' +
                '   → Try SMTP_PORT=587 and SMTP_SECURE=false (STARTTLS mode).'
            );
        }
    }
};

// Run at module load — non-blocking, will NOT crash the server on failure.
verifySmtpConnection().catch(() => {});

// ─── HTML helpers ─────────────────────────────────────────────────────────────
const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

const getOtpExpirySeconds = () =>
    Math.max(1, Math.floor((Number(process.env.PASSWORD_RESET_OTP_EXPIRY_MS) || 120000) / 1000));

const buildOtpEmailHtml = ({ otp, appName, expirySeconds }) => `
<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                 style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;">
            <tr>
              <td style="background:#0f172a;padding:28px 32px;color:#ffffff;">
                <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;">
                  ${escapeHtml(appName)}
                </div>
                <h1 style="margin:10px 0 0;font-size:26px;line-height:1.25;">Password reset code</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#334155;">
                  Use the verification code below to continue resetting your password.
                </p>
                <div style="margin:24px 0;padding:18px 24px;background:#eef2ff;border:1px solid #c7d2fe;
                            border-radius:14px;text-align:center;">
                  <div style="font-size:13px;font-weight:700;text-transform:uppercase;
                              letter-spacing:1.6px;color:#4338ca;">Your reset code</div>
                  <div style="margin-top:8px;font-size:36px;font-weight:800;
                              letter-spacing:8px;color:#1e1b4b;">${escapeHtml(otp)}</div>
                </div>
                <p style="margin:0;font-size:15px;line-height:1.7;color:#334155;">
                  This code expires in
                  <strong>${escapeHtml(String(Math.ceil(expirySeconds / 60)))} minutes</strong>.
                  If you did not request a password reset, you can safely ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;
                         color:#64748b;font-size:12px;line-height:1.6;">
                This is an automated security email. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

// ─── Main send function ───────────────────────────────────────────────────────
/**
 * sendPasswordResetOtpEmail
 *
 * Sends the OTP email using the pooled transporter.
 * This function is intentionally async — callers in authService fire it
 * without await (send-and-forget) so the HTTP response is instant.
 *
 * @param {{ to: string, otp: string }} params
 */
const sendPasswordResetOtpEmail = async ({ to, otp }) => {
    const appName       = process.env.MAIL_APP_NAME || 'Incident Tracking System';
    const from          = process.env.MAIL_FROM || `"${appName}" <${process.env.SMTP_USER}>`;
    const expirySeconds = getOtpExpirySeconds();

    console.log(`📤 [OTP EMAIL] Queuing send to: ${to}`);

    try {
        const info = await getTransporter().sendMail({
            from,
            to,
            subject : `${appName} — password reset code`,
            text    : `Your password reset code is: ${otp}. It expires in ${Math.ceil(expirySeconds / 60)} minutes.`,
            html    : buildOtpEmailHtml({ otp, appName, expirySeconds }),
        });

        console.log(`✅ [OTP EMAIL] Delivered to ${to} — MessageId: ${info.messageId}`);
    } catch (error) {
        // ── Full verbose dump (message + stack + SMTP details) ───────────────
        console.error('❌ CRITICAL SMTP ERROR:', {
            message     : error.message,
            stack       : error.stack,
            code        : error.code,
            command     : error.command,
            responseCode: error.responseCode,
            response    : error.response,
            smtpHost    : process.env.SMTP_HOST,
            smtpPort    : Number(process.env.SMTP_PORT) || DEFAULT_SMTP_PORT,
            smtpUser    : process.env.SMTP_USER,
            recipient   : to,
        });

        // ── Per-error diagnosis ──────────────────────────────────────────────
        if (error.code === 'EAUTH' || error.responseCode === 535) {
            console.error(
                '🔑 FIX → Invalid Login / Auth Failure:\n' +
                '   → Regenerate App Password at https://myaccount.google.com/apppasswords\n' +
                '   → Update SMTP_PASS in .env and restart.'
            );
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
            console.error(
                '🌐 FIX → Connection Refused / Timeout:\n' +
                '   → Try SMTP_PORT=587 + SMTP_SECURE=false (port 465 is blocked on most cloud hosts).'
            );
        } else if (error.code === 'ESOCKET') {
            console.error(
                '🔌 FIX → TLS Socket Error:\n' +
                '   → Try SMTP_PORT=587 + SMTP_SECURE=false.'
            );
        }

        // Re-throw so the caller's .catch() can clean up the DB record
        throw error;
    }
};

module.exports = {
    sendPasswordResetOtpEmail,
    verifySmtpConnection,
};
