import { BrevoClient } from '@getbrevo/brevo';

// ─── Brevo v4 SDK — use BrevoClient (new API in @getbrevo/brevo v4) ──────────
// The old TransactionalSMSApi class no longer exists in v4.
// Authentication is done by passing apiKey directly to the client constructor.
let brevoClient = null;

const getClient = () => {
    if (!brevoClient) {
        brevoClient = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
    }
    return brevoClient;
};

/**
 * Normalize a phone number to E.164 format required by Brevo.
 *
 * Rules (Indian numbers):
 *  - 10-digit number          → +91XXXXXXXXXX
 *  - 12-digit starting 91...  → +91XXXXXXXXXX
 *  - Already has leading +    → kept as-is
 */
const normalizePhone = (phone) => {
    const raw = (phone || '').toString().trim();
    if (raw.startsWith('+')) {
        return '+' + raw.replace(/\D/g, '');
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) {
        return '+91' + digits.slice(-10);
    }
    return '+91' + digits;
};

/**
 * Send a transactional SMS via Brevo.
 *
 * @param {string} to      - Recipient phone number (any format, auto-normalized to E.164)
 * @param {string} content - SMS body text (keep under 160 chars for a single-part SMS)
 * @returns {Promise}      - Resolves with the Brevo API response
 */
export const sendSMS = async (to, content) => {
    const client = getClient();
    const recipient = normalizePhone(to);

    const payload = {
        sender: process.env.BREVO_SMS_SENDER || 'MLAConnect',
        recipient,
        content,
        type: 'transactional',
    };

    return client.transactionalSms.sendTransacSms(payload);
};

/**
 * Fire-and-forget SMS wrapper — errors are logged but never re-thrown.
 * Use this in controllers so an SMS failure never blocks the API response.
 *
 * @param {string} to      - Recipient phone number
 * @param {string} content - SMS body text
 */
export const sendSMSSafe = async (to, content) => {
    try {
        if (!to) return;
        const res = await sendSMS(to, content);
        console.info('[SMS sent]', to, 'Remaining Credits:', res?.remainingCredits);
        return res;
    } catch (err) {
        console.warn('[SMS failed — non-fatal]', to, err.message || err);
    }
};

// Reads FRONTEND_URL fresh on every call. When multiple comma-separated URLs are
// present, prefers the first non-localhost entry so SMS invite links never point
// to localhost:5173 in production.
const getFrontendUrl = () => {
    const urls = (process.env.FRONTEND_URL || '')
        .split(',')
        .map(u => u.trim())
        .filter(Boolean);
    if (urls.length === 0) return 'http://localhost:5173';
    const nonLocal = urls.find(
        u => !u.includes('localhost') && !u.includes('127.0.0.1')
    );
    return nonLocal || urls[0];
};
const APP_NAME = process.env.APP_NAME || 'MLA Connect';

/**
 * Send an Admin Invite SMS with a setup link.
 */
export const sendAdminInviteSMS = async ({ to, name, link }) => {
    const firstName = name ? name.split(' ')[0] : 'Admin';
    const content = `Hi ${firstName}, set your ${APP_NAME} Admin password here: ${link}`;
    return sendSMSSafe(to, content);
};

/**
 * Send an Admin Password Reset SMS with a reset link.
 */
export const sendAdminPasswordResetSMS = async ({ to, name, link }) => {
    const firstName = name ? name.split(' ')[0] : 'Admin';
    const content = `Hi ${firstName}, reset your ${APP_NAME} Admin password here: ${link}`;
    return sendSMSSafe(to, content);
};

/**
 * Send an Admin Forgot Password OTP SMS.
 */
export const sendAdminForgotPasswordOtpSMS = async ({ to, name, otp }) => {
    const firstName = name ? name.split(' ')[0] : 'Admin';
    const content = `Hi ${firstName}, your ${APP_NAME} Admin password reset OTP is ${otp}. Valid for 10 minutes.`;
    return sendSMSSafe(to, content);
};
