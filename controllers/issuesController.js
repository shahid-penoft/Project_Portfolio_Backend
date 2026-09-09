import pool from '../configs/db.js';
import { getDropdownDefault } from './mlaDropdownsController.js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logActivity as auditLog } from './teamsLogController.js';
import { sendSMSSafe } from '../services/smsService.js';
import { submissionConfirmationSMS, followUpUpdateSMS } from '../services/smsTemplates.js';
import { createNotification, broadcastNotification } from '../utils/notificationHelper.js';
import { notifyUser } from '../utils/userNotificationHelper.js';
import { sendNotificationEmail } from '../utils/email.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});
const s3Bucket = process.env.AWS_S3_BUCKET || 'my-portfolio-bucket';

// Helper: extract S3 key from a full URL
const keyFromUrl = (url) => {
    try { return new URL(url).pathname.replace(/^\//, ''); } catch { return null; }
};

// Helper: delete an S3 object (non-fatal)
const deleteS3Object = async (url) => {
    const key = keyFromUrl(url);
    if (!key) return;
    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
    } catch (err) {
        console.warn('[S3 delete warn]', key, err.message);
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/issues/categories
// ─────────────────────────────────────────────────────────────
export const getCategories = async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM complaint_categories ORDER BY created_at ASC');
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[getCategories]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch categories.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues/categories
// ─────────────────────────────────────────────────────────────
export const createCategory = async (req, res) => {
    try {
        const { name, status } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'name is required.' });

        const [result] = await pool.query(
            'INSERT INTO complaint_categories (name, status) VALUES (?, ?)',
            [name, status || 'Active']
        );
        const [[newCategory]] = await pool.query('SELECT * FROM complaint_categories WHERE id = ?', [result.insertId]);
        res.status(201).json({ success: true, data: newCategory });
    } catch (err) {
        console.error('[createCategory]', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Category name already exists.' });
        }
        res.status(500).json({ success: false, message: 'Failed to create category.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/issues/categories/:id
// ─────────────────────────────────────────────────────────────
export const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status } = req.body;

        const [result] = await pool.query(
            'UPDATE complaint_categories SET name = COALESCE(?, name), status = COALESCE(?, status) WHERE id = ?',
            [name, status, id]
        );

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Category not found.' });
        const [[updated]] = await pool.query('SELECT * FROM complaint_categories WHERE id = ?', [id]);
        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('[updateCategory]', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Category name already exists.' });
        }
        res.status(500).json({ success: false, message: 'Failed to update category.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/categories/:id
// ─────────────────────────────────────────────────────────────
export const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query('DELETE FROM complaint_categories WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Category not found.' });
        res.json({ success: true, message: 'Category deleted successfully.' });
    } catch (err) {
        console.error('[deleteCategory]', err);
        res.status(500).json({ success: false, message: 'Failed to delete category.' });
    }
};

// Helper: log an activity entry
const logActivity = async (issueId, text, adminUserId = null) => {
    await pool.query(
        'INSERT INTO issue_activity (issue_id, text, admin_user_id) VALUES (?, ?, ?)',
        [issueId, text, adminUserId]
    );
};

// Helper: generate reference number  P-NNN
const generateReferenceNo = async () => {
    const [[{ maxSeq }]] = await pool.query('SELECT COALESCE(MAX(CAST(SUBSTRING(reference_no, 3) AS UNSIGNED)), 0) as maxSeq FROM issues WHERE reference_no LIKE "P-%"');
    const seq = String(parseInt(maxSeq, 10) + 1).padStart(3, '0');
    return `P-${seq}`;
};

export const getNextId = async (req, res) => {
    try {
        const nextId = await generateReferenceNo();
        res.json({ success: true, data: nextId });
    } catch (err) {
        console.error('[getNextId]', err);
        res.status(500).json({ success: false, message: 'Failed to generate next ID.' });
    }
};

// Helper: fetch full issue with all sub-resources
const fetchFullIssue = async (id) => {
    const cleanId = (typeof id === 'string' && id.startsWith('P-')) ? id.replace(/^P-/, '') : id;

    const [[issue]] = await pool.query(`
        SELECT c.*,
               c.department AS department_name,
               lb.name AS local_body_name,
               lbw.ward_no,
               lbw.place_name AS ward_place_name,
               au.full_name   AS filed_by_admin_name,
               au_updater.full_name AS updated_by_admin_name
        FROM issues c
        LEFT JOIN local_bodies     lb  ON c.local_body_id     = lb.id
        LEFT JOIN local_body_wards lbw ON c.ward_id           = lbw.id
        LEFT JOIN admin_users      au  ON c.filed_by_admin_id = au.id
        LEFT JOIN admin_users au_updater ON c.updated_by_admin_id = au_updater.id
        WHERE c.id = ? OR c.reference_no = ? OR c.id = ?
    `, [cleanId, id, id]);

    if (!issue) return null;

    const realId = issue.id;

    const [updates] = await pool.query(`
        SELECT u.*, au.full_name AS author_name, au.full_name AS admin_name
        FROM issue_updates u
        LEFT JOIN admin_users au ON u.admin_user_id = au.id
        WHERE u.issue_id = ? 
        ORDER BY u.created_at ASC
    `, [realId]);

    const [commLogs] = await pool.query(
        `SELECT cl.id, 
                'Communication' AS type, 
                CONCAT(cl.channel, ' Sent') AS title, 
                cl.channel,
                cl.recipient,
                cl.update_id,
                cl.message AS note, 
                cl.created_at, 
                'communications_logs' as _source,
                cl.admin_user_id,
                au.full_name AS sent_by_name,
                au.full_name AS author_name
         FROM communications_logs cl
         LEFT JOIN admin_users au ON cl.admin_user_id = au.id
         WHERE cl.entity_type = 'Issue' AND (
             cl.entity_id COLLATE utf8mb4_unicode_ci = ? 
             OR cl.entity_id COLLATE utf8mb4_unicode_ci = ?
         )
         ORDER BY cl.created_at ASC`, 
        [String(realId), String(issue.reference_no || realId)]
    );
    const combinedUpdatesRaw = [...updates, ...commLogs].sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || ((Number(b.id) || 0) - (Number(a.id) || 0)));

    const [allMedia]       = await pool.query('SELECT * FROM issue_media       WHERE issue_id = ? ORDER BY created_at ASC', [realId]);
    const [allAttachments] = await pool.query('SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY created_at ASC', [realId]);

    const mappedUpdates = combinedUpdatesRaw.map(u => ({
        ...u,
        gallery: allMedia
            .filter(m => m.update_id === u.id)
            .map(m => ({
                id:   m.id,
                url:  m.file_url,
                type: m.media_type,
                name: m.caption || m.file_url.split('/').pop(),
                size: m.file_size_kb != null ? Number(m.file_size_kb) * 1024 : null,
            })),
        attachments: allAttachments
            .filter(a => a.update_id === u.id)
            .map(a => ({
                id:   a.id,
                name: a.file_name,
                size: a.file_size_kb ? `${(a.file_size_kb / 1024).toFixed(1)} MB` : 'Unknown',
                type: a.file_type,
                url:  a.file_url,
            })),
    }));
    const media       = allMedia;
    const attachments = allAttachments;
    const [team]        = await pool.query(`
        SELECT ct.id, ct.role_label, ct.created_at,
               au.id as admin_user_id, au.full_name as name, au.email
        FROM issue_team ct
        JOIN admin_users au ON ct.admin_user_id = au.id
        WHERE ct.issue_id = ?
        ORDER BY ct.created_at ASC
    `, [realId]);
    const [activity]    = await pool.query(`
        SELECT ca.*, COALESCE(au.full_name, i.submitter_name, 'Citizen') as author_name 
        FROM issue_activity ca
        LEFT JOIN admin_users au ON ca.admin_user_id = au.id
        LEFT JOIN issues i ON ca.issue_id = i.id
        WHERE ca.issue_id = ? 
        ORDER BY ca.created_at DESC
    `, [realId]);

    return { ...issue, remarks: issue.internal_note || '', updates: mappedUpdates, media, attachments, team, activity };
};

// ─────────────────────────────────────────────────────────────
// GET /api/issues
// Query: status, category, priority, search, page, limit, trash
// ─────────────────────────────────────────────────────────────

// Helper: convert "3 days", "2 Month", "1 Year" etc. → integer days
const parseDayLabel = (label) => {
    if (!label) return null;
    const s = String(label).replace(/^(last\s+|never.*)/i, '').trim();
    const match = s.match(/^(\d+)\s*(day|month|year)/i);
    if (!match) return null;
    const n = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('day'))   return n;
    if (unit.startsWith('month')) return n * 30;
    if (unit.startsWith('year'))  return n * 365;
    return null;
};

export const getIssues = async (req, res) => {
    try {
        console.log("Updated getIssues executing...");
        const {
            status, category, department, priority, search, search_field, searchField,
            local_body_id, local_body, ward_id, ward, startDate, endDate, assignee_id,
            page = 1, limit = 20, trash,
            created_by, updated_by,
            has_documents, has_audio_notes,
            phone_number, email_filter,
            communication_send, followup_marked,
            sort, order,
        } = req.query;
        // read submission_source separately (already destructured via req.query below)
        const srcFilter = req.query.submission_source || req.query.source;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const conditions = [];
        const params = [];

        // Trash vs live
        if (trash === 'true') {
            conditions.push('c.is_deleted = 1');
        } else {
            conditions.push('c.is_deleted = 0');
        }

        // Intake source filter
        if (srcFilter) {
            conditions.push('c.submission_source = ?');
            params.push(srcFilter);
        }

        // Constituent scoping — only see own issues
        if (!req.isAdmin && req.constituent) {
            conditions.push('c.constituent_user_id = ?');
            params.push(req.constituent.id);
        }

        if (status) {
            conditions.push('c.status = ?');
            params.push(status);
        } else if (trash !== 'true') {
            conditions.push("c.status != 'Draft'");
        }
        if (category) { conditions.push('c.category = ?'); params.push(category); }
        if (department) { conditions.push('c.department LIKE ?'); params.push('%' + department + '%'); }
        if (priority) { conditions.push('c.priority = ?'); params.push(priority); }
        
        const lbId = local_body_id || local_body;
        if (lbId) { conditions.push('c.local_body_id = ?'); params.push(lbId); }

        const wId = ward_id || ward;
        if (wId) { conditions.push('c.ward_id = ?'); params.push(wId); }

        if (startDate) { conditions.push('c.created_at >= ?'); params.push(startDate); }
        if (endDate) { conditions.push('c.created_at <= ?'); params.push(endDate); }

        if (assignee_id) {
            conditions.push('(c.filed_by_admin_id = ? OR c.updated_by_admin_id = ?)');
            params.push(assignee_id, assignee_id);
        }

        // Created By admin
        if (created_by) {
            conditions.push('c.filed_by_admin_id = ?');
            params.push(created_by);
        }

        // Updated By admin
        if (updated_by) {
            conditions.push('c.updated_by_admin_id = ?');
            params.push(updated_by);
        }

        // Has Documents/Attachments
        if (has_documents === 'Yes') {
            conditions.push('EXISTS (SELECT 1 FROM issue_attachments ia WHERE ia.issue_id = c.id LIMIT 1)');
        } else if (has_documents === 'No') {
            conditions.push('NOT EXISTS (SELECT 1 FROM issue_attachments ia WHERE ia.issue_id = c.id LIMIT 1)');
        }

        // Has Audio Notes (audio files stored in issue_attachments with audio/* MIME type)
        if (has_audio_notes === 'Yes') {
            conditions.push("EXISTS (SELECT 1 FROM issue_attachments ia WHERE ia.issue_id = c.id AND ia.file_type LIKE 'audio/%' LIMIT 1)");
        } else if (has_audio_notes === 'No') {
            conditions.push("NOT EXISTS (SELECT 1 FROM issue_attachments ia WHERE ia.issue_id = c.id AND ia.file_type LIKE 'audio/%' LIMIT 1)");
        }

        // Has Phone
        if (phone_number === 'Yes') {
            conditions.push("(c.phone IS NOT NULL AND c.phone != '')");
        } else if (phone_number === 'No') {
            conditions.push("(c.phone IS NULL OR c.phone = '')");
        }

        // Has Email
        if (email_filter === 'Yes') {
            conditions.push("(c.email IS NOT NULL AND c.email != '')");
        } else if (email_filter === 'No') {
            conditions.push("(c.email IS NULL OR c.email = '')");
        }

        // Communication Sent (within N days)
        if (communication_send) {
            if (communication_send === 'Never Sent') {
                conditions.push('NOT EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = ? AND cl.entity_id = c.id LIMIT 1)');
                params.push('Issue');
            } else {
                const days = parseDayLabel(communication_send);
                if (days) {
                    conditions.push('EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = ? AND cl.entity_id = c.id AND cl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1)');
                    params.push('Issue', days);
                }
            }
        }

        // Follow-up Marked (within N days)
        if (followup_marked) {
            if (followup_marked === 'Never Sent') {
                conditions.push("NOT EXISTS (SELECT 1 FROM issue_updates iu WHERE iu.issue_id = c.id AND (iu.type = 'Follow-up' OR iu.comm_channel IS NOT NULL) LIMIT 1)");
            } else {
                const days = parseDayLabel(followup_marked);
                if (days) {
                    conditions.push("EXISTS (SELECT 1 FROM issue_updates iu WHERE iu.issue_id = c.id AND (iu.type = 'Follow-up' OR iu.comm_channel IS NOT NULL) AND iu.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1)");
                    params.push(days);
                }
            }
        }

        if (search) {
            const q = search.trim();
            const field = (search_field || searchField || 'all').toLowerCase();

            switch (field) {
                case 'id':
                    conditions.push('(c.reference_no = ? OR c.reference_no LIKE ? OR c.id = ?)');
                    params.push(q, `${q}%`, isNaN(q) ? 0 : Number(q));
                    break;
                case 'phone':
                case 'number':
                    const cleanPhone = q.replace(/[^0-9]/g, '');
                    conditions.push('(c.phone LIKE ? OR c.alternative_phone LIKE ?)');
                    params.push(`%${cleanPhone || q}%`, `%${cleanPhone || q}%`);
                    break;
                case 'email':
                    conditions.push('c.email LIKE ?');
                    params.push(`%${q}%`);
                    break;
                case 'name':
                    conditions.push('(c.submitter_name LIKE ? OR MATCH(c.submitter_name, c.location) AGAINST(? IN BOOLEAN MODE))');
                    params.push(`%${q}%`, `+${q}*`);
                    break;
                case 'house_name':
                case 'address':
                case 'location':
                    conditions.push('(c.location LIKE ? OR MATCH(c.submitter_name, c.location) AGAINST(? IN BOOLEAN MODE))');
                    params.push(`%${q}%`, `+${q}*`);
                    break;
                case 'all':
                default:
                    conditions.push('(c.title LIKE ? OR c.submitter_name LIKE ? OR c.reference_no LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.location LIKE ?)');
                    const wildcard = `%${q}%`;
                    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
                    break;
            }
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Dynamic sort (allowlisted columns to prevent SQL injection)
        const SORT_COLS = {
            created_at:      'c.created_at',
            updated_at:      'c.updated_at',
            priority:        'c.priority',
            title:           'c.title',
            submitter_name:  'c.submitter_name',
            filed_by_admin_name: 'au.full_name',
        };
        const sortCol = SORT_COLS[sort] || 'c.created_at';
        const sortDir = order === 'asc' ? 'ASC' : 'DESC';

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM issues c ${where}`, params
        );

        const [rows] = await pool.query(`
            SELECT c.*,
                   c.department AS department_name,
                   lb.name AS local_body_name,
                   lbw.ward_no, lbw.place_name AS ward_name,
                   au.full_name AS filed_by_admin_name,
                   au_updater.full_name AS updated_by_admin_name,
                   (SELECT au2.full_name FROM issue_activity ia LEFT JOIN admin_users au2 ON ia.admin_user_id = au2.id WHERE ia.issue_id = c.id AND ia.text LIKE '%trash%' ORDER BY ia.created_at DESC LIMIT 1) AS deleted_by_name,
                   (SELECT JSON_OBJECT(
                       'id', id, 'type', type, 'title', title, 'created_at', created_at
                    ) FROM issue_updates WHERE issue_id = c.id AND type != 'Communication' ORDER BY created_at DESC LIMIT 1) as last_update,
                   (SELECT JSON_OBJECT(
                       'id', cl1.id,
                       'channels', (
                           SELECT GROUP_CONCAT(DISTINCT cl2.channel)
                           FROM communications_logs cl2
                           WHERE cl2.entity_type = 'Issue' AND cl2.entity_id = c.id
                           AND cl2.created_at >= cl1.created_at - INTERVAL 1 MINUTE
                           AND cl2.created_at <= cl1.created_at + INTERVAL 1 MINUTE
                       ),
                       'created_at', cl1.created_at
                    ) FROM communications_logs cl1 WHERE cl1.entity_type = 'Issue' AND cl1.entity_id = c.id ORDER BY cl1.created_at DESC LIMIT 1) as last_communication,
                   (SELECT JSON_OBJECT(
                       'scheduled_at', j.scheduled_at,
                       'channels', j.channels
                    ) FROM bulk_send_jobs j 
                      WHERE j.status = 'scheduled' 
                      AND JSON_CONTAINS(j.payload, JSON_OBJECT('id', c.id, 'module', 'P-'), '$.contacts') = 1
                      ORDER BY j.scheduled_at ASC LIMIT 1
                   ) as scheduled_communication
            FROM issues c
            LEFT JOIN local_bodies     lb  ON c.local_body_id = lb.id
            LEFT JOIN local_body_wards lbw ON c.ward_id = lbw.id
            LEFT JOIN admin_users      au  ON c.filed_by_admin_id = au.id
            LEFT JOIN admin_users      au_updater ON c.updated_by_admin_id = au_updater.id
            ${where}
            ORDER BY ${sortCol} ${sortDir}
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        res.json({
            success: true,
            data: rows,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
        });
    } catch (err) {
        console.error('[getIssues]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch issues.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/issues/stats  (admin only)
// ─────────────────────────────────────────────────────────────
export const getIssueStats = async (req, res) => {
    try {
        const [statusRows] = await pool.query(`SELECT status, COUNT(*) as count FROM issues WHERE is_deleted = 0 AND status != 'Draft' GROUP BY status`);
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM issues WHERE is_deleted = 0 AND status != 'Draft'`);
        const stats = { total };
        statusRows.forEach(row => { stats[row.status] = row.count });
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('[getIssueStats]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/issues/:id
// ─────────────────────────────────────────────────────────────
export const getIssueById = async (req, res) => {
    try {
        const issue = await fetchFullIssue(req.params.id);
        if (!issue) return res.status(404).json({ success: false, message: 'Issue not found.' });

        // Constituent can only view their own
        if (!req.isAdmin && req.constituent) {
            if (issue.constituent_user_id !== req.constituent.id) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }
        }

        res.json({ success: true, data: issue });
    } catch (err) {
        console.error('[getIssueById]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues
// ─────────────────────────────────────────────────────────────
export const createIssue = async (req, res) => {
    try {
        const {
            title, category, affected_by, resolved_date, priority, status, description, location, address, latitude, longitude,
            submitter_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, date_filed,
            address_line1, custom_sms_message, custom_email_message, notify_complainant,
            notify_channels,
            status_details,
        } = req.body;

        const internal_note = req.body.internal_note !== undefined 
            ? req.body.internal_note 
            : (req.body.remarks !== undefined ? req.body.remarks : (req.body.notes !== undefined ? req.body.notes : (req.body.remark !== undefined ? req.body.remark : null)));

        if (!title || !submitter_name || !phone) {
            return res.status(400).json({ success: false, message: 'title, submitter_name and phone are required.' });
        }

        const reference_no = await generateReferenceNo();

        const constituentId = req.constituent?.id || null;
        const adminId       = req.admin?.id       || null;
        const isAdminCreation = req.headers?.['x-app-portal'] === 'admin' || (adminId && !constituentId);
        const submission_source = isAdminCreation ? 'Admin Panel' : 'Public Portal';
        const initialStatus = status || (isAdminCreation ? (await getDropdownDefault('issue_status') || 'Pending') : 'Draft');

        const [result] = await pool.query(`
            INSERT INTO issues
              (reference_no, title, category, affected_by, resolved_date, priority, status, description, location, address, latitude, longitude, internal_note,
               submitter_name, phone, alternative_phone, email,
               local_body_id, ward_id, department, address_line1,
               constituent_user_id, filed_by_admin_id, date_filed, submission_source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            reference_no,
            title,
            category || null,
            affected_by || null,
            resolved_date || null,
            priority || await getDropdownDefault('issue_priority') || 'Medium',
            initialStatus,
            description || null,
            location || null,
            address || null,
            latitude || null,
            longitude || null,
            internal_note || null,
            submitter_name,
            phone,
            alternative_phone || null,
            email || null,
            local_body_id || null,
            ward_id || null,
            department || null,
            address_line1 || null,
            constituentId,
            adminId,
            date_filed || new Date().toISOString().split('T')[0],
            submission_source,
        ]);

        const newId = result.insertId;
        await logActivity(newId, `Issue "${title}" filed. Reference: ${reference_no}`, req.admin?.id);
        auditLog(req, { action: 'Created', module: 'Issues', details: `Issue filed — "${title}" (${reference_no})`, resource: `issues/${newId}`, severity: 'info' });

        // Notify all admins about new issue
        broadcastNotification({
          title: `New Issue ${reference_no}`,
          message: `"${title}" submitted by ${submitter_name}.`,
          type: 'alert', module: 'Issues',
          record_id: newId, record_ref: reference_no,
          link_path: `/mlaconnect/issues/${newId}`,
        });

        // Fire-and-forget: SMS & Email confirmation to submitter
        const dateStr = new Date(date_filed || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        
        const channels = Array.isArray(notify_channels) 
            ? notify_channels 
            : (typeof notify_channels === 'string' ? notify_channels.split(',').map(s => s.trim()) : []);
        const isLegacyNotify = notify_complainant === true || notify_complainant === 'true';
        const shouldSendSMS = channels.includes('sms') || isLegacyNotify;
        const shouldSendEmail = channels.includes('email') || isLegacyNotify;

        let didSendSms = false;
        let didSendEmail = false;
        let finalSms = null;
        let finalEmail = null;

        if (shouldSendSMS && phone && phone.trim()) {
            let smsBody = custom_sms_message?.trim() || submissionConfirmationSMS({
                name: submitter_name,
                dateFiled: date_filed || new Date().toISOString().split('T')[0],
                referenceNo: reference_no,
                statusDetails: status_details,
                moduleLabel: 'Public Issue',
            });

            smsBody = smsBody
                .replace(/\[Pending ID\]/gi, reference_no)
                .replace(/\[PendingID\]/gi, reference_no)
                .replace(/{reference_no}/g, reference_no)
                .replace(/{date}/g, dateStr)
                .replace(/{name}/g, submitter_name)
                .replace(/^Hi Citizen,/m, `Hi ${submitter_name},`)
                .replace(/^Hi Citizen /m, `Hi ${submitter_name} `);

            sendSMSSafe(phone.trim(), smsBody);
            didSendSms = true;
            finalSms = smsBody;
        }

        if (shouldSendEmail && email && email.trim()) {
            const reviewMsg = status_details?.trim() || "We are reviewing your submission.";
            let emailBody = custom_email_message?.trim() || `Hi ${submitter_name},\n\nPublic Issue received: ${dateStr}\n${reviewMsg}\nTracking ID: ${reference_no}\n\nOffice of Kothamangalam MLA`;
            
            emailBody = emailBody
                .replace(/\[Pending ID\]/g, reference_no)
                .replace(/{reference_no}/g, reference_no)
                .replace(/{date}/g, dateStr)
                .replace(/{name}/g, submitter_name)
                .replace(/^Hi Citizen,/m, `Hi ${submitter_name},`)
                .replace(/^Hi Citizen /m, `Hi ${submitter_name} `);

            sendNotificationEmail({
                to: email.trim(),
                subject: `Public Issue Received [${reference_no}]`,
                message: emailBody,
            }).catch(err => console.error('[createIssue:email]', err.message));

            didSendEmail = true;
            finalEmail = emailBody;
        }

        // Auto-insert timeline / follow-up entry
        const sdTrimmed = status_details?.trim();
        let commUpdateId = null;

        if (didSendSms || didSendEmail) {
            const commChannel = (didSendSms && didSendEmail) ? 'both' : (didSendSms ? 'sms' : 'email');
            const followUpTitle = sdTrimmed || 'Initial Acknowledgment';
            const followUpNote = finalSms || finalEmail;

            const [commUpRes] = await pool.query(
                `INSERT INTO issue_updates 
                 (issue_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [newId, followUpTitle, followUpNote, adminId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            commUpdateId = commUpRes.insertId;
        } else {
            const updateTitle = sdTrimmed || (isAdminCreation ? null : 'We are reviewing your submission.');
            const updateNote  = sdTrimmed ? null : (isAdminCreation ? null : `Your public issue report has been registered and is under initial review by the MLA Office.\n\nSubmitter: ${submitter_name}\nTracking ID: ${reference_no}`);
            if (updateTitle) {
                await pool.query(
                    `INSERT INTO issue_updates (issue_id, type, title, note, admin_user_id, created_at) VALUES (?, 'Status Update', ?, ?, ?, NOW())`,
                    [newId, updateTitle, updateNote, adminId]
                );
            }
        }

        // Log communications to communications_logs with update_id linked
        const commAdminId = adminId;
        if (didSendSms) {
            await pool.query(
                `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['Issue', newId, 'SMS', phone.trim(), finalSms, commAdminId, commUpdateId]
            ).catch(err => console.warn('[Log failed]', err.message));
        }

        if (didSendEmail) {
            await pool.query(
                `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['Issue', newId, 'Email', email.trim(), finalEmail, commAdminId, commUpdateId]
            ).catch(err => console.warn('[Log failed]', err.message));
        }

        const issue = await fetchFullIssue(newId);
        res.status(201).json({ success: true, message: 'Issue created successfully.', data: issue });
    } catch (err) {
        console.error('[createIssue]', err);
        res.status(500).json({ success: false, message: 'Failed to create issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/issues/:id  (admin only)
// ─────────────────────────────────────────────────────────────
export const updateIssue = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title, category, affected_by, resolved_date, priority, status, description, location, address, latitude, longitude,
            submitter_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, date_filed, address_line1,
            status_details,
            notify_complainant, notify_channels, custom_sms_message, custom_email_message
        } = req.body;

        const internal_note = req.body.internal_note !== undefined 
            ? req.body.internal_note 
            : (req.body.remarks !== undefined ? req.body.remarks : (req.body.notes !== undefined ? req.body.notes : (req.body.remark !== undefined ? req.body.remark : undefined)));

        const [result] = await pool.query(`
            UPDATE issues SET
              title = COALESCE(?, title),
              category = COALESCE(?, category),
              affected_by = COALESCE(?, affected_by),
              resolved_date = COALESCE(?, resolved_date),
              priority = COALESCE(?, priority),
              status = COALESCE(?, status),
              description = COALESCE(?, description),
              location = COALESCE(?, location),
              address = COALESCE(?, address),
              latitude = COALESCE(?, latitude),
              longitude = COALESCE(?, longitude),
              internal_note = ${internal_note !== undefined ? '?' : 'internal_note'},
              submitter_name = COALESCE(?, submitter_name),
              phone = COALESCE(?, phone),
              alternative_phone = COALESCE(?, alternative_phone),
              email = COALESCE(?, email),
              local_body_id = COALESCE(?, local_body_id),
              ward_id = COALESCE(?, ward_id),
              department = COALESCE(?, department),
              address_line1 = COALESCE(?, address_line1),
              date_filed = COALESCE(?, date_filed),
              updated_by_admin_id = ?
            WHERE id = ?
        `, [
            title, category, affected_by, resolved_date, priority, status, description, location, address, latitude, longitude,
            ...(internal_note !== undefined ? [internal_note] : []),
            submitter_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, address_line1, date_filed, req.admin?.id || null, id,
        ]);

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Issue not found.' });
        await logActivity(id, `Issue details updated by admin.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Issue ID ${id} details updated`, resource: `issues/${id}`, severity: 'success' });

        // Check if communication notification was requested
        const isNotify = notify_complainant === true || notify_complainant === 'true';
        let didSendSms = false;
        let didSendEmail = false;
        let finalSms = null;
        let finalEmail = null;

        if (isNotify) {
            const [[currentIssue]] = await pool.query('SELECT submitter_name, phone, email, reference_no, date_filed FROM issues WHERE id = ?', [id]);
            const targetPhone = (phone || currentIssue?.phone || '').trim();
            const targetEmail = (email || currentIssue?.email || '').trim();
            const targetName = submitter_name || currentIssue?.submitter_name || 'Citizen';
            const refNo = currentIssue?.reference_no || `P-${id}`;
            const dateStr = new Date(date_filed || currentIssue?.date_filed || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

            const channels = Array.isArray(notify_channels)
                ? notify_channels
                : (typeof notify_channels === 'string' ? notify_channels.split(',').map(s => s.trim()) : []);
            const shouldSendSMS = channels.includes('sms') || channels.length === 0;
            const shouldSendEmail = channels.includes('email') || channels.length === 0;

            if (shouldSendSMS && targetPhone) {
                let smsBody = custom_sms_message?.trim() || submissionConfirmationSMS({
                    name: targetName,
                    dateFiled: date_filed || currentIssue?.date_filed || new Date().toISOString().split('T')[0],
                    referenceNo: refNo,
                    statusDetails: status_details,
                    moduleLabel: 'Public Issue',
                });
                smsBody = smsBody
                    .replace(/\[Pending ID\]/gi, refNo)
                    .replace(/\[PendingID\]/gi, refNo)
                    .replace(/{reference_no}/g, refNo)
                    .replace(/{date}/g, dateStr)
                    .replace(/{name}/g, targetName)
                    .replace(/^Hi Citizen,/m, `Hi ${targetName},`)
                    .replace(/^Hi Citizen /m, `Hi ${targetName} `);
                sendSMSSafe(targetPhone, smsBody);
                didSendSms = true;
                finalSms = smsBody;
            }

            if (shouldSendEmail && targetEmail) {
                const reviewMsg = status_details?.trim() || "We are reviewing your submission.";
                let emailBody = custom_email_message?.trim() || `Hi ${targetName},\n\nPublic Issue received: ${dateStr}\n${reviewMsg}\nTracking ID: ${refNo}\n\nOffice of Kothamangalam MLA`;
                emailBody = emailBody
                    .replace(/\[Pending ID\]/g, refNo)
                    .replace(/{reference_no}/g, refNo)
                    .replace(/{date}/g, dateStr)
                    .replace(/{name}/g, targetName)
                    .replace(/^Hi Citizen,/m, `Hi ${targetName},`)
                    .replace(/^Hi Citizen /m, `Hi ${targetName} `);
                sendNotificationEmail({
                    to: targetEmail,
                    subject: `Update on your Public Issue [${refNo}]`,
                    message: emailBody,
                }).catch(err => console.error('[updateIssue:email]', err.message));
                didSendEmail = true;
                finalEmail = emailBody;
            }
        }

        let commUpdateId = null;
        if (didSendSms || didSendEmail) {
            const commChannel = (didSendSms && didSendEmail) ? 'both' : (didSendSms ? 'sms' : 'email');
            const followUpTitle = status_details?.trim() || 'Follow-up Update';
            const followUpNote = finalSms || finalEmail;
            const [commUpRes] = await pool.query(
                `INSERT INTO issue_updates 
                 (issue_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [id, followUpTitle, followUpNote, req.admin?.id || null, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            commUpdateId = commUpRes.insertId;

            const commAdminId = req.admin?.id || null;
            if (didSendSms) {
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Issue', id, 'SMS', (phone || '').trim(), finalSms, commAdminId, commUpdateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }
            if (didSendEmail) {
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Issue', id, 'Email', (email || '').trim(), finalEmail, commAdminId, commUpdateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }
        } else if (status_details?.trim()) {
            await pool.query(
                `INSERT INTO issue_updates (issue_id, type, title, note, admin_user_id, created_at) VALUES (?, 'Status Update', ?, ?, ?, NOW())`,
                [id, status_details.trim(), null, req.admin?.id || null]
            );
        }

        const issue = await fetchFullIssue(id);
        res.json({ success: true, message: 'Issue updated.', data: issue });
    } catch (err) {
        console.error('[updateIssue]', err);
        res.status(500).json({ success: false, message: 'Failed to update issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/issues/:id/status  (admin only)
// ─────────────────────────────────────────────────────────────
export const updateIssueStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!status) return res.status(400).json({ success: false, message: 'status is required.' });

        const [result] = await pool.query('UPDATE issues SET status = ?, updated_by_admin_id = ? WHERE id = ?', [status, req.admin?.id || null, id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Issue not found.' });

        await logActivity(id, `Status changed to "${status}".`, req.admin?.id);
        // Notify team members
        const [iTeam] = await pool.query('SELECT admin_user_id FROM issue_team WHERE issue_id = ?', [id]);
        const [[iRec]] = await pool.query('SELECT reference_no FROM issues WHERE id = ?', [id]);
        iTeam.forEach(m => createNotification(m.admin_user_id, {
          title: `Status updated on Issue ${iRec?.reference_no || `#${id}`}`,
          message: `Status changed to "${status}".`,
          type: 'info', module: 'Issues',
          record_id: Number(id), record_ref: iRec?.reference_no || null,
          link_path: `/mlaconnect/issues/${id}`,
        }));
        // Notify the constituent who filed this issue
        const [[iFiler]] = await pool.query('SELECT constituent_user_id, reference_no FROM issues WHERE id = ?', [id]);
        if (iFiler?.constituent_user_id) {
          notifyUser(iFiler.constituent_user_id, {
            title: `Your Issue ${iFiler.reference_no || `#${id}`} was updated`,
            message: `Status changed to "${status}". Check your submissions for details.`,
            type: 'info', module: 'Issues',
            record_ref: iFiler.reference_no || null,
            link_path: `/mla-connect/submissions/${id}`,
          });
        }
        res.json({ success: true, message: `Status updated to ${status}.` });
    } catch (err) {
        console.error('[updateIssueStatus]', err);
        res.status(500).json({ success: false, message: 'Failed to update status.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/issues/:id/trash  (admin only — soft delete)
// ─────────────────────────────────────────────────────────────
export const trashIssue = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query(
            'UPDATE issues SET is_deleted = 1, deleted_at = NOW(), updated_by_admin_id = ? WHERE id = ? AND is_deleted = 0',
            [req.admin?.id || null, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Issue not found or already trashed.' });
        await logActivity(id, 'Issue moved to trash.', req.admin?.id);
        auditLog(req, { action: 'Archived', module: 'Issues', details: `Issue ID ${id} moved to trash`, resource: `issues/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Issue moved to trash.' });
    } catch (err) {
        console.error('[trashIssue]', err);
        res.status(500).json({ success: false, message: 'Failed to trash issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/issues/:id/restore  (admin only)
// ─────────────────────────────────────────────────────────────
export const restoreIssue = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query(
            'UPDATE issues SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1', [id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Issue not found in trash.' });
        await logActivity(id, 'Issue restored from trash.', req.admin?.id);
        res.json({ success: true, message: 'Issue restored successfully.' });
    } catch (err) {
        console.error('[restoreIssue]', err);
        res.status(500).json({ success: false, message: 'Failed to restore issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/:id  (admin only — permanent delete, requires ?force=true)
// DELETE /api/issues/:id  (admin only — soft-deletes / preserves record)
// ─────────────────────────────────────────────────────────────
export const deleteIssue = async (req, res) => {
    try {
        const { id } = req.params;

        const [result] = await pool.query(
            'UPDATE issues SET is_deleted = 1, deleted_at = NOW(), updated_by_admin_id = ? WHERE id = ?',
            [req.admin?.id || null, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Issue not found.' });

        await logActivity(id, 'Issue moved to Trash', req.admin?.id);
        auditLog(req, { action: 'Trashed', module: 'Issues', details: `Issue ID ${id} moved to trash`, resource: `issues/${id}`, severity: 'info' });
        res.json({ success: true, message: 'Issue moved to trash.' });
    } catch (err) {
        console.error('[deleteIssue]', err);
        res.status(500).json({ success: false, message: 'Failed to delete issue.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues/:id/updates  (admin only)
// ─────────────────────────────────────────────────────────────
export const addIssueUpdate = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, title, note, notify_complainant, custom_sms_message, custom_email_message, notify_channels, hide_from_public } = req.body;
        if (!title) return res.status(400).json({ success: false, message: 'title is required.' });

        const isHidden = (hide_from_public === '1' || hide_from_public === 'true' || hide_from_public === 1 || hide_from_public === true) ? 1 : 0;

        const [result] = await pool.query(
            'INSERT INTO issue_updates (issue_id, type, title, note, admin_user_id, hide_from_public) VALUES (?,?,?,?,?,?)',
            [id, type || 'Status Update', title, note || null, req.admin?.id || null, isHidden]
        );
        const updateId = result.insertId;

        if (req.files && req.files['media'] && req.files['media'].length > 0) {
            const rows = req.files['media'].map(f => {
                const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
                return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, Math.round(f.size / 1024), updateId];
            });
            await pool.query(
                'INSERT INTO issue_media (issue_id, media_type, file_url, caption, file_name, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
            const rows = req.files['attachments'].map(f => [
                id, f.originalname, f.location, f.mimetype, Math.round(f.size / 1024), updateId
            ]);
            await pool.query(
                'INSERT INTO issue_attachments (issue_id, file_name, file_url, file_type, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        await logActivity(id, `Update added: "${title}"`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Added update to Issue ID ${id}`, resource: `issues/${id}`, severity: 'info' });
        // Notify team members
        const [iUpdateTeam] = await pool.query('SELECT admin_user_id FROM issue_team WHERE issue_id = ?', [id]);
        const [[iRec2]] = await pool.query('SELECT reference_no FROM issues WHERE id = ?', [id]);
        iUpdateTeam.forEach(m => createNotification(m.admin_user_id, {
          title: `New update on Issue ${iRec2?.reference_no || `#${id}`}`,
          message: `"${title}" — a new update has been added.`,
          type: 'message', module: 'Issues',
          record_id: Number(id), record_ref: iRec2?.reference_no || null,
          link_path: `/mlaconnect/issues/${id}`,
        }));
        // Notify the constituent who filed this issue about the new update
        const [[iFiler2]] = await pool.query('SELECT constituent_user_id, reference_no FROM issues WHERE id = ?', [id]);
        if (iFiler2?.constituent_user_id) {
          notifyUser(iFiler2.constituent_user_id, {
            title: `New update on your Issue ${iFiler2.reference_no || `#${id}`}`,
            message: `"${title}" — the team has added a new update to your issue.`,
            type: 'message', module: 'Issues',
            record_ref: iFiler2.reference_no || null,
            link_path: `/mla-connect/submissions/${id}`,
          });
        }

        // Fire-and-forget: SMS/Email follow-up if admin chose to notify submitter
        if (notify_complainant === 'true' || notify_complainant === true) {
            let channels = [];
            try {
                if (notify_channels) channels = JSON.parse(notify_channels);
            } catch (e) {}

            const [[rec]] = await pool.query(
                'SELECT submitter_name, email, phone, reference_no, COALESCE(date_filed, created_at) AS date_filed FROM issues WHERE id = ?', [id]
            );

            let didSendSms = false;
            let didSendEmail = false;
            let finalSms = null;
            let finalEmail = null;

            // Send SMS if selected
            if (rec?.phone && channels.includes('sms')) {
                finalSms = custom_sms_message?.trim() || followUpUpdateSMS({
                    name: rec.submitter_name,
                    referenceNo: rec.reference_no,
                    statusTitle: title,
                    moduleLabel: 'Issue',
                    updateDate: new Date(),
                });
                sendSMSSafe(rec.phone, finalSms);
                didSendSms = true;
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Issue', id, 'SMS', rec.phone.trim(), finalSms, req.admin?.id || null, updateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }

            // Send Email if selected
            if (rec?.email && channels.includes('email') && custom_email_message?.trim()) {
                finalEmail = custom_email_message.trim();
                sendNotificationEmail({
                    to: rec.email,
                    subject: `Update on your Issue ${rec.reference_no || ''}`,
                    message: finalEmail
                }).catch(err => console.error('[addIssueUpdate Email Error]', err));
                didSendEmail = true;
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Issue', id, 'Email', rec.email.trim(), finalEmail, req.admin?.id || null, updateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }

            if (didSendSms || didSendEmail) {
                const commChannel = (didSendSms && didSendEmail) ? 'both' : (didSendSms ? 'sms' : 'email');
                const now = new Date();
                await pool.query(
                    `UPDATE issue_updates 
                     SET comm_channel = ?, comm_sent_at = ?, sms_sent = ?, sms_body = ?, email_sent = ?, email_body = ?
                     WHERE id = ?`,
                    [commChannel, now, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail, updateId]
                ).catch(err => console.warn('[comm update failed]', err.message));
            }
        }

        const [[row]] = await pool.query('SELECT * FROM issue_updates WHERE id = ?', [updateId]);
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        console.error('[addIssueUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to add update.' });
    }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/issues/:id/updates/:updateId  (admin only)
// ─────────────────────────────────────────────────────────────
export const editIssueUpdate = async (req, res) => {
    try {
        const { id, updateId } = req.params;
        const { type, title, note, retained_media_ids, retained_attachment_ids, hide_from_public } = req.body;

        const updateFields = ['type = ?', 'title = ?', 'note = ?'];
        const updateParams = [type || 'Status Update', title, note || null];

        if (hide_from_public !== undefined) {
            const isHidden = (hide_from_public === '1' || hide_from_public === 'true' || hide_from_public === 1 || hide_from_public === true) ? 1 : 0;
            updateFields.push('hide_from_public = ?');
            updateParams.push(isHidden);
        }

        updateParams.push(updateId, id);
        await pool.query(
            `UPDATE issue_updates SET ${updateFields.join(', ')} WHERE id = ? AND issue_id = ?`,
            updateParams
        );

        let retainedMedia = [];
        let retainedAttachments = [];
        try { if (retained_media_ids) retainedMedia = JSON.parse(retained_media_ids); } catch(e){}
        try { if (retained_attachment_ids) retainedAttachments = JSON.parse(retained_attachment_ids); } catch(e){}

        const [currentMedia] = await pool.query('SELECT id, file_url FROM issue_media WHERE update_id = ?', [updateId]);
        const mediaToDelete = currentMedia.filter(m => !retainedMedia.includes(m.id));
        if (mediaToDelete.length > 0) {
            const idsToDelete = mediaToDelete.map(m => m.id);
            await Promise.all(mediaToDelete.map(m => deleteS3Object(m.file_url)));
            await pool.query('DELETE FROM issue_media WHERE id IN (?)', [idsToDelete]);
        }

        const [currentAtt] = await pool.query('SELECT id, file_url FROM issue_attachments WHERE update_id = ?', [updateId]);
        const attToDelete = currentAtt.filter(m => !retainedAttachments.includes(m.id));
        if (attToDelete.length > 0) {
            const idsToDelete = attToDelete.map(m => m.id);
            await Promise.all(attToDelete.map(m => deleteS3Object(m.file_url)));
            await pool.query('DELETE FROM issue_attachments WHERE id IN (?)', [idsToDelete]);
        }

        if (req.files && req.files['media'] && req.files['media'].length > 0) {
            const rows = req.files['media'].map(f => {
                const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
                return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, Math.round(f.size / 1024), updateId];
            });
            await pool.query(
                'INSERT INTO issue_media (issue_id, media_type, file_url, caption, file_name, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
            const rows = req.files['attachments'].map(f => [
                id, f.originalname, f.location, f.mimetype, Math.round(f.size / 1024), updateId
            ]);
            await pool.query(
                'INSERT INTO issue_attachments (issue_id, file_name, file_url, file_type, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }
        
        await logActivity(id, `An update was edited: ${title}`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Edited update on Issue ID ${id}`, resource: `issues/${id}`, severity: 'info' });

        res.json({ success: true, message: 'Update edited successfully.' });
    } catch (err) {
        console.error('[editIssueUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to edit update.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/:id/updates/:updateId  (admin only)
// ─────────────────────────────────────────────────────────────
export const deleteIssueUpdate = async (req, res) => {
    try {
        const { id, updateId } = req.params;
        const [result] = await pool.query(
            'DELETE FROM issue_updates WHERE id = ? AND issue_id = ?', [updateId, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Update not found.' });
        await logActivity(id, `An update entry was removed.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Removed update from Issue ID ${id}`, resource: `issues/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Update deleted.' });
    } catch (err) {
        console.error('[deleteIssueUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to delete update.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues/:id/media  (admin or owner constituent)
// Multer processes files before this handler runs.
// ─────────────────────────────────────────────────────────────
export const uploadIssueMedia = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.files?.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });

        const rows = req.files.map(f => {
            const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
            const sizeKb = Math.round(f.size / 1024);
            return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, sizeKb];
        });

        await pool.query(
            'INSERT INTO issue_media (issue_id, media_type, file_url, caption, file_name, file_size_kb) VALUES ?',
            [rows]
        );
        await logActivity(id, `${req.files.length} media file(s) uploaded.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Uploaded ${req.files.length} media file(s) to Issue ID ${id}`, resource: `issues/${id}`, severity: 'info' });

        const [media] = await pool.query('SELECT * FROM issue_media WHERE issue_id = ? ORDER BY created_at ASC', [id]);
        res.status(201).json({ success: true, data: media });
    } catch (err) {
        console.error('[uploadIssueMedia]', err);
        res.status(500).json({ success: false, message: 'Failed to upload media.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/:id/media/:mediaId  (admin only)
// ─────────────────────────────────────────────────────────────
export const deleteIssueMedia = async (req, res) => {
    try {
        const { id, mediaId } = req.params;
        const [[row]] = await pool.query('SELECT file_url FROM issue_media WHERE id = ? AND issue_id = ?', [mediaId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Media not found.' });

        await deleteS3Object(row.file_url);
        await pool.query('DELETE FROM issue_media WHERE id = ?', [mediaId]);
        await logActivity(id, 'A media file was removed.', req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Removed media from Issue ID ${id}`, resource: `issues/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Media deleted.' });
    } catch (err) {
        console.error('[deleteIssueMedia]', err);
        res.status(500).json({ success: false, message: 'Failed to delete media.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues/:id/attachments  (admin or owner)
// ─────────────────────────────────────────────────────────────
export const uploadIssueAttachment = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.files?.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });

        const rows = req.files.map(f => {
            const ext = f.originalname.split('.').pop()?.toLowerCase() || '';
            const sizeKb = Math.round(f.size / 1024);
            return [id, f.originalname, f.location, ext, sizeKb];
        });

        await pool.query(
            'INSERT INTO issue_attachments (issue_id, file_name, file_url, file_type, file_size_kb) VALUES ?',
            [rows]
        );
        await logActivity(id, `${req.files.length} attachment(s) uploaded.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Uploaded ${req.files.length} attachment(s) to Issue ID ${id}`, resource: `issues/${id}`, severity: 'info' });

        const [attachments] = await pool.query('SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY created_at ASC', [id]);
        res.status(201).json({ success: true, data: attachments });
    } catch (err) {
        console.error('[uploadIssueAttachment]', err);
        res.status(500).json({ success: false, message: 'Failed to upload attachment.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/:id/attachments/:attachId  (admin only)
// ─────────────────────────────────────────────────────────────
export const deleteIssueAttachment = async (req, res) => {
    try {
        const { id, attachId } = req.params;
        const [[row]] = await pool.query('SELECT file_url FROM issue_attachments WHERE id = ? AND issue_id = ?', [attachId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Attachment not found.' });

        await deleteS3Object(row.file_url);
        await pool.query('DELETE FROM issue_attachments WHERE id = ?', [attachId]);
        await logActivity(id, 'An attachment was removed.', req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Removed attachment from Issue ID ${id}`, resource: `issues/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Attachment deleted.' });
    } catch (err) {
        console.error('[deleteIssueAttachment]', err);
        res.status(500).json({ success: false, message: 'Failed to delete attachment.' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/issues/:id/team  (admin only)
// ─────────────────────────────────────────────────────────────
export const addIssueTeamMember = async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_user_id, role_label } = req.body;
        if (!admin_user_id) return res.status(400).json({ success: false, message: 'admin_user_id is required.' });

        // Verify admin user exists
        const [[adminUser]] = await pool.query('SELECT id, full_name FROM admin_users WHERE id = ?', [admin_user_id]);
        if (!adminUser) return res.status(404).json({ success: false, message: 'Admin user not found.' });

        try {
            const [result] = await pool.query(
                'INSERT INTO issue_team (issue_id, admin_user_id, role_label) VALUES (?,?,?)',
                [id, admin_user_id, role_label || null]
            );
            await logActivity(id, `Team member "${adminUser.full_name}" added${role_label ? ` as ${role_label}` : ''}.`, req.admin?.id);
            auditLog(req, { action: 'Updated', module: 'Issues', details: `Added team member "${adminUser.full_name}" to Issue ID ${id}`, resource: `issues/${id}`, severity: 'info' });
            // Notify the assigned admin
            const [[iRef]] = await pool.query('SELECT reference_no FROM issues WHERE id = ?', [id]);
            createNotification(admin_user_id, {
              title: `You've been assigned to Issue ${iRef?.reference_no || `#${id}`}`,
              message: role_label ? `Role: ${role_label}` : 'You have been added to the issue team.',
              type: 'alert', module: 'Issues',
              record_id: Number(id), record_ref: iRef?.reference_no || null,
              link_path: `/mlaconnect/issues/${id}`,
            });
            const [[row]] = await pool.query(`
                SELECT ct.id, ct.role_label, ct.created_at,
                       au.id as admin_user_id, au.full_name as name, au.email
                FROM issue_team ct
                JOIN admin_users au ON ct.admin_user_id = au.id
                WHERE ct.id = ?
            `, [result.insertId]);
            res.status(201).json({ success: true, data: row });
        } catch (dupErr) {
            if (dupErr.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, message: 'This admin is already in the team.' });
            }
            throw dupErr;
        }
    } catch (err) {
        console.error('[addIssueTeamMember]', err);
        res.status(500).json({ success: false, message: 'Failed to add team member.' });
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/issues/:id/team/:memberId  (admin only)
// ─────────────────────────────────────────────────────────────
export const removeIssueTeamMember = async (req, res) => {
    try {
        const { id, memberId } = req.params;
        const [[row]] = await pool.query(`
            SELECT ct.id, au.full_name
            FROM issue_team ct JOIN admin_users au ON ct.admin_user_id = au.id
            WHERE ct.id = ? AND ct.issue_id = ?
        `, [memberId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Team member not found.' });

        const [[iRemovedMember]] = await pool.query('SELECT admin_user_id FROM issue_team WHERE id = ?', [memberId]);
        await pool.query('DELETE FROM issue_team WHERE id = ?', [memberId]);
        await logActivity(id, `Team member "${row.full_name}" removed.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Issues', details: `Removed team member "${row.full_name}" from Issue ID ${id}`, resource: `issues/${id}`, severity: 'warning' });
        if (iRemovedMember) createNotification(iRemovedMember.admin_user_id, {
          title: `Removed from Issue #${id}`,
          message: `You have been removed from the issue team.`,
          type: 'info', module: 'Issues', record_id: Number(id),
          link_path: `/mlaconnect/issues/${id}`,
        });
        res.json({ success: true, message: 'Team member removed.' });
    } catch (err) {
        console.error('[removeIssueTeamMember]', err);
        res.status(500).json({ success: false, message: 'Failed to remove team member.' });
    }
};
