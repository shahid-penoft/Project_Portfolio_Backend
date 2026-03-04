import pool from '../configs/db.js';
import { successResponse, errorResponse } from '../utils/helpers.js';
import { sendEnquiryReceivedEmail, sendAdminEnquiryAlert, sendEnquiryReplyEmail } from '../utils/email.js';
import { sendBrevoSMS } from '../configs/sms.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate, sendWhatsAppInteractive } from '../configs/whatsapp.js';
import { sendVoiceMessage } from '../configs/voice.js';

const CATEGORIES = ['membership', 'local issues', 'submit ideas', 'submit opinions', 'general'];

// ─────────────────────────────────────────────────────────────
//  POST /api/contact  — Public (no auth required)
// ─────────────────────────────────────────────────────────────
export const submitContact = async (req, res) => {
    const { full_name, mobile, email, panchayat_id, category, subject, message } = req.body;

    if (!full_name?.trim() || !mobile?.trim() || !email?.trim() || !message?.trim()) {
        return errorResponse(res, 'full_name, mobile, email and message are required.', 400);
    }
    if (category && !CATEGORIES.includes(category.toLowerCase())) {
        return errorResponse(res, `Invalid category. Must be one of: ${CATEGORIES.join(', ')}.`, 400);
    }

    try {
        const [result] = await pool.query(
            `INSERT INTO contact_enquiries
             (full_name, mobile, email, panchayat_id, category, subject, message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                full_name.trim(),
                mobile.trim(),
                email.trim(),
                panchayat_id || null,
                category?.toLowerCase() || 'general',
                subject?.trim() || null,
                message.trim(),
            ]
        );

        const enquiryId = result.insertId;

        // Fetch panchayat name for use in emails
        let panchayatName = 'N/A';
        if (panchayat_id) {
            const [[lb]] = await pool.query('SELECT name FROM local_bodies WHERE id = ?', [panchayat_id]);
            if (lb) panchayatName = lb.name;
        }

        const enquiry = {
            id: enquiryId,
            full_name: full_name.trim(),
            mobile: mobile.trim(),
            email: email.trim(),
            panchayat: panchayatName,
            category: category?.toLowerCase() || 'general',
            subject: subject?.trim() || 'N/A',
            message: message.trim(),
        };

        // ── Enquiry Automations ──────────────────────────────────
        let automationTriggered = false;
        const triggerAutomation = async () => {
            try {
                const [[auto]] = await pool.query(
                    `SELECT a.*, t.type AS template_type, t.content, t.subject AS template_subject, 
                            t.header_type, t.header_url, t.buttons_json
                     FROM enquiry_automations a
                     JOIN message_templates t ON t.id = a.template_id
                     WHERE a.category = ? AND a.is_active = 1 AND t.is_active = 1`,
                    [enquiry.category]
                );

                console.log(`[AutomationCheck] Category: ${enquiry.category}, Found: ${!!auto}`);

                if (auto) {
                    automationTriggered = true;
                    let finalMessage = auto.content;
                    finalMessage = finalMessage.replace(/{name}/g, enquiry.full_name);
                    finalMessage = finalMessage.replace(/{email}/g, enquiry.email);
                    finalMessage = finalMessage.replace(/{mobile}/g, enquiry.mobile);

                    if (auto.template_type === 'email') {
                        await sendEnquiryReplyEmail({
                            to: enquiry.email,
                            full_name: enquiry.full_name,
                            subject: auto.template_subject || enquiry.subject,
                            replyMessage: finalMessage,
                        });
                    } else if (auto.template_type === 'sms') {
                        let phone = enquiry.mobile.trim();
                        if (!phone.startsWith('+')) phone = phone.startsWith('0') ? '+91' + phone.substring(1) : '+91' + phone;
                        await sendBrevoSMS(phone, finalMessage);
                    } else if (auto.template_type === 'whatsapp') {
                        let phone = enquiry.mobile.trim();
                        if (phone.startsWith('+')) phone = phone.substring(1);
                        if (phone.startsWith('0')) phone = '91' + phone.substring(1);
                        if (!phone.startsWith('91') && phone.length === 10) phone = '91' + phone;

                        const buttons = typeof auto.buttons_json === 'string' ? JSON.parse(auto.buttons_json) : auto.buttons_json;
                        const header = auto.header_type !== 'none' ? { type: auto.header_type, url: auto.header_url, content: auto.header_url } : null;

                        if (buttons?.length > 0 || (header && header.type !== 'none' && header.type !== 'text')) {
                            await sendWhatsAppInteractive(phone, header, finalMessage, buttons || []);
                        } else {
                            await sendWhatsAppMessage(phone, finalMessage);
                        }
                    }

                    // Log automated communication
                    await pool.query(
                        `INSERT INTO enquiry_communications (enquiry_id, template_id, type, recipient, message, status)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [enquiryId, auto.template_id, auto.template_type,
                            auto.template_type === 'email' ? enquiry.email : enquiry.mobile, finalMessage, 'automated']
                    ).catch(e => console.error('[Log Automation]', e));
                }
            } catch (err) {
                console.error('[triggerAutomation]', err);
            }
        };

        // Trigger automation and emails
        await triggerAutomation();

        const notifications = [
            sendAdminEnquiryAlert(enquiry).catch(e => console.error('[Email:AdminAlert]', e))
        ];

        // Skip default confirmation ONLY if an automated EMAIL was triggered
        // (If it was SMS/WhatsApp automation, we still want the email confirmation)
        if (!automationTriggered) {
            notifications.push(sendEnquiryReceivedEmail(enquiry).catch(e => console.error('[Email:UserConfirm]', e)));
        }

        await Promise.all(notifications);

        return successResponse(res, { id: enquiryId }, 'Your enquiry has been submitted successfully.', 201);
    } catch (err) {
        console.error('[submitContact]', err);
        return errorResponse(res, 'Failed to submit enquiry.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact  — Admin: paginated list with filters
// ─────────────────────────────────────────────────────────────
export const getEnquiries = async (req, res) => {
    const { search, category, status, panchayat_id } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 15);
    const offset = (page - 1) * limit;

    try {
        let where = 'WHERE 1=1';
        const params = [];

        if (search) {
            const like = `%${search}%`;
            where += ' AND (c.full_name LIKE ? OR c.email LIKE ? OR c.subject LIKE ? OR c.message LIKE ?)';
            params.push(like, like, like, like);
        }
        if (category && category !== 'all') {
            where += ' AND c.category = ?';
            params.push(category.toLowerCase());
        }
        if (status && status !== 'all') {
            where += ' AND c.status = ?';
            params.push(status);
        }
        if (panchayat_id && panchayat_id !== 'all') {
            where += ' AND c.panchayat_id = ?';
            params.push(panchayat_id);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM contact_enquiries c ${where}`, params
        );

        const [rows] = await pool.query(
            `SELECT c.*, lb.name AS panchayat_name
             FROM contact_enquiries c
             LEFT JOIN local_bodies lb ON lb.id = c.panchayat_id
             ${where}
             ORDER BY c.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return successResponse(res, {
            data: rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        }, 'Enquiries fetched.');
    } catch (err) {
        console.error('[getEnquiries]', err);
        return errorResponse(res, 'Failed to fetch enquiries.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact/:id  — Admin
// ─────────────────────────────────────────────────────────────
export const getEnquiryById = async (req, res) => {
    try {
        const [[row]] = await pool.query(
            `SELECT c.*, lb.name AS panchayat_name
             FROM contact_enquiries c
             LEFT JOIN local_bodies lb ON lb.id = c.panchayat_id
             WHERE c.id = ?`,
            [req.params.id]
        );
        if (!row) return errorResponse(res, 'Enquiry not found.', 404);
        return successResponse(res, { data: row }, 'Enquiry fetched.');
    } catch (err) {
        console.error('[getEnquiryById]', err);
        return errorResponse(res, 'Failed to fetch enquiry.');
    }
};

// ─────────────────────────────────────────────────────────────
//  PATCH /api/contact/:id/status  — Admin: mark read/resolved
// ─────────────────────────────────────────────────────────────
export const updateEnquiryStatus = async (req, res) => {
    const { status } = req.body;
    const VALID = ['new', 'read', 'resolved'];
    if (!VALID.includes(status)) {
        return errorResponse(res, `status must be one of: ${VALID.join(', ')}.`, 400);
    }
    try {
        const [r] = await pool.query(
            'UPDATE contact_enquiries SET status = ? WHERE id = ?',
            [status, req.params.id]
        );
        if (r.affectedRows === 0) return errorResponse(res, 'Enquiry not found.', 404);
        return successResponse(res, null, `Enquiry marked as ${status}.`);
    } catch (err) {
        console.error('[updateEnquiryStatus]', err);
        return errorResponse(res, 'Failed to update status.');
    }
};

// ─────────────────────────────────────────────────────────────
//  DELETE /api/contact/:id  — Admin
// ─────────────────────────────────────────────────────────────
export const deleteEnquiry = async (req, res) => {
    try {
        const [r] = await pool.query('DELETE FROM contact_enquiries WHERE id = ?', [req.params.id]);
        if (r.affectedRows === 0) return errorResponse(res, 'Enquiry not found.', 404);
        return successResponse(res, null, 'Enquiry deleted.');
    } catch (err) {
        console.error('[deleteEnquiry]', err);
        return errorResponse(res, 'Failed to delete enquiry.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/:id/send-sms  — Admin: Send SMS
// ─────────────────────────────────────────────────────────────
export const sendSMS = async (req, res) => {
    const { message, templateId } = req.body;
    const enquiryId = req.params.id;

    if (!message?.trim()) {
        return errorResponse(res, 'Message content is required.', 400);
    }

    try {
        const [[enquiry]] = await pool.query('SELECT mobile FROM contact_enquiries WHERE id = ?', [enquiryId]);
        if (!enquiry) return errorResponse(res, 'Enquiry not found.', 404);

        let phone = enquiry.mobile.trim();
        if (!phone.startsWith('+')) {
            phone = phone.startsWith('0') ? '+91' + phone.substring(1) : '+91' + phone;
        }

        const result = await sendBrevoSMS(phone, message.trim());

        await pool.query(
            `INSERT INTO enquiry_communications (enquiry_id, template_id, type, recipient, message, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [enquiryId, templateId || null, 'sms', phone, message.trim(), 'sent']
        ).catch(e => console.error('[Log SMS]', e));

        return successResponse(res, { data: result.data }, 'SMS sent successfully.');
    } catch (err) {
        console.error('[sendSMS]', err);
        return errorResponse(res, err.message || 'Failed to send SMS.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/:id/send-email  — Admin: Reply via Email
// ─────────────────────────────────────────────────────────────
export const sendEmail = async (req, res) => {
    const { message, templateId } = req.body;
    const enquiryId = req.params.id;

    if (!message?.trim()) {
        return errorResponse(res, 'Message content is required.', 400);
    }

    try {
        const [[enquiry]] = await pool.query(
            'SELECT full_name, email, subject FROM contact_enquiries WHERE id = ?',
            [enquiryId]
        );
        if (!enquiry) return errorResponse(res, 'Enquiry not found.', 404);

        await sendEnquiryReplyEmail({
            to: enquiry.email,
            full_name: enquiry.full_name,
            subject: enquiry.subject,
            replyMessage: message.trim(),
        });

        await pool.query(
            `INSERT INTO enquiry_communications (enquiry_id, template_id, type, recipient, message, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [enquiryId, templateId || null, 'email', enquiry.email, message.trim(), 'sent']
        ).catch(e => console.error('[Log Email]', e));

        return successResponse(res, null, 'Email reply sent successfully.');
    } catch (err) {
        console.error('[sendEmail]', err);
        return errorResponse(res, err.message || 'Failed to send email reply.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/:id/send-whatsapp  — Admin: Send WhatsApp msg
// ─────────────────────────────────────────────────────────────
export const sendWhatsApp = async (req, res) => {
    const { message, templateId } = req.body;
    const enquiryId = req.params.id;

    if (!message?.trim() && !templateId) {
        return errorResponse(res, 'Message or templateId is required.', 400);
    }

    try {
        const [[enquiry]] = await pool.query('SELECT mobile, full_name, email FROM contact_enquiries WHERE id = ?', [enquiryId]);
        if (!enquiry) return errorResponse(res, 'Enquiry not found.', 404);

        let phone = enquiry.mobile.trim();
        if (phone.startsWith('+')) phone = phone.substring(1);
        if (phone.startsWith('0')) phone = '91' + phone.substring(1);
        if (!phone.startsWith('91') && phone.length === 10) phone = '91' + phone;

        let result;
        let finalMessage = message;

        if (templateId) {
            const [[tmpl]] = await pool.query('SELECT * FROM message_templates WHERE id = ?', [templateId]);
            if (tmpl && tmpl.type === 'whatsapp') {
                const buttons = typeof tmpl.buttons_json === 'string' ? JSON.parse(tmpl.buttons_json) : tmpl.buttons_json;
                const header = tmpl.header_type !== 'none' ? { type: tmpl.header_type, url: tmpl.header_url, content: tmpl.header_url } : null;

                if (buttons?.length > 0 || (header && header.type !== 'none' && header.type !== 'text')) {
                    result = await sendWhatsAppInteractive(phone, header, message || tmpl.content, buttons || []);
                } else {
                    result = await sendWhatsAppMessage(phone, message || tmpl.content);
                }
                finalMessage = message || tmpl.content;
            } else {
                result = await sendWhatsAppMessage(phone, message);
            }
        } else {
            result = await sendWhatsAppMessage(phone, message.trim());
        }

        await pool.query(
            `INSERT INTO enquiry_communications (enquiry_id, template_id, type, recipient, message, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [enquiryId, templateId || null, 'whatsapp', phone, finalMessage, 'sent']
        ).catch(e => console.error('[Log WhatsApp]', e));

        return successResponse(res, { data: result?.data || null }, 'WhatsApp message sent successfully.');
    } catch (err) {
        console.error('[sendWhatsApp]', err);
        return errorResponse(res, err.message || 'Failed to send WhatsApp message.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/:id/send-voice  — Admin: Send Voice Message
// ─────────────────────────────────────────────────────────────
export const sendVoice = async (req, res) => {
    const { message } = req.body;
    const enquiryId = req.params.id;

    if (!message?.trim()) {
        return errorResponse(res, 'Message content is required.', 400);
    }

    try {
        const [[enquiry]] = await pool.query('SELECT mobile FROM contact_enquiries WHERE id = ?', [enquiryId]);
        if (!enquiry) return errorResponse(res, 'Enquiry not found.', 404);

        let phone = enquiry.mobile.trim();
        if (!phone.startsWith('+')) {
            phone = phone.startsWith('0') ? '+91' + phone.substring(1) : '+91' + phone;
        }

        const result = await sendVoiceMessage(phone, message.trim());

        if (result.success) {
            await pool.query(
                `INSERT INTO enquiry_communications (enquiry_id, type, recipient, message, status) 
                 VALUES (?, ?, ?, ?, ?)`,
                [enquiryId, 'voice', phone, message.trim(), 'sent']
            ).catch(e => console.error('[Log Voice]', e));

            return successResponse(res, { data: result.data }, 'Voice message sent successfully.');
        } else {
            return errorResponse(res, result.error || 'Voice service not available.', 503);
        }
    } catch (err) {
        console.error('[sendVoice]', err);
        return errorResponse(res, err.message || 'Failed to send voice message.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact/:id/communications  — Admin: Get message logs
// ─────────────────────────────────────────────────────────────
export const getCommunications = async (req, res) => {
    const enquiryId = req.params.id;

    try {
        const [communications] = await pool.query(
            `SELECT * FROM enquiry_communications 
             WHERE enquiry_id = ? 
             ORDER BY created_at DESC`,
            [enquiryId]
        );

        return successResponse(res, { data: communications }, 'Communications fetched.');
    } catch (err) {
        console.error('[getCommunications]', err);
        return successResponse(res, { data: [] }, 'Communications fetched.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/bulk/send  — Admin: Bulk Message
// ─────────────────────────────────────────────────────────────
export const bulkSend = async (req, res) => {
    const { search, category, status, panchayat_id, type, templateId, message } = req.body;

    if (!type || (!message?.trim() && !templateId)) {
        return errorResponse(res, 'Type and (message or templateId) are required.', 400);
    }

    try {
        // 1. Build Filtered Query
        let where = 'WHERE 1=1';
        const params = [];

        if (search) {
            const like = `%${search}%`;
            where += ' AND (c.full_name LIKE ? OR c.email LIKE ? OR c.subject LIKE ? OR c.message LIKE ?)';
            params.push(like, like, like, like);
        }
        if (category && category !== 'all') {
            where += ' AND c.category = ?';
            params.push(category.toLowerCase());
        }
        if (status && status !== 'all') {
            where += ' AND c.status = ?';
            params.push(status);
        }
        if (panchayat_id && panchayat_id !== 'all') {
            where += ' AND c.panchayat_id = ?';
            params.push(panchayat_id);
        }

        // 2. Fetch all matching recipients
        const [recipients] = await pool.query(
            `SELECT id, full_name, mobile, email, subject FROM contact_enquiries c ${where}`,
            params
        );

        if (recipients.length === 0) {
            return errorResponse(res, 'No recipients found matching the filters.', 404);
        }

        // 3. Fetch Template if provided
        let template = null;
        if (templateId) {
            const [[tmpl]] = await pool.query('SELECT * FROM message_templates WHERE id = ?', [templateId]);
            template = tmpl;
        }

        // 4. Batch Process Sending
        const results = { success: 0, failure: 0, total: recipients.length };

        for (const target of recipients) {
            try {
                let finalMessage = message || template?.content || '';

                // Replace placeholders
                finalMessage = finalMessage.replace(/{name}/g, target.full_name || '');
                finalMessage = finalMessage.replace(/{email}/g, target.email || '');
                finalMessage = finalMessage.replace(/{mobile}/g, target.mobile || '');

                if (type === 'sms') {
                    let phone = target.mobile.trim();
                    if (!phone.startsWith('+')) phone = phone.startsWith('0') ? '+91' + phone.substring(1) : '+91' + phone;
                    await sendBrevoSMS(phone, finalMessage);
                }
                else if (type === 'email') {
                    await sendEnquiryReplyEmail({
                        to: target.email,
                        full_name: target.full_name,
                        subject: template?.subject || target.subject || 'Reply to your enquiry',
                        replyMessage: finalMessage,
                    });
                }
                else if (type === 'whatsapp') {
                    let phone = target.mobile.trim();
                    if (phone.startsWith('+')) phone = phone.substring(1);
                    if (phone.startsWith('0')) phone = '91' + phone.substring(1);
                    if (!phone.startsWith('91') && phone.length === 10) phone = '91' + phone;

                    if (template && template.type === 'whatsapp') {
                        const buttons = typeof template.buttons_json === 'string' ? JSON.parse(template.buttons_json) : template.buttons_json;
                        const header = template.header_type !== 'none' ? { type: template.header_type, url: template.header_url, content: template.header_url } : null;

                        if (buttons?.length > 0 || (header && header.type !== 'none' && header.type !== 'text')) {
                            await sendWhatsAppInteractive(phone, header, finalMessage, buttons || []);
                        } else {
                            await sendWhatsAppMessage(phone, finalMessage);
                        }
                    } else {
                        await sendWhatsAppMessage(phone, finalMessage);
                    }
                }

                // Log communication
                await pool.query(
                    `INSERT INTO enquiry_communications (enquiry_id, template_id, type, recipient, message, status) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [target.id, templateId || null, type, type === 'email' ? target.email : target.mobile, finalMessage, 'sent']
                ).catch(e => console.error('[Log Bulk]', e));

                results.success++;
            } catch (err) {
                console.error(`[BulkSend:ItemFail] Target ${target.id}:`, err.message);
                results.failure++;
            }
        }

        return successResponse(res, { data: results }, `Bulk ${type} process completed.`);
    } catch (err) {
        console.error('[bulkSend]', err);
        return errorResponse(res, 'Failed to process bulk messages.');
    }
};

// ─────────────────────────────────────────────────────────────
//  Automations Management
// ─────────────────────────────────────────────────────────────

export const getAutomations = async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT a.*, t.name AS template_name, t.type AS template_type
             FROM enquiry_automations a
             LEFT JOIN message_templates t ON t.id = a.template_id
             ORDER BY a.category`
        );
        return successResponse(res, { data: rows });
    } catch (err) {
        console.error('[getAutomations]', err);
        return errorResponse(res, 'Failed to fetch automations.');
    }
};

export const upsertAutomation = async (req, res) => {
    const { category, template_id, is_active } = req.body;

    if (!category || !template_id) {
        return errorResponse(res, 'Category and template_id are required.', 400);
    }

    try {
        const [r] = await pool.query(
            `INSERT INTO enquiry_automations (category, template_id, is_active)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE template_id = VALUES(template_id), is_active = VALUES(is_active)`,
            [category, template_id, is_active === undefined ? 1 : is_active]
        );

        return successResponse(res, null, 'Automation rule updated successfully.');
    } catch (err) {
        console.error('[upsertAutomation]', err);
        return errorResponse(res, 'Failed to save automation rule.');
    }
};

export const deleteAutomation = async (req, res) => {
    try {
        const [r] = await pool.query('DELETE FROM enquiry_automations WHERE id = ?', [req.params.id]);
        if (r.affectedRows === 0) return errorResponse(res, 'Automation rule not found.', 404);
        return successResponse(res, null, 'Automation rule deleted.');
    } catch (err) {
        console.error('[deleteAutomation]', err);
        return errorResponse(res, 'Failed to delete automation rule.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact/stats  — Admin: summary counts + SLA metrics
// ─────────────────────────────────────────────────────────────
export const getEnquiryStats = async (req, res) => {
    try {
        // Core status counts
        const [[totals]] = await pool.query(
            `SELECT
                COUNT(*) AS total,
                SUM(status = 'new')      AS new_count,
                SUM(status = 'read')     AS read_count,
                SUM(status = 'resolved') AS resolved_count,
                SUM(status != 'resolved' AND created_at < NOW() - INTERVAL 72 HOUR) AS overdue_count
             FROM contact_enquiries`
        );

        // Average resolution time (hours) for resolved enquiries
        const [[resolution]] = await pool.query(
            `SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, created_at, updated_at)), 1) AS avg_hours
             FROM contact_enquiries
             WHERE status = 'resolved'`
        );

        // By category breakdown
        const [byCategory] = await pool.query(
            `SELECT category, COUNT(*) AS count
             FROM contact_enquiries
             GROUP BY category
             ORDER BY count DESC`
        );

        // Last 7 days daily trend
        const [weeklyTrend] = await pool.query(
            `SELECT
                DATE(created_at) AS day,
                COUNT(*) AS count
             FROM contact_enquiries
             WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
             GROUP BY DATE(created_at)
             ORDER BY day ASC`
        );

        // Top panchayats by volume
        const [byPanchayat] = await pool.query(
            `SELECT lb.name AS panchayat, COUNT(*) AS total,
                    SUM(c.status = 'resolved') AS resolved,
                    SUM(c.status != 'resolved' AND c.created_at < NOW() - INTERVAL 72 HOUR) AS overdue
             FROM contact_enquiries c
             LEFT JOIN local_bodies lb ON lb.id = c.panchayat_id
             WHERE c.panchayat_id IS NOT NULL
             GROUP BY c.panchayat_id, lb.name
             ORDER BY total DESC
             LIMIT 10`
        );

        return successResponse(res, {
            data: {
                total: Number(totals.total),
                new: Number(totals.new_count),
                read: Number(totals.read_count),
                resolved: Number(totals.resolved_count),
                overdue: Number(totals.overdue_count || 0),
                avg_resolution_hours: resolution.avg_hours ? Number(resolution.avg_hours) : null,
                resolution_rate: totals.total > 0
                    ? Math.round((Number(totals.resolved_count) / Number(totals.total)) * 100)
                    : 0,
                byCategory,
                weeklyTrend,
                byPanchayat,
            }
        }, 'Stats fetched.');
    } catch (err) {
        console.error('[getEnquiryStats]', err);
        return errorResponse(res, 'Failed to fetch stats.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact/constituent?email=  — Constituent Profile
// ─────────────────────────────────────────────────────────────
export const getConstituentProfile = async (req, res) => {
    const { email } = req.query;
    if (!email?.trim()) return errorResponse(res, 'Email is required.', 400);

    try {
        // All enquiries from this email
        const [enquiries] = await pool.query(
            `SELECT c.id, c.category, c.subject, c.status, c.created_at, lb.name AS panchayat_name
             FROM contact_enquiries c
             LEFT JOIN local_bodies lb ON lb.id = c.panchayat_id
             WHERE c.email = ?
             ORDER BY c.created_at DESC`,
            [email.trim()]
        );

        if (enquiries.length === 0) {
            return successResponse(res, { data: { enquiries: [], stats: null } }, 'No profile found.');
        }

        // Stats summary
        const total = enquiries.length;
        const resolved = enquiries.filter(e => e.status === 'resolved').length;
        const open = enquiries.filter(e => e.status !== 'resolved').length;
        const categories = [...new Set(enquiries.map(e => e.category))];
        const firstSeen = enquiries[enquiries.length - 1].created_at;
        const lastSeen = enquiries[0].created_at;

        // Get the person's name from most recent
        const [[person]] = await pool.query(
            `SELECT full_name, mobile FROM contact_enquiries WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
            [email.trim()]
        );

        return successResponse(res, {
            data: {
                enquiries,
                stats: {
                    full_name: person.full_name,
                    mobile: person.mobile,
                    email: email.trim(),
                    total,
                    resolved,
                    open,
                    categories,
                    first_seen: firstSeen,
                    last_seen: lastSeen,
                }
            }
        }, 'Constituent profile fetched.');
    } catch (err) {
        console.error('[getConstituentProfile]', err);
        return errorResponse(res, 'Failed to fetch constituent profile.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/contact/:id/notes  — Admin: get notes for enquiry
// ─────────────────────────────────────────────────────────────
export const getEnquiryNotes = async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM enquiry_notes WHERE enquiry_id = ? ORDER BY created_at ASC`,
            [req.params.id]
        );
        return successResponse(res, { data: rows }, 'Notes fetched.');
    } catch (err) {
        console.error('[getEnquiryNotes]', err);
        return successResponse(res, { data: [] }, 'Notes fetched.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/contact/:id/notes  — Admin: add a note
// ─────────────────────────────────────────────────────────────
export const addEnquiryNote = async (req, res) => {
    const { note } = req.body;
    if (!note?.trim()) return errorResponse(res, 'Note content is required.', 400);

    try {
        // Verify the enquiry exists
        const [[enq]] = await pool.query('SELECT id FROM contact_enquiries WHERE id = ?', [req.params.id]);
        if (!enq) return errorResponse(res, 'Enquiry not found.', 404);

        const [result] = await pool.query(
            'INSERT INTO enquiry_notes (enquiry_id, note) VALUES (?, ?)',
            [req.params.id, note.trim()]
        );
        return successResponse(res, { id: result.insertId }, 'Note added.', 201);
    } catch (err) {
        console.error('[addEnquiryNote]', err);
        return errorResponse(res, 'Failed to add note.');
    }
};

