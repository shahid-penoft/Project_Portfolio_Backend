import pool              from '../configs/db.js';
import transporter       from '../configs/mailer.js';
import buildLetterHtmlTemplate from '../utils/letterHtmlTemplate.js';
import generateLetterPdf       from '../utils/letterPdfTemplate.js';
import { logActivity as auditLog } from './teamsLogController.js';
import { broadcastNotification }   from '../utils/notificationHelper.js';

// ─── Helpers ──────────────────────────────────────────────────

/** Write an activity log row */
const logActivity = async (letterId, text, authorId = null, authorName = null) => {
    await pool.query(
        'INSERT INTO mla_letter_activity (letter_id, text, author_id, author_name) VALUES (?,?,?,?)',
        [letterId, text, authorId, authorName]
    );
};

/** Auto-generate letter_id: KTML/{YEAR}/{SEQ:04} */
const generateLetterId = async () => {
    const year = new Date().getFullYear();
    const [[{ maxSeq }]] = await pool.query(
        'SELECT COALESCE(MAX(year_seq), 0) AS maxSeq FROM mla_letters WHERE YEAR(prepared_on) = ?',
        [year]
    );
    const nextSeq = maxSeq + 1;
    return { letterId: `KTML/${year}/${String(nextSeq).padStart(4, '0')}`, yearSeq: nextSeq };
};

