import { randomUUID } from 'crypto';
import { sendSMS } from '../services/smsService.js';
import { sendNotificationEmail } from '../utils/email.js';
import { sendWhatsAppMessage } from '../configs/whatsapp.js';
import { followUpUpdateSMS, followUpUpdateWhatsApp, followUpUpdateEmail } from '../services/smsTemplates.js';
import pool from '../configs/db.js';
import { brevoSmsLimiter } from '../services/rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// resolveModulePrefix helper
// ─────────────────────────────────────────────────────────────────────────────
const resolveModulePrefix = (typeOrPrefix) => {
    if (!typeOrPrefix) return null;
    const s = String(typeOrPrefix).trim();
    if (['C-', 'P-', 'I-', 'S-', 'F-'].includes(s)) return s;
    const lower = s.toLowerCase().replace(/[\s_-]/g, '');
    if (lower.startsWith('complaint')) return 'C-';
    if (lower.startsWith('issue') || lower.startsWith('publicissue')) return 'P-';
    if (lower.startsWith('idea')) return 'I-';
    if (lower.startsWith('suggestion')) return 'S-';
    if (lower.startsWith('cmfund') || lower.startsWith('application')) return 'F-';
    return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// createFollowUpUpdate helper — inserts into corresponding module update table
// ─────────────────────────────────────────────────────────────────────────────
const createFollowUpUpdate = async ({ modulePrefix, entityId, title, note, adminUserId, commChannel, didSendSms, finalSms, didSendEmail, finalEmail }) => {
    try {
        if (!modulePrefix || !entityId) return null;
        let updateId = null;

        if (modulePrefix === 'C-') {
            const [res] = await pool.query(
                `INSERT INTO complaint_updates 
                 (complaint_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [entityId, title || 'Communication Sent', note, adminUserId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            updateId = res.insertId;
        } else if (modulePrefix === 'P-') {
            const [res] = await pool.query(
                `INSERT INTO issue_updates 
                 (issue_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [entityId, title || 'Communication Sent', note, adminUserId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            updateId = res.insertId;
        } else if (modulePrefix === 'I-') {
            const [res] = await pool.query(
                `INSERT INTO idea_updates 
                 (idea_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [entityId, title || 'Communication Sent', note, adminUserId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            updateId = res.insertId;
        } else if (modulePrefix === 'S-') {
            const [res] = await pool.query(
                `INSERT INTO suggestion_updates 
                 (suggestion_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [entityId, title || 'Communication Sent', note, adminUserId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            updateId = res.insertId;
        } else if (modulePrefix === 'F-') {
            const [res] = await pool.query(
                `INSERT INTO cm_fund_updates 
                 (request_id, type, title, note, admin_user_id, hide_from_public, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, 0, ?, NOW(), ?, ?, ?, ?, NOW())`,
                [entityId, title || 'Communication Sent', note, adminUserId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            updateId = res.insertId;
        }
        return updateId;
    } catch (err) {
        console.error(`[createFollowUpUpdate] Failed to create follow-up for ${modulePrefix} ${entityId}:`, err.message);
        return null;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// logCommunication helper — writes to centralized polymorphic table
// ─────────────────────────────────────────────────────────────────────────────
const logCommunication = async (modulePrefix, entityId, channel, recipient, message, adminUserId = null, updateId = null) => {
    try {
        if (!modulePrefix || !entityId) return; // Cannot log without association

        const moduleLabels = {
            'C-': 'Complaint',
            'P-': 'Issue',
            'I-': 'Idea',
            'S-': 'Suggestion',
            'F-': 'Application' // CM Fund Request
        };
        const entityType = moduleLabels[modulePrefix];
        if (!entityType) return; // Unknown module type

        await pool.query(
            `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [entityType, entityId, channel, recipient, message, adminUserId, updateId]
        );
    } catch (err) {
        console.error(`[logCommunication] Error logging ${channel} to ${entityType} ${entityId}:`, err.message);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/sms
// Body: { to, message, record_id, record_type }
// ─────────────────────────────────────────────────────────────────────────────
export const sendSMSNotification = async (req, res) => {
    try {
        const { to, message, record_id, record_type } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                message: '"to" (phone) and "message" are required.',
            });
        }

        const result = await sendSMS(to, message);

        // Auto-create follow-up and link communication if associated with a record
        const prefix = resolveModulePrefix(record_type || req.body.module || req.body.module_prefix);
        if (record_id && prefix) {
            const updateId = await createFollowUpUpdate({
                modulePrefix: prefix,
                entityId: record_id,
                title: req.body.status_title || req.body.title || 'Communication Sent',
                note: message,
                adminUserId: req.admin?.id || null,
                commChannel: 'sms',
                didSendSms: true,
                finalSms: message,
                didSendEmail: false,
                finalEmail: null
            });
            await logCommunication(prefix, record_id, 'SMS', to, message, req.admin?.id || null, updateId);
        }

        console.log(
            `[SMS] ✅ Sent to ${to} | ${record_type || 'unknown'} #${record_id || '—'} | Admin: ${req.admin?.full_name || 'system'}`
        );

        res.json({ success: true, message: 'SMS sent successfully.', data: result });
    } catch (err) {
        const errMsg = err?.response?.body?.message || err?.response?.data?.message || err.message;
        console.error('[SMS] ❌ Send failed:', errMsg);
        res.status(500).json({
            success: false,
            message: 'Failed to send SMS.',
            error: errMsg,
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/sms/status
// Returns whether the SMS service is properly configured
// ─────────────────────────────────────────────────────────────────────────────
export const getSMSStatus = (req, res) => {
    const configured = !!(process.env.BREVO_API_KEY && process.env.BREVO_SMS_SENDER);
    res.json({
        success: true,
        configured,
        sender: process.env.BREVO_SMS_SENDER || null,
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/email
// Body: { to, message, subject, record_id, record_type }
// ─────────────────────────────────────────────────────────────────────────────
export const sendEmailNotification = async (req, res) => {
    try {
        const { to, message, subject, record_id, record_type } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                message: '"to" (email) and "message" are required.',
            });
        }

        await sendNotificationEmail({
            to,
            subject: subject || 'Update from MLA Connect',
            message: message,
        });

        // Auto-create follow-up and link communication if associated with a record
        const prefix = resolveModulePrefix(record_type || req.body.module || req.body.module_prefix);
        if (record_id && prefix) {
            const updateId = await createFollowUpUpdate({
                modulePrefix: prefix,
                entityId: record_id,
                title: subject || req.body.status_title || req.body.title || 'Communication Sent',
                note: message,
                adminUserId: req.admin?.id || null,
                commChannel: 'email',
                didSendSms: false,
                finalSms: null,
                didSendEmail: true,
                finalEmail: message
            });
            await logCommunication(prefix, record_id, 'Email', to, message, req.admin?.id || null, updateId);
        }

        console.log(`[Email] ✅ Sent to ${to} | Admin: ${req.admin?.full_name || 'system'}`);

        res.json({ success: true, message: 'Email sent successfully.' });
    } catch (err) {
        console.error('[Email] ❌ Send failed:', err.message);
        res.status(500).json({ success: false, message: 'Failed to send Email.', error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/whatsapp
// Body: { to, message, record_id, record_type }
// ─────────────────────────────────────────────────────────────────────────────
export const sendWhatsAppNotification = async (req, res) => {
    try {
        const { to, message, record_id, record_type } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                message: '"to" (phone) and "message" are required.',
            });
        }

        let phone = to.trim();
        if (phone.startsWith('+')) phone = phone.substring(1);
        if (phone.startsWith('0')) phone = '91' + phone.substring(1);
        if (!phone.startsWith('91') && phone.length === 10) phone = '91' + phone;

        const result = await sendWhatsAppMessage(phone, message);

        // Auto-create follow-up and link communication if associated with a record
        const prefix = resolveModulePrefix(record_type || req.body.module || req.body.module_prefix);
        if (record_id && prefix) {
            const updateId = await createFollowUpUpdate({
                modulePrefix: prefix,
                entityId: record_id,
                title: req.body.status_title || req.body.title || 'Communication Sent',
                note: message,
                adminUserId: req.admin?.id || null,
                commChannel: 'whatsapp',
                didSendSms: false,
                finalSms: null,
                didSendEmail: false,
                finalEmail: null
            });
            await logCommunication(prefix, record_id, 'WhatsApp', waPhone, message, req.admin?.id || null, updateId);
        }

        console.log(`[WhatsApp] ✅ Sent to ${to} | Admin: ${req.admin?.full_name || 'system'}`);

        res.json({ success: true, message: 'WhatsApp message sent successfully.', data: result });
    } catch (err) {
        console.error('[WhatsApp] ❌ Send failed:', err.message);
        res.status(500).json({ success: false, message: 'Failed to send WhatsApp message.', error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// BULK SEND  ──  POST /api/notifications/bulk-send
//
// Accepts a list of contacts + channels.
// Returns 202 immediately with a jobId; processing happens in the background
// using adaptive batching with Brevo rate-limit protection.
//
// Body:
// {
//   contacts: [{ id, module, phone?, email?, name, trackingId }],
//   channels: { sms: bool, email: bool, whatsapp: bool }
// }
// ─────────────────────────────────────────────────────────────────────────────
export const sendBulkNotification = async (req, res) => {
    const { contacts, channels, scheduledAt, messages, subject } = req.body;

    // ── Validate ────────────────────────────────────────────────
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ success: false, message: 'contacts array is required.' });
    }
    if (!channels || (!channels.sms && !channels.email && !channels.whatsapp)) {
        return res.status(400).json({ success: false, message: 'At least one channel must be selected.' });
    }

    const jobId   = randomUUID();
    const adminId = req.admin?.id || 0;
    const payload = JSON.stringify({ contacts, channels, messages, subject });

    let initialStatus = 'queued';
    let queryParams = [jobId, adminId, initialStatus, JSON.stringify(channels), contacts.length, null, payload];
    let queryStr = `
        INSERT INTO bulk_send_jobs (id, admin_id, status, channels, total_count, scheduled_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    if (scheduledAt) {
        initialStatus = 'scheduled';
        queryParams = [jobId, adminId, initialStatus, JSON.stringify(channels), contacts.length, new Date(scheduledAt), payload];
    }

    // ── Persist job row ─────────────────────────────────────────
    try {
        await pool.query(queryStr, queryParams);
    } catch (err) {
        console.error('[BulkSend] Failed to create job row:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to create bulk send job.' });
    }

    // ── Return 202 immediately so the UI can start polling ──────
    res.status(202).json({
        success: true,
        message: scheduledAt ? 'Bulk send job scheduled.' : 'Bulk send job queued.',
        jobId,
        total: contacts.length,
    });

    // ── Process asynchronously (fire-and-forget) ────────────────
    if (!scheduledAt) {
        setImmediate(() =>
            processBulkJob({ jobId, contacts, channels, messages, subject, adminUserId: req.admin?.id || null })
                .catch(err => {
                    console.error('[BulkSend] Unhandled error in processBulkJob:', err.message);
                    pool.query(
                        "UPDATE bulk_send_jobs SET status='failed', completed_at=NOW() WHERE id=?",
                        [jobId]
                    ).catch(() => {});
                })
        );
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/bulk-send/:jobId  — Poll job status
// ─────────────────────────────────────────────────────────────────────────────
export const getBulkJobStatus = async (req, res) => {
    try {
        const [[job]] = await pool.query(
            `SELECT id, status, channels, total_count, sent_count, failed_count,
                    error_log, created_at, completed_at
             FROM bulk_send_jobs WHERE id = ?`,
            [req.params.jobId]
        );
        if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
        return res.json({ success: true, data: job });
    } catch (err) {
        console.error('[BulkSend:status]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch job status.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/bulk-send/:jobId/cancel
// ─────────────────────────────────────────────────────────────────────────────
export const cancelBulkJob = async (req, res) => {
    try {
        const [[job]] = await pool.query(
            'SELECT id, status FROM bulk_send_jobs WHERE id = ?',
            [req.params.jobId]
        );
        if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
            return res.status(400).json({ success: false, message: 'Job cannot be cancelled in its current state.' });
        }
        await pool.query(
            "UPDATE bulk_send_jobs SET status='cancelled', completed_at=NOW() WHERE id=?",
            [req.params.jobId]
        );
        return res.json({ success: true, message: 'Job cancelled.' });
    } catch (err) {
        console.error('[BulkSend:cancel]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel job.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Simple promise-based sleep */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Normalise any Indian phone number to E.164 (+91XXXXXXXXXX). */
const normalisePhone = (raw) => {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    return '+91' + digits.slice(-10);
};

/**
 * sendWithRetry — calls fn(), retrying on 429/503/generic 5xx with full randomized jitter.
 *
 * On 429: reads Retry-After header (or uses exponential backoff with jitter).
 * On 503: waits 10 s with jitter before retrying.
 * On 400/401: non-retryable; throws immediately.
 * On other errors: waits with exponential backoff before retrying.
 *
 * Returns normally on success; throws on exhausted retries.
 */
const sendWithRetry = async (fn, contactId, channel, maxRetries = 3) => {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (channel === 'sms') {
                await brevoSmsLimiter.acquire();
            }
            await fn();
            return; // success
        } catch (err) {
            lastErr = err;
            const httpStatus = err?.response?.status || err?.status || err?.statusCode;
            const jitterMs = Math.floor(Math.random() * 800) + 200; // 200ms - 1000ms randomized jitter

            if (httpStatus === 429) {
                const retryAfterHeader = parseInt(err?.response?.headers?.['retry-after'], 10);
                const waitMs = (!isNaN(retryAfterHeader) && retryAfterHeader > 0)
                    ? (retryAfterHeader * 1000) + jitterMs
                    : Math.min(30_000, (Math.pow(2, attempt) * 2000) + jitterMs);

                console.warn(
                    `[BulkSend] 429 rate-limited (contact=${contactId}, ch=${channel}). ` +
                    `Waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${maxRetries})…`
                );
                await sleep(waitMs);
                continue;
            }

            // 503 — brief service unavailability
            if (httpStatus === 503) {
                const waitMs = 10_000 + jitterMs;
                console.warn(`[BulkSend] 503 for contact=${contactId}, ch=${channel}. Waiting ${Math.round(waitMs / 1000)}s…`);
                await sleep(waitMs);
                continue;
            }

            // 400/401 — non-retryable (bad number, invalid auth, etc.)
            if (httpStatus === 400 || httpStatus === 401) break;

            // Other errors — exponential backoff with jitter
            if (attempt < maxRetries) {
                const waitMs = (Math.pow(2, attempt) * 1500) + jitterMs;
                await sleep(waitMs);
            }
        }
    }
    throw lastErr;
};



// ─────────────────────────────────────────────────────────────────────────────
// processBulkJob — core background processor
//
// Adaptive batching:
//   • Starts at INITIAL_BATCH_SIZE contacts processed concurrently per batch
//   • Waits INITIAL_DELAY_MS between batches
//   • On any 429 in a batch → halve batchSize, double delay (capped)
//   • After RECOVER_AFTER_CLEAN consecutive clean batches → recover size/delay
// ─────────────────────────────────────────────────────────────────────────────
export const processBulkJob = async ({ jobId, contacts, channels, messages, subject, adminUserId = null }) => {
    const INITIAL_BATCH_SIZE  = 10;
    const INITIAL_DELAY_MS    = 2_000;
    const MIN_BATCH_SIZE      = 1;
    const MAX_BATCH_SIZE      = 10;
    const MIN_DELAY_MS        = 2_000;
    const MAX_DELAY_MS        = 30_000;
    const RECOVER_AFTER_CLEAN = 5;

    let batchSize    = INITIAL_BATCH_SIZE;
    let batchDelayMs = INITIAL_DELAY_MS;
    let cleanStreak  = 0;
    let sentCount    = 0;
    let failedCount  = 0;
    const errorLog   = [];

    // Mark running
    await pool.query("UPDATE bulk_send_jobs SET status='running' WHERE id=?", [jobId]);

    let batchStart = 0;
    while (batchStart < contacts.length) {
        // Check for cancellation between batches
        const [[jobRow]] = await pool.query(
            'SELECT status FROM bulk_send_jobs WHERE id=?',
            [jobId]
        );
        if (!jobRow || jobRow.status === 'cancelled') {
            console.log(`[BulkSend:${jobId}] Cancelled — stopping.`);
            return;
        }

        const batch = contacts.slice(batchStart, batchStart + batchSize);
        let batchHad429 = false;

        await Promise.all(batch.map(async (contact) => {
            let contactSentAny = false;

            // ── Official Template Generation ──────────────────────────
            const moduleLabels = {
                'C-': 'Complaint',
                'P-': 'Public Issue',
                'I-': 'Idea',
                'S-': 'Suggestion',
                'F-': 'CM Fund Request'
            };
            const label = moduleLabels[contact.module] || 'Application';
            
            const templateData = {
                name: contact.name || 'Citizen',
                referenceNo: contact.trackingId || '—',
                statusTitle: contact.statusText || 'We are reviewing your submission.',
                moduleLabel: label,
                updateDate: new Date(),
                dateFiled: contact.dateFiled || null,
            };

            const formatMessageWithPlaceholders = (text) => {
                if (!text) return '';
                const nowStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                return text
                    .replace(/{{name}}/gi, templateData.name)
                    .replace(/{{trackingId}}/gi, templateData.referenceNo)
                    .replace(/{{reference_no}}/gi, templateData.referenceNo)
                    .replace(/{{module}}/gi, label)
                    .replace(/{{statusText}}/gi, templateData.statusTitle)
                    .replace(/{{date}}/gi, nowStr)
                    .replace(/{{filedDate}}/gi, templateData.dateFiled ? new Date(templateData.dateFiled).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
            };

            const pSms = channels.sms
                ? (messages?.sms
                    ? formatMessageWithPlaceholders(messages.sms)
                    : followUpUpdateSMS(templateData))
                : '';

            const pWhatsapp = channels.whatsapp
                ? (messages?.whatsapp
                    ? formatMessageWithPlaceholders(messages.whatsapp)
                    : followUpUpdateWhatsApp(templateData))
                : '';

            const emailObj = channels.email
                ? (messages?.email
                    ? {
                        subject: subject || `Update on your ${label} (${templateData.referenceNo})`,
                        body: formatMessageWithPlaceholders(messages.email)
                      }
                    : followUpUpdateEmail(templateData))
                : null;

            let didSendSms = false;
            let didSendEmail = false;
            let didSendWa = false;
            let finalSms = null;
            let finalEmail = null;
            let finalWa = null;

            // ── SMS ──────────────────────────────────────────────
            if (channels.sms && contact.phone) {
                try {
                    const phone = normalisePhone(contact.phone);
                    await sendWithRetry(
                        () => sendSMS(phone, pSms),
                        contact.id, 'sms'
                    );
                    didSendSms = true;
                    finalSms = pSms;
                } catch (err) {
                    const status = err?.response?.status || err?.status || err?.statusCode;
                    if (status === 429) batchHad429 = true;
                    errorLog.push({ contactId: contact.id, channel: 'sms', error: err.message });
                    console.error(`[BulkSend] SMS ❌ contact=${contact.id}:`, err.message);
                }
            }

            // ── Email ────────────────────────────────────────────
            if (channels.email && contact.email && emailObj) {
                try {
                    await sendWithRetry(
                        () => sendNotificationEmail({
                            to:      contact.email,
                            subject: emailObj.subject,
                            message: emailObj.body,
                        }),
                        contact.id, 'email'
                    );
                    didSendEmail = true;
                    finalEmail = emailObj.body;
                } catch (err) {
                    const status = err?.response?.status || err?.status || err?.statusCode;
                    if (status === 429) batchHad429 = true;
                    errorLog.push({ contactId: contact.id, channel: 'email', error: err.message });
                    console.error(`[BulkSend] Email ❌ contact=${contact.id}:`, err.message);
                }
            }

            // ── WhatsApp ─────────────────────────────────────────
            if (channels.whatsapp && contact.phone) {
                try {
                    const raw    = String(contact.phone).replace(/\D/g, '');
                    const waPhone = raw.length === 10 ? `91${raw}` : (raw.startsWith('91') ? raw : raw);
                    await sendWithRetry(
                        () => sendWhatsAppMessage(waPhone, pWhatsapp),
                        contact.id, 'whatsapp'
                    );
                    didSendWa = true;
                    finalWa = pWhatsapp;
                } catch (err) {
                    const status = err?.response?.status || err?.status || err?.statusCode;
                    if (status === 429) batchHad429 = true;
                    errorLog.push({ contactId: contact.id, channel: 'whatsapp', error: err.message });
                    console.error(`[BulkSend] WhatsApp ❌ contact=${contact.id}:`, err.message);
                }
            }

            // ── Auto-create Follow-up Update and Log Communication ─────────────────
            if (didSendSms || didSendEmail || didSendWa) {
                contactSentAny = true;

                let commChannel = 'sms';
                if (didSendSms && didSendEmail) commChannel = 'both';
                else if (didSendSms) commChannel = 'sms';
                else if (didSendEmail) commChannel = 'email';
                else if (didSendWa) commChannel = 'whatsapp';

                const followUpTitle = contact.statusText || 'Communication Sent';
                const followUpNote = finalSms || finalEmail || finalWa;

                const updateId = await createFollowUpUpdate({
                    modulePrefix: contact.module,
                    entityId: contact.id,
                    title: followUpTitle,
                    note: followUpNote,
                    adminUserId,
                    commChannel,
                    didSendSms,
                    finalSms,
                    didSendEmail,
                    finalEmail
                });

                if (didSendSms) {
                    const phone = normalisePhone(contact.phone);
                    await logCommunication(contact.module, contact.id, 'SMS', phone, finalSms, adminUserId, updateId);
                }
                if (didSendEmail) {
                    await logCommunication(contact.module, contact.id, 'Email', contact.email, finalEmail, adminUserId, updateId);
                }
                if (didSendWa) {
                    const raw = String(contact.phone).replace(/\D/g, '');
                    const waPhone = raw.length === 10 ? `91${raw}` : (raw.startsWith('91') ? raw : raw);
                    await logCommunication(contact.module, contact.id, 'WhatsApp', waPhone, finalWa, adminUserId, updateId);
                }
            }

            // Count at contact level: sent if at least one channel succeeded
            if (contactSentAny) { sentCount++; } else { failedCount++; }
        }));

        // Persist progress after every batch
        await pool.query(
            'UPDATE bulk_send_jobs SET sent_count=?, failed_count=?, error_log=? WHERE id=?',
            [sentCount, failedCount, JSON.stringify(errorLog), jobId]
        );

        // Adaptive rate control
        if (batchHad429) {
            cleanStreak  = 0;
            batchSize    = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
            batchDelayMs = Math.min(MAX_DELAY_MS, batchDelayMs * 2);
            console.warn(
                `[BulkSend:${jobId}] Rate-limit → batchSize=${batchSize}, delay=${batchDelayMs}ms`
            );
        } else {
            cleanStreak++;
            if (cleanStreak >= RECOVER_AFTER_CLEAN) {
                cleanStreak  = 0;
                batchSize    = Math.min(MAX_BATCH_SIZE, batchSize + 1);
                batchDelayMs = Math.max(MIN_DELAY_MS, batchDelayMs - 500);
            }
        }

        batchStart += batch.length; // advance by actual batch processed (may < batchSize)

        // Wait between batches (skip after last batch)
        if (batchStart < contacts.length) await sleep(batchDelayMs);
    }

    // Finalise
    const finalStatus = failedCount === 0 ? 'completed'
                      : sentCount  === 0 ? 'failed'
                      : 'partial_failure';

    await pool.query(
        `UPDATE bulk_send_jobs
         SET status=?, sent_count=?, failed_count=?, error_log=?, completed_at=NOW()
         WHERE id=?`,
        [finalStatus, sentCount, failedCount, JSON.stringify(errorLog), jobId]
    );

    console.log(
        `[BulkSend:${jobId}] ✅ ${finalStatus} — sent=${sentCount}, failed=${failedCount}`
    );
};