/** Fetch a full letter with follow-ups and activity */
const fetchFullLetter = async (id) => {
    const [[letter]] = await pool.query(`
        SELECT l.*,
               au.full_name AS prepared_by_name,
               au.email     AS prepared_by_email
        FROM mla_letters l
        LEFT JOIN admin_users au ON l.prepared_by_user_id = au.id
        WHERE l.id = ?
    `, [id]);

    if (!letter) return null;

    // Parse JSON tags
    if (typeof letter.tags === 'string') {
        try { letter.tags = JSON.parse(letter.tags); } catch { letter.tags = []; }
    }

    const [followups] = await pool.query(`
        SELECT f.*, au.full_name AS assigned_to_name
        FROM mla_letter_followups f
        LEFT JOIN admin_users au ON f.assigned_to_user_id = au.id
        WHERE f.letter_id = ? ORDER BY f.date ASC
    `, [id]);

    const [activity] = await pool.query(
        'SELECT * FROM mla_letter_activity WHERE letter_id = ? ORDER BY time DESC',
        [id]
    );

    const [attachments] = await pool.query(
        'SELECT * FROM mla_letter_attachments WHERE letter_id = ? ORDER BY uploaded_at ASC',
        [id]
    );

    return { ...letter, followups, activity, attachments };
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/letters
// Query: page, limit, search, status, type, priority, sort
// ─────────────────────────────────────────────────────────────
export const getAllLetters = async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, type, priority, sort } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const baseConditions = [];
        const baseParams     = [];

        if (type)     { baseConditions.push('l.type = ?');     baseParams.push(type); }
        if (priority) { baseConditions.push('l.priority = ?'); baseParams.push(priority); }
        if (req.query.category === 'recommendation') {
            baseConditions.push("l.type = 'Recommendation'");
        } else if (req.query.category === 'general') {
            baseConditions.push("l.type != 'Recommendation'");
        }
        if (req.query.trashed === 'true') {
            baseConditions.push('l.trashed_at IS NOT NULL');
        } else {
            baseConditions.push('l.trashed_at IS NULL');
        }
        if (search) {
            baseConditions.push('(l.subject LIKE ? OR l.letter_id LIKE ? OR l.recipient_name LIKE ? OR l.recipient_org LIKE ?)');
            const q = `%${search}%`;
            baseParams.push(q, q, q, q);
        }

        const conditions = [...baseConditions];
        const params     = [...baseParams];

        if (status) { 
            conditions.push('l.status = ?');   
            params.push(status); 
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : '';

        const sortMap = {
            'newest':  'l.prepared_on DESC',
            'oldest':  'l.prepared_on ASC',
            'subjectAZ': 'l.subject ASC',
            'subjectZA': 'l.subject DESC',
        };
        const orderBy = sortMap[sort] || 'l.prepared_on DESC';

        // 1. Get total for pagination (respects ALL filters including status)
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM mla_letters l ${where}`, params
        );

        // 2. Get stats grouped by status (respects all filters EXCEPT status)
        const [statsRows] = await pool.query(
            `SELECT status, COUNT(*) as count FROM mla_letters l ${baseWhere} GROUP BY status`, 
            baseParams
        );
        const stats = { all: 0, Draft: 0, Sent: 0, Delivered: 0, Archived: 0 };
        statsRows.forEach(row => {
            if (stats[row.status] !== undefined) stats[row.status] = row.count;
            stats.all += row.count;
        });

        // 3. Get paginated data
        const [rows] = await pool.query(`
            SELECT l.id, l.letter_id, l.subject, l.type, l.priority, l.status,
                   l.response_status, l.recipient_name, l.recipient_org,
                   l.reference, l.prepared_on, l.sent_on, l.trashed_at,
                   au.full_name AS prepared_by_name,
                   au2.full_name AS deleted_by_name
            FROM mla_letters l
            LEFT JOIN admin_users au ON l.prepared_by_user_id = au.id
            LEFT JOIN admin_users au2 ON l.trashed_by_id = au2.id
            ${where}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        res.json({
            success: true,
            data: rows,
            stats,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        console.error('[getAllLetters]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch letters.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/letters/next-id  (for ComposeLetterPage)
// ─────────────────────────────────────────────────────────────
export const getNextLetterId = async (req, res) => {
    try {
        const { letterId } = await generateLetterId();
        res.json({ success: true, data: { letterId } });
    } catch (err) {
        console.error('[getNextLetterId]', err);
        res.status(500).json({ success: false, message: 'Failed to generate letter ID.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/letters/:id
// ─────────────────────────────────────────────────────────────
export const getLetterById = async (req, res) => {
    try {
        const letter = await fetchFullLetter(req.params.id);
        if (!letter) return res.status(404).json({ success: false, message: 'Letter not found.' });
        res.json({ success: true, data: letter });
    } catch (err) {
        console.error('[getLetterById]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch letter.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/admin/letters
// ─────────────────────────────────────────────────────────────
export const createLetter = async (req, res) => {
    try {
        const {
            subject, type, priority, status,
            recipient_name, recipient_designation, recipient_org, recipient_address, recipient_email,
            reference, salutation, closing, body, tags,
        } = req.body;

        const remarks = req.body.remarks !== undefined
            ? req.body.remarks
            : (req.body.notes !== undefined ? req.body.notes : (req.body.internal_note !== undefined ? req.body.internal_note : null));

        // Validation
        if (!subject?.trim())        return res.status(400).json({ success: false, message: 'subject is required.' });
        if (!type)                   return res.status(400).json({ success: false, message: 'type is required.' });
        if (!recipient_name?.trim()) return res.status(400).json({ success: false, message: 'recipient_name is required.' });

        const validTypes = ['Request','Recommendation','Appreciation','Grievance Forwarding',
                            'NOC / Certificate','Circular','Notice','Official Communication','Other'];
        if (!validTypes.includes(type)) return res.status(400).json({ success: false, message: 'Invalid letter type.' });

        const { letterId, yearSeq } = await generateLetterId();
        const tagsJson = tags ? JSON.stringify(Array.isArray(tags) ? tags : []) : null;

        const sentOn = (status === 'Sent') ? new Date() : null;

        const [result] = await pool.query(`
            INSERT INTO mla_letters
              (letter_id, subject, type, priority, status,
               recipient_name, recipient_designation, recipient_org, recipient_address, recipient_email,
               reference, salutation, closing, body, tags, remarks,
               prepared_by_user_id, sent_on, year_seq)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            letterId,
            subject.trim(),
            type,
            priority || 'Normal',
            status || 'Draft',
            recipient_name.trim(),
            recipient_designation || null,
            recipient_org || null,
            recipient_address || null,
            recipient_email || null,
            reference || null,
            salutation || 'Respected Sir,',
            closing || 'Yours faithfully,',
            body || null,
            tagsJson,
            remarks || null,
            req.admin?.id || null,
            sentOn,
            yearSeq,
        ]);

        await logActivity(result.insertId, `Letter "${letterId}" created.`, req.admin?.id, req.admin?.full_name);
        auditLog(req, { action: 'Created', module: 'Letters', details: `Letter "${letterId}" created — ${subject?.trim()}`, resource: `letters/${result.insertId}`, severity: 'info' });

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                let fileType = 'attachment';
                if (file.fieldname.startsWith('audioNotes')) {
                    fileType = 'audio_note';
                }
                const fileUrl = file.location || `/uploads/letters/attachments/${file.filename}`;
                await pool.query(
                    'INSERT INTO mla_letter_attachments (letter_id, file_name, file_url, file_type) VALUES (?,?,?,?)',
                    [result.insertId, file.originalname, fileUrl, fileType]
                );
            }
        }

        const letter = await fetchFullLetter(result.insertId);
        res.status(201).json({ success: true, data: letter });
    } catch (err) {
        console.error('[createLetter]', err);
        res.status(500).json({ success: false, message: 'Failed to create letter.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/admin/letters/:id
// ─────────────────────────────────────────────────────────────
export const updateLetter = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            subject, type, priority, status,
            recipient_name, recipient_designation, recipient_org, recipient_address, recipient_email,
            reference, salutation, closing, body, tags,
        } = req.body;

        const remarks = req.body.remarks !== undefined
            ? req.body.remarks
            : (req.body.notes !== undefined ? req.body.notes : (req.body.internal_note !== undefined ? req.body.internal_note : undefined));

        // Check exists
        const [[existing]] = await pool.query('SELECT id, status FROM mla_letters WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ success: false, message: 'Letter not found.' });

        const tagsJson = tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : []) : undefined;
        const sentOn   = (status === 'Sent' && existing.status !== 'Sent') ? new Date() : undefined;

        const setClauses = [];
        const params     = [];

        const addField = (col, val) => { if (val !== undefined) { setClauses.push(`${col} = ?`); params.push(val); } };

        addField('subject',               subject?.trim());
        addField('type',                  type);
        addField('priority',              priority);
        addField('status',                status);
        addField('recipient_name',        recipient_name?.trim());
        addField('recipient_designation', recipient_designation);
        addField('recipient_org',         recipient_org);
        addField('recipient_address',     recipient_address);
        addField('recipient_email',       recipient_email);
        addField('reference',             reference);
        addField('salutation',            salutation);
        addField('closing',               closing);
        addField('body',                  body);
        addField('tags',                  tagsJson);
        addField('remarks',               remarks);
        if (sentOn !== undefined) { setClauses.push('sent_on = ?'); params.push(sentOn); }

        if (setClauses.length === 0) return res.status(400).json({ success: false, message: 'No fields to update.' });

        params.push(id);
        await pool.query(`UPDATE mla_letters SET ${setClauses.join(', ')} WHERE id = ?`, params);
        await logActivity(id, `Letter updated by ${req.admin?.full_name || 'admin'}.`, req.admin?.id, req.admin?.full_name);
        auditLog(req, { action: 'Updated', module: 'Letters', details: `Letter ID ${id} updated by ${req.admin?.full_name || 'admin'}`, resource: `letters/${id}`, severity: 'success' });

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                let fileType = 'attachment';
                if (file.fieldname.startsWith('audioNotes')) {
                    fileType = 'audio_note';
                }
                const fileUrl = file.location || `/uploads/letters/attachments/${file.filename}`;
                await pool.query(
                    'INSERT INTO mla_letter_attachments (letter_id, file_name, file_url, file_type) VALUES (?,?,?,?)',
                    [id, file.originalname, fileUrl, fileType]
                );
            }
        }

        const letter = await fetchFullLetter(id);
        res.json({ success: true, data: letter });
    } catch (err) {
        console.error('[updateLetter]', err);
        res.status(500).json({ success: false, message: 'Failed to update letter.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/letters/:id
// ─────────────────────────────────────────────────────────────
export const deleteLetter = async (req, res) => {
    return trashLetter(req, res);
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/letters/:id/trash  (soft-delete)
// ─────────────────────────────────────────────────────────────
export const trashLetter = async (req, res) => {
    try {
        const { id } = req.params;
        const deletedById = req.admin?.id || null;
        const [result] = await pool.query(
            `UPDATE mla_letters SET status = 'Archived', trashed_at = NOW(), trashed_by_id = ? WHERE id = ?`,
            [deletedById, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Letter not found.' });
        await logActivity(id, `Letter moved to trash by ${req.admin?.full_name || 'admin'}.`, req.admin?.id, req.admin?.full_name);
        auditLog(req, { action: 'Trashed', module: 'Letters', details: `Letter ID ${id} moved to trash`, resource: `letters/${id}`, severity: 'neutral' });
        res.json({ success: true, message: 'Letter moved to trash.' });
    } catch (err) {
        console.error('[trashLetter]', err);
        res.status(500).json({ success: false, message: 'Failed to trash letter.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/letters/:id/restore
// ─────────────────────────────────────────────────────────────
export const restoreLetter = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query(
            `UPDATE mla_letters SET status = 'Draft', trashed_at = NULL, trashed_by_id = NULL WHERE id = ? AND trashed_at IS NOT NULL`,
            [id]
        );
        if (result.affectedRows === 0)
            return res.status(404).json({ success: false, message: 'Trashed letter not found.' });
        await logActivity(id, `Letter restored from trash by ${req.admin?.full_name || 'admin'}.`, req.admin?.id, req.admin?.full_name);
        auditLog(req, { action: 'Restored', module: 'Letters', details: `Letter ID ${id} restored from trash`, resource: `letters/${id}`, severity: 'info' });
        res.json({ success: true, message: 'Letter restored successfully.' });
    } catch (err) {
        console.error('[restoreLetter]', err);
        res.status(500).json({ success: false, message: 'Failed to restore letter.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/letters/:id/permanent
// ─────────────────────────────────────────────────────────────
export const permanentDeleteLetter = async (req, res) => {
    try {
        const { id } = req.params;

        const [[letter]] = await pool.query(
            'SELECT id, letter_id FROM mla_letters WHERE id = ? AND trashed_at IS NOT NULL', [id]
        );
        if (!letter) return res.status(404).json({ success: false, message: 'Letter not found in trash.' });

        await pool.query('DELETE FROM mla_letters WHERE id = ?', [id]);

        auditLog(req, { action: 'Deleted', module: 'Letters', details: `Letter ${letter.letter_id} permanently deleted`, resource: `letters/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Letter permanently deleted.' });
    } catch (err) {
        console.error('[permanentDeleteLetter]', err);
        res.status(500).json({ success: false, message: 'Failed to permanently delete letter.' });
    }
};


// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/letters/:id/status
// ─────────────────────────────────────────────────────────────
export const patchLetterStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const validStatuses = ['Draft', 'Sent', 'Delivered', 'Archived'];
        if (!status || !validStatuses.includes(status))
            return res.status(400).json({ success: false, message: 'Valid status is required.' });

        const sentOn = (status === 'Sent') ? ', sent_on = NOW()' : '';
        const [result] = await pool.query(
            `UPDATE mla_letters SET status = ? ${sentOn} WHERE id = ?`, [status, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Letter not found.' });

        await logActivity(id, `Status changed to "${status}" by ${req.admin?.full_name || 'admin'}.`, req.admin?.id, req.admin?.full_name);
        const auditAction = status === 'Archived' ? 'Archived' : 'Updated';
        auditLog(req, { action: auditAction, module: 'Letters', details: `Letter ID ${id} status changed to "${status}"`, resource: `letters/${id}`, severity: status === 'Archived' ? 'neutral' : 'info' });
        res.json({ success: true, message: `Status updated to ${status}.` });
    } catch (err) {
        console.error('[patchLetterStatus]', err);
        res.status(500).json({ success: false, message: 'Failed to update status.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/letters/:id/response-status
// ─────────────────────────────────────────────────────────────
export const patchResponseStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { response_status } = req.body;
        const valid = ['Pending', 'Acknowledged', 'Response Received', 'No Response Required'];
        if (!response_status || !valid.includes(response_status))
            return res.status(400).json({ success: false, message: 'Valid response_status is required.' });

        const [result] = await pool.query(
            'UPDATE mla_letters SET response_status = ? WHERE id = ?', [response_status, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Letter not found.' });

        await logActivity(id, `Response status set to "${response_status}".`, req.admin?.id, req.admin?.full_name);
        res.json({ success: true, message: `Response status updated.` });
    } catch (err) {
        console.error('[patchResponseStatus]', err);
        res.status(500).json({ success: false, message: 'Failed to update response status.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/admin/letters/:id/send-email
// ─────────────────────────────────────────────────────────────
export const sendLetterEmail = async (req, res) => {
    try {
        const { id } = req.params;
        const { recipient_email, cc, send_as_pdf_attachment, message } = req.body;

        // Validate email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!recipient_email || !emailRegex.test(recipient_email))
            return res.status(400).json({ success: false, message: 'Valid recipient_email is required.' });

        const letter = await fetchFullLetter(id);
        if (!letter) return res.status(404).json({ success: false, message: 'Letter not found.' });
        if (letter.status === 'Draft')
            return res.status(400).json({ success: false, message: 'Cannot send a Draft letter via email. Please send it first.' });

        const [[setting]] = await pool.query('SELECT setting_value FROM site_settings WHERE setting_key = ?', ['mla_letter_template']);
        let templateConfig = null;
        if (setting && setting.setting_value) {
            try { templateConfig = JSON.parse(setting.setting_value); } catch(e) {}
        }

        const letterHtml = buildLetterHtmlTemplate(letter, templateConfig);
        const htmlBody = message
            ? `<div style="font-family:Georgia,'Palatino Linotype','Book Antiqua',serif;font-size:14px;color:#374151;line-height:1.8;margin-bottom:24px;">${message.replace(/\n/g, '<br/>')}</div><hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>${letterHtml}`
            : letterHtml;
        const mailOpts  = {
            from:    `"MLA Office Kothamangalam" <${process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER}>`,
            to:      recipient_email,
            cc:      Array.isArray(cc) ? cc.join(', ') : (cc || ''),
            subject: `[${letter.letter_id}] ${letter.subject}`,
            html:    htmlBody,
            attachments: [],
        };

        if (send_as_pdf_attachment) {
            const pdfBuffer = await generateLetterPdf(letter, templateConfig);
            mailOpts.attachments.push({
                filename:    `${letter.letter_id}.pdf`,
                content:     pdfBuffer,
                contentType: 'application/pdf',
            });
        }

        await transporter.sendMail(mailOpts);
        await logActivity(id, `Letter emailed to ${recipient_email} by ${req.admin?.full_name || 'admin'}.`, req.admin?.id, req.admin?.full_name);

        res.json({ success: true, message: `Letter emailed to ${recipient_email} successfully.` });
    } catch (err) {
        console.error('[sendLetterEmail]', err);
        res.status(500).json({ success: false, message: 'Failed to send email. Please check SMTP settings.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/letters/:id/pdf  (download)
// ─────────────────────────────────────────────────────────────
export const downloadLetterPdf = async (req, res) => {
    try {
        const letter = await fetchFullLetter(req.params.id);
        if (!letter) return res.status(404).json({ success: false, message: 'Letter not found.' });

        const [[setting]] = await pool.query('SELECT setting_value FROM site_settings WHERE setting_key = ?', ['mla_letter_template']);
        let templateConfig = null;
        if (setting && setting.setting_value) {
            try { templateConfig = JSON.parse(setting.setting_value); } catch(e) {}
        }

        const pdfBuffer = await generateLetterPdf(letter, templateConfig);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${letter.letter_id}.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('[downloadLetterPdf]', err);
        res.status(500).json({ success: false, message: 'Failed to generate PDF.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/letters/:id/activity
// ─────────────────────────────────────────────────────────────
export const getLetterActivity = async (req, res) => {
    try {
        const [activity] = await pool.query(
            'SELECT * FROM mla_letter_activity WHERE letter_id = ? ORDER BY time DESC',
            [req.params.id]
        );
        res.json({ success: true, data: activity });
    } catch (err) {
        console.error('[getLetterActivity]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch activity.' });
    }
};

// ─── FOLLOW-UPS ───────────────────────────────────────────────

// GET /api/admin/letters/:id/followups
export const getFollowups = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT f.*, au.full_name AS assigned_to_name
            FROM mla_letter_followups f
            LEFT JOIN admin_users au ON f.assigned_to_user_id = au.id
            WHERE f.letter_id = ? ORDER BY f.date ASC
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[getFollowups]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch follow-ups.' });
    }
};

// POST /api/admin/letters/:id/followups
export const createFollowup = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, date, notes, assigned_to_user_id } = req.body;

        if (!type) return res.status(400).json({ success: false, message: 'type is required.' });
        if (!date) return res.status(400).json({ success: false, message: 'date is required.' });

        const assigneeId = assigned_to_user_id || req.admin?.id || null;

        const [result] = await pool.query(
            'INSERT INTO mla_letter_followups (letter_id, type, date, notes, assigned_to_user_id) VALUES (?,?,?,?,?)',
            [id, type, date, notes || null, assigneeId]
        );

        await logActivity(id, `Follow-up (${type}) scheduled for ${date}.`, req.admin?.id, req.admin?.full_name);

        const [[followup]] = await pool.query(`
            SELECT f.*, au.full_name AS assigned_to_name
            FROM mla_letter_followups f
            LEFT JOIN admin_users au ON f.assigned_to_user_id = au.id
            WHERE f.id = ?
        `, [result.insertId]);

        res.status(201).json({ success: true, data: followup });
    } catch (err) {
        console.error('[createFollowup]', err);
        res.status(500).json({ success: false, message: 'Failed to create follow-up.' });
    }
};

// PATCH /api/admin/letters/:id/followups/:fid
export const updateFollowup = async (req, res) => {
    try {
        const { id, fid } = req.params;
        const { type, date, notes, status, assigned_to_user_id } = req.body;

        const [[existing]] = await pool.query(
            'SELECT * FROM mla_letter_followups WHERE id = ? AND letter_id = ?', [fid, id]
        );
        if (!existing) return res.status(404).json({ success: false, message: 'Follow-up not found.' });

        await pool.query(`
            UPDATE mla_letter_followups SET
              type                = COALESCE(?, type),
              date                = COALESCE(?, date),
              notes               = COALESCE(?, notes),
              status              = COALESCE(?, status),
              assigned_to_user_id = COALESCE(?, assigned_to_user_id)
            WHERE id = ?
        `, [type, date, notes, status, assigned_to_user_id, fid]);

        if (status === 'Completed') {
            await logActivity(id, `Follow-up (${existing.type}) marked as Completed.`, req.admin?.id, req.admin?.full_name);
        }

        const [[updated]] = await pool.query(`
            SELECT f.*, au.full_name AS assigned_to_name
            FROM mla_letter_followups f
            LEFT JOIN admin_users au ON f.assigned_to_user_id = au.id
            WHERE f.id = ?
        `, [fid]);

        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('[updateFollowup]', err);
        res.status(500).json({ success: false, message: 'Failed to update follow-up.' });
    }
};

// DELETE /api/admin/letters/:id/followups/:fid
export const deleteFollowup = async (req, res) => {
    try {
        const { id, fid } = req.params;
        const [result] = await pool.query(
            'DELETE FROM mla_letter_followups WHERE id = ? AND letter_id = ?', [fid, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Follow-up not found.' });
        res.json({ success: true, message: 'Follow-up deleted.' });
    } catch (err) {
        console.error('[deleteFollowup]', err);
        res.status(500).json({ success: false, message: 'Failed to delete follow-up.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/letters/public-submit (Citizen Public Submission)
// ─────────────────────────────────────────────────────────────
export const publicSubmitLetter = async (req, res) => {
    try {
        const {
            subject, title, type = 'Recommendation', priority = 'Normal',
            recipient_name, recipient_org, recipient_designation, recipient_address, recipient_email,
            body, description, salutation, closing,
            applicant_name, applicant_phone, applicant_email,
            local_body_id, ward_id, local_body_name, ward_name,
        } = req.body;

        const letterSubject = (subject || title || '').trim();
        if (!letterSubject) {
            return res.status(400).json({ success: false, message: 'Subject/title is required.' });
        }

        const applicantName = (applicant_name || '').trim();
        const applicantPhone = (applicant_phone || '').trim();
        const applicantEmail = (applicant_email || '').trim();

        if (!applicantName) {
            return res.status(400).json({ success: false, message: 'Applicant name is required.' });
        }
        if (!applicantPhone) {
            return res.status(400).json({ success: false, message: 'Applicant phone number is required.' });
        }

        const { letterId, yearSeq } = await generateLetterId();

        const recipientName = (recipient_name || '').trim() || 'To Whom It May Concern';
        const letterBody = (body || description || '').trim() || null;

        const applicantInfo = {
            applicant_name: applicantName,
            applicant_phone: applicantPhone,
            applicant_email: applicantEmail || null,
            local_body_id: local_body_id ? parseInt(local_body_id, 10) : null,
            ward_id: ward_id ? parseInt(ward_id, 10) : null,
            local_body_name: local_body_name || null,
            ward_name: ward_name || null,
            submitted_at: new Date().toISOString(),
        };

        const remarks = JSON.stringify(applicantInfo);
        const reference = `Applicant: ${applicantName} (${applicantPhone})`;

        const [result] = await pool.query(`
            INSERT INTO mla_letters
              (letter_id, subject, type, priority, status, response_status,
               recipient_name, recipient_designation, recipient_org, recipient_address, recipient_email,
               reference, salutation, closing, body, remarks,
               prepared_by_user_id, sent_on, year_seq)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            letterId,
            letterSubject,
            type === 'Recommendation' ? 'Recommendation' : (type || 'Recommendation'),
            priority || 'Normal',
            'Draft',
            'Pending',
            recipientName,
            recipient_designation || null,
            recipient_org || null,
            recipient_address || null,
            recipient_email || null,
            reference,
            salutation || 'Respected Sir,',
            closing || 'Yours faithfully,',
            letterBody,
            remarks,
            null,
            null,
            yearSeq,
        ]);

        const newId = result.insertId;

        // Log initial activity
        await logActivity(newId, `Public request for Recommendation Letter submitted by ${applicantName} (${applicantPhone}).`, null, applicantName);

        // Notify all admins about new public recommendation request
        broadcastNotification({
            title: `New Recommendation Request ${letterId}`,
            message: `"${letterSubject}" requested by ${applicantName}.`,
            type: 'alert',
            module: 'Letters',
            record_id: newId,
            record_ref: letterId,
            link_path: `/admin/dashboard/letters/${newId}`,
        });

        // Process attachments / audio notes
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                let fileType = 'attachment';
                if (file.fieldname && file.fieldname.startsWith('audioNotes')) {
                    fileType = 'audio_note';
                }
                const fileUrl = file.location || file.path || `/uploads/letters/attachments/${file.filename}`;
                await pool.query(
                    'INSERT INTO mla_letter_attachments (letter_id, file_name, file_url, file_type) VALUES (?,?,?,?)',
                    [newId, file.originalname, fileUrl, fileType]
                );
            }
        }

        return res.status(201).json({
            success: true,
            message: 'Recommendation letter request submitted successfully.',
            data: {
                id: newId,
                reference_no: letterId,
                letter_id: letterId,
            },
        });
    } catch (err) {
        console.error('[publicSubmitLetter] error:', err);
        return res.status(500).json({ success: false, message: 'Failed to submit recommendation letter request.' });
    }
};
