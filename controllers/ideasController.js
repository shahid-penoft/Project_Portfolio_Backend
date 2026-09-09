import pool from '../configs/db.js';
import { getDropdownDefault } from './mlaDropdownsController.js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logActivity as auditLog } from './teamsLogController.js';
import { sendSMSSafe } from '../services/smsService.js';
import { submissionConfirmationSMS, followUpUpdateSMS } from '../services/smsTemplates.js';
import { sendNotificationEmail } from '../utils/email.js';
import { broadcastNotification } from '../utils/notificationHelper.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});
const s3Bucket = process.env.AWS_S3_BUCKET || 'my-portfolio-bucket';

const keyFromUrl = (url) => {
    try { return new URL(url).pathname.replace(/^\//, ''); } catch { return null; }
};

const deleteS3Object = async (url) => {
    const key = keyFromUrl(url);
    if (!key) return;
    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
    } catch (err) {
        console.warn('[S3 delete warn]', key, err.message);
    }
};

const logActivity = async (ideaId, text, adminUserId = null) => {
    await pool.query(
        'INSERT INTO idea_activity (idea_id, text, admin_user_id) VALUES (?, ?, ?)',
        [ideaId, text, adminUserId]
    );
};

// Helper: generate reference number  I-NNN
const generateReferenceNo = async () => {
    const [[{ maxSeq }]] = await pool.query('SELECT COALESCE(MAX(CAST(SUBSTRING(reference_no, 3) AS UNSIGNED)), 0) as maxSeq FROM ideas WHERE reference_no LIKE "I-%"');
    const seq = String(parseInt(maxSeq, 10) + 1).padStart(3, '0');
    return `I-${seq}`;
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

const fetchFullIdea = async (id) => {
    const cleanId = (typeof id === 'string' && id.startsWith('I-')) ? id.replace(/^I-/, '') : id;

    const [[idea]] = await pool.query(`
        SELECT i.*,
               i.department AS department_name,
               lb.name AS local_body_name,
               lbw.ward_no,
               lbw.place_name AS ward_place_name,
               au.full_name   AS filed_by_admin_name,
               au_updater.full_name AS updated_by_admin_name
        FROM ideas i
        LEFT JOIN local_bodies     lb  ON i.local_body_id     = lb.id
        LEFT JOIN local_body_wards lbw ON i.ward_id           = lbw.id
        LEFT JOIN admin_users      au  ON i.filed_by_admin_id = au.id
        LEFT JOIN admin_users au_updater ON i.updated_by_admin_id = au_updater.id
        WHERE i.id = ? OR i.reference_no = ? OR i.id = ?
    `, [cleanId, id, id]);

    if (!idea) return null;

    const realId = idea.id;

    const [updates] = await pool.query(`
        SELECT u.*, au.full_name AS author_name, au.full_name AS admin_name
        FROM idea_updates u
        LEFT JOIN admin_users au ON u.admin_user_id = au.id
        WHERE u.idea_id = ? 
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
         WHERE cl.entity_type = 'Idea' AND (
             cl.entity_id COLLATE utf8mb4_unicode_ci = ? 
             OR cl.entity_id COLLATE utf8mb4_unicode_ci = ?
         )
         ORDER BY cl.created_at ASC`, 
        [String(realId), String(idea.reference_no || realId)]
    );
    const combinedUpdatesRaw = [...updates, ...commLogs].sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || ((Number(b.id) || 0) - (Number(a.id) || 0)));

    const [allMedia]       = await pool.query('SELECT * FROM idea_media       WHERE idea_id = ? ORDER BY created_at ASC', [realId]);
    const [allAttachments] = await pool.query('SELECT * FROM idea_attachments WHERE idea_id = ? ORDER BY created_at ASC', [realId]);

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
        SELECT it.id, it.role_label, it.created_at,
               au.id as admin_user_id, au.full_name as name, au.email
        FROM idea_team it
        JOIN admin_users au ON it.admin_user_id = au.id
        WHERE it.idea_id = ?
        ORDER BY it.created_at ASC
    `, [realId]);
    const [activity]    = await pool.query(`
        SELECT ia.*, COALESCE(au.full_name, i.complainant_name, 'Citizen') as author_name 
        FROM idea_activity ia
        LEFT JOIN admin_users au ON ia.admin_user_id = au.id
        LEFT JOIN ideas i ON ia.idea_id = i.id
        WHERE ia.idea_id = ? 
        ORDER BY ia.created_at DESC
    `, [realId]);

    return { ...idea, remarks: idea.internal_note || '', updates: mappedUpdates, media, attachments, team, activity };
};

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

export const getIdeas = async (req, res) => {
    try {
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
        const srcFilter = req.query.submission_source || req.query.source;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const conditions = [];
        const params = [];

        if (trash === 'true') {
            conditions.push('i.is_deleted = 1');
        } else {
            conditions.push('i.is_deleted = 0');
        }

        // Intake source filter
        if (srcFilter) {
            conditions.push('i.submission_source = ?');
            params.push(srcFilter);
        }

        if (!req.isAdmin && req.constituent) {
            conditions.push('i.constituent_user_id = ?');
            params.push(req.constituent.id);
        }

        if (status) {
            conditions.push('i.status = ?');
            params.push(status);
        } else if (trash !== 'true') {
            conditions.push("i.status != 'Draft'");
        }
        if (category && category !== 'All') { conditions.push('i.category = ?'); params.push(category); }
        if (department) { conditions.push('i.department LIKE ?'); params.push('%' + department + '%'); }
        if (priority && priority !== 'All') { conditions.push('i.priority = ?'); params.push(priority); }
        
        const lbId = local_body_id || local_body;
        if (lbId) { conditions.push('i.local_body_id = ?'); params.push(lbId); }

        const wId = ward_id || ward;
        if (wId) { conditions.push('i.ward_id = ?'); params.push(wId); }

        if (startDate) { conditions.push('i.created_at >= ?'); params.push(startDate); }
        if (endDate) { conditions.push('i.created_at <= ?'); params.push(endDate); }

        if (assignee_id) {
            conditions.push('(i.filed_by_admin_id = ? OR i.updated_by_admin_id = ?)');
            params.push(assignee_id, assignee_id);
        }

        // Created By admin
        if (created_by) {
            conditions.push('i.filed_by_admin_id = ?');
            params.push(created_by);
        }

        // Updated By admin
        if (updated_by) {
            conditions.push('i.updated_by_admin_id = ?');
            params.push(updated_by);
        }

        // Has Documents/Attachments
        if (has_documents === 'Yes') {
            conditions.push('EXISTS (SELECT 1 FROM idea_attachments ia WHERE ia.idea_id = i.id LIMIT 1)');
        } else if (has_documents === 'No') {
            conditions.push('NOT EXISTS (SELECT 1 FROM idea_attachments ia WHERE ia.idea_id = i.id LIMIT 1)');
        }

        // Has Audio Notes (audio files stored in idea_attachments with audio/* MIME type)
        if (has_audio_notes === 'Yes') {
            conditions.push("EXISTS (SELECT 1 FROM idea_attachments ia WHERE ia.idea_id = i.id AND ia.file_type LIKE 'audio/%' LIMIT 1)");
        } else if (has_audio_notes === 'No') {
            conditions.push("NOT EXISTS (SELECT 1 FROM idea_attachments ia WHERE ia.idea_id = i.id AND ia.file_type LIKE 'audio/%' LIMIT 1)");
        }

        // Has Phone
        if (phone_number === 'Yes') {
            conditions.push("(i.phone IS NOT NULL AND i.phone != '')");
        } else if (phone_number === 'No') {
            conditions.push("(i.phone IS NULL OR i.phone = '')");
        }

        // Has Email
        if (email_filter === 'Yes') {
            conditions.push("(i.email IS NOT NULL AND i.email != '')");
        } else if (email_filter === 'No') {
            conditions.push("(i.email IS NULL OR i.email = '')");
        }

        // Communication Sent (within N days)
        if (communication_send) {
            if (communication_send === 'Never Sent') {
                conditions.push('NOT EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = ? AND cl.entity_id = i.id LIMIT 1)');
                params.push('Idea');
            } else {
                const days = parseDayLabel(communication_send);
                if (days) {
                    conditions.push('EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = ? AND cl.entity_id = i.id AND cl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1)');
                    params.push('Idea', days);
                }
            }
        }

        // Follow-up Marked (within N days)
        if (followup_marked) {
            if (followup_marked === 'Never Sent') {
                conditions.push("NOT EXISTS (SELECT 1 FROM idea_updates iu WHERE iu.idea_id = i.id AND (iu.type = 'Follow-up' OR iu.comm_channel IS NOT NULL) LIMIT 1)");
            } else {
                const days = parseDayLabel(followup_marked);
                if (days) {
                    conditions.push("EXISTS (SELECT 1 FROM idea_updates iu WHERE iu.idea_id = i.id AND (iu.type = 'Follow-up' OR iu.comm_channel IS NOT NULL) AND iu.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1)");
                    params.push(days);
                }
            }
        }

        if (search) {
            const q = search.trim();
            const field = (search_field || searchField || 'all').toLowerCase();

            switch (field) {
                case 'id':
                    conditions.push('(i.reference_no = ? OR i.reference_no LIKE ? OR i.id = ?)');
                    params.push(q, `${q}%`, isNaN(q) ? 0 : Number(q));
                    break;
                case 'phone':
                case 'number':
                    const cleanPhone = q.replace(/[^0-9]/g, '');
                    conditions.push('(i.phone LIKE ? OR i.alternative_phone LIKE ?)');
                    params.push(`%${cleanPhone || q}%`, `%${cleanPhone || q}%`);
                    break;
                case 'email':
                    conditions.push('i.email LIKE ?');
                    params.push(`%${q}%`);
                    break;
                case 'name':
                    conditions.push('(i.complainant_name LIKE ? OR MATCH(i.complainant_name, i.location) AGAINST(? IN BOOLEAN MODE))');
                    params.push(`%${q}%`, `+${q}*`);
                    break;
                case 'house_name':
                case 'address':
                case 'location':
                    conditions.push('(i.location LIKE ? OR MATCH(i.complainant_name, i.location) AGAINST(? IN BOOLEAN MODE))');
                    params.push(`%${q}%`, `+${q}*`);
                    break;
                case 'all':
                default:
                    conditions.push('(i.title LIKE ? OR i.complainant_name LIKE ? OR i.reference_no LIKE ? OR i.phone LIKE ? OR i.email LIKE ? OR i.location LIKE ?)');
                    const wildcard = `%${q}%`;
                    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
                    break;
            }
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Dynamic sort (allowlisted columns to prevent SQL injection)
        const SORT_COLS = {
            created_at:       'i.created_at',
            updated_at:       'i.updated_at',
            priority:         'i.priority',
            title:            'i.title',
            complainant_name: 'i.complainant_name',
            filed_by_admin_name: 'au.full_name',
        };
        const sortCol = SORT_COLS[sort] || 'i.created_at';
        const sortDir = order === 'asc' ? 'ASC' : 'DESC';

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM ideas i ${where}`, params
        );

        const [rows] = await pool.query(`
            SELECT i.*,
                   i.department AS department_name,
                   lb.name AS local_body_name,
                   lbw.ward_no, lbw.place_name AS ward_name,
                   au.full_name AS filed_by_admin_name,
                   au_updater.full_name AS updated_by_admin_name,
                   (SELECT JSON_OBJECT(
                       'id', id, 'type', type, 'title', title, 'created_at', created_at
                    ) FROM idea_updates WHERE idea_id = i.id AND type != 'Communication' ORDER BY created_at DESC LIMIT 1) as last_update,
                   (SELECT JSON_OBJECT(
                       'id', cl1.id,
                       'channels', (
                           SELECT GROUP_CONCAT(DISTINCT cl2.channel)
                           FROM communications_logs cl2
                           WHERE cl2.entity_type = 'Idea' AND cl2.entity_id = i.id
                           AND cl2.created_at >= cl1.created_at - INTERVAL 1 MINUTE
                           AND cl2.created_at <= cl1.created_at + INTERVAL 1 MINUTE
                       ),
                       'created_at', cl1.created_at
                    ) FROM communications_logs cl1 WHERE cl1.entity_type = 'Idea' AND cl1.entity_id = i.id ORDER BY cl1.created_at DESC LIMIT 1) as last_communication,
                   (SELECT JSON_OBJECT(
                       'scheduled_at', j.scheduled_at,
                       'channels', j.channels
                    ) FROM bulk_send_jobs j 
                      WHERE j.status = 'scheduled' 
                      AND JSON_CONTAINS(j.payload, JSON_OBJECT('id', i.id, 'module', 'I-'), '$.contacts') = 1
                      ORDER BY j.scheduled_at ASC LIMIT 1
                   ) as scheduled_communication
            FROM ideas i
            LEFT JOIN local_bodies     lb  ON i.local_body_id = lb.id
            LEFT JOIN local_body_wards lbw ON i.ward_id = lbw.id
            LEFT JOIN admin_users      au  ON i.filed_by_admin_id = au.id
            LEFT JOIN admin_users      au_updater ON i.updated_by_admin_id = au_updater.id
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
        console.error('[getIdeas]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch ideas.' });
    }
};

export const getIdeaStats = async (req, res) => {
    try {
        const [statusRows] = await pool.query(`SELECT status, COUNT(*) as count FROM ideas WHERE is_deleted = 0 AND status != 'Draft' GROUP BY status`);
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM ideas WHERE is_deleted = 0 AND status != 'Draft'`);
        const stats = { total };
        statusRows.forEach(row => { stats[row.status] = row.count });
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('[getIdeaStats]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
    }
};

export const getIdeaById = async (req, res) => {
    try {
        const idea = await fetchFullIdea(req.params.id);
        if (!idea) return res.status(404).json({ success: false, message: 'Idea not found.' });

        if (!req.isAdmin && req.constituent) {
            if (idea.constituent_user_id !== req.constituent.id) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }
        }

        res.json({ success: true, data: idea });
    } catch (err) {
        console.error('[getIdeaById]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch idea.' });
    }
};

export const createIdea = async (req, res) => {
    try {
        const {
            title, category, priority, status, description, location, address, address_line1, latitude, longitude,
            complainant_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, date_filed,
            custom_sms_message, custom_email_message, notify_complainant,
            notify_channels,
            status_details,
        } = req.body;

        const internal_note = req.body.internal_note !== undefined 
            ? req.body.internal_note 
            : (req.body.remarks !== undefined ? req.body.remarks : (req.body.notes !== undefined ? req.body.notes : (req.body.remark !== undefined ? req.body.remark : null)));

        if (!title || !complainant_name || !phone) {
            return res.status(400).json({ success: false, message: 'title, complainant_name and phone are required.' });
        }

        const reference_no = await generateReferenceNo();
        const constituentId = req.constituent?.id || null;
        const adminId       = req.admin?.id       || null;
        const isAdminCreation = req.headers['x-app-portal'] === 'admin' || (adminId && !constituentId);
        const submission_source = isAdminCreation ? 'Admin Panel' : 'Public Portal';
        const initialStatus = status || (isAdminCreation ? (await getDropdownDefault('idea_status') || 'Pending') : 'Draft');

        const [result] = await pool.query(`
            INSERT INTO ideas
              (reference_no, title, category, priority, status, description, location, address, address_line1, latitude, longitude, internal_note,
               complainant_name, phone, alternative_phone, email,
               local_body_id, ward_id, department,
               constituent_user_id, filed_by_admin_id, date_filed, submission_source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            reference_no,
            title,
            category || null,
            priority || await getDropdownDefault('idea_priority') || 'Medium',
            initialStatus,
            description || null,
            location || null,
            address || null,
            address_line1 || null,
            latitude || null,
            longitude || null,
            internal_note || null,
            complainant_name,
            phone,
            alternative_phone || null,
            email || null,
            local_body_id || null,
            ward_id || null,
            department || null,
            constituentId,
            adminId,
            date_filed || new Date().toISOString().split('T')[0],
            submission_source,
        ]);

        const newId = result.insertId;
        await logActivity(newId, `Idea "${title}" filed. Reference: ${reference_no}`, req.admin?.id);
        auditLog(req, { action: 'Created', module: 'Ideas', details: `Idea filed — "${title}" (${reference_no})`, resource: `ideas/${newId}`, severity: 'info' });

        // Notify all admins about new idea
        broadcastNotification({
          title: `New Idea ${reference_no}`,
          message: `"${title}" shared by ${complainant_name}.`,
          type: 'alert', module: 'Ideas',
          record_id: newId, record_ref: reference_no,
          link_path: `/mlaconnect/ideas/${newId}`,
        });

        // Fire-and-forget: SMS & Email confirmation to complainant
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
                name: complainant_name,
                dateFiled: date_filed || new Date().toISOString().split('T')[0],
                referenceNo: reference_no,
                statusDetails: status_details,
                moduleLabel: 'Idea',
            });
            
            smsBody = smsBody
                .replace(/\[Pending ID\]/gi, reference_no)
                .replace(/\[PendingID\]/gi, reference_no)
                .replace(/{reference_no}/g, reference_no)
                .replace(/{date}/g, dateStr)
                .replace(/{name}/g, complainant_name)
                .replace(/^Hi Citizen,/m, `Hi ${complainant_name},`)
                .replace(/^Hi Citizen /m, `Hi ${complainant_name} `);

            sendSMSSafe(phone.trim(), smsBody);
            didSendSms = true;
            finalSms = smsBody;
        }

        if (shouldSendEmail && email && email.trim()) {
            const reviewMsg = status_details?.trim() || "We are reviewing your submission.";
            let emailBody = custom_email_message?.trim() || `Hi ${complainant_name},\n\nIdea received: ${dateStr}\n${reviewMsg}\nTracking ID: ${reference_no}\n\nOffice of Kothamangalam MLA`;
            
            emailBody = emailBody
                .replace(/\[Pending ID\]/g, reference_no)
                .replace(/{reference_no}/g, reference_no)
                .replace(/{date}/g, dateStr)
                .replace(/{name}/g, complainant_name)
                .replace(/^Hi Citizen,/m, `Hi ${complainant_name},`)
                .replace(/^Hi Citizen /m, `Hi ${complainant_name} `);

            sendNotificationEmail({
                to: email.trim(),
                subject: `Idea Received [${reference_no}]`,
                message: emailBody,
            }).catch(err => console.error('[createIdea:email]', err.message));

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
                `INSERT INTO idea_updates 
                 (idea_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [newId, followUpTitle, followUpNote, adminId, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            commUpdateId = commUpRes.insertId;
        } else {
            const updateTitle = sdTrimmed || (isAdminCreation ? null : 'We are reviewing your submission.');
            const updateNote  = sdTrimmed || (isAdminCreation ? null : `Your idea has been registered and is under initial review by the MLA Office.\n\nContributor: ${complainant_name}\nTracking ID: ${reference_no}`);
            if (updateTitle) {
                await pool.query(
                    `INSERT INTO idea_updates (idea_id, type, title, note, admin_user_id, created_at) VALUES (?, 'Status Update', ?, ?, ?, NOW())`,
                    [newId, updateTitle, updateNote, adminId]
                );
            }
        }

        // Log communications to communications_logs with update_id linked
        const commAdminId = adminId;
        if (didSendSms) {
            await pool.query(
                `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['Idea', newId, 'SMS', phone.trim(), finalSms, commAdminId, commUpdateId]
            ).catch(err => console.warn('[Log failed]', err.message));
        }

        if (didSendEmail) {
            await pool.query(
                `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['Idea', newId, 'Email', email.trim(), finalEmail, commAdminId, commUpdateId]
            ).catch(err => console.warn('[Log failed]', err.message));
        }

        const idea = await fetchFullIdea(newId);
        res.status(201).json({ success: true, message: 'Idea created successfully.', data: idea });
    } catch (err) {
        console.error('[createIdea]', err);
        res.status(500).json({ success: false, message: 'Failed to create idea.' });
    }
};

export const updateIdea = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title, category, priority, status, description, location, address, address_line1, latitude, longitude,
            complainant_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, date_filed,
            status_details,
            notify_complainant, notify_channels, custom_sms_message, custom_email_message
        } = req.body;

        const internal_note = req.body.internal_note !== undefined 
            ? req.body.internal_note 
            : (req.body.remarks !== undefined ? req.body.remarks : (req.body.notes !== undefined ? req.body.notes : (req.body.remark !== undefined ? req.body.remark : undefined)));

        const [result] = await pool.query(`
            UPDATE ideas SET
              title = COALESCE(?, title),
              category = COALESCE(?, category),
              priority = COALESCE(?, priority),
              status = COALESCE(?, status),
              description = COALESCE(?, description),
              location = COALESCE(?, location),
              address = COALESCE(?, address),
              address_line1 = COALESCE(?, address_line1),
              latitude = COALESCE(?, latitude),
              longitude = COALESCE(?, longitude),
              internal_note = ${internal_note !== undefined ? '?' : 'internal_note'},
              complainant_name = COALESCE(?, complainant_name),
              phone = COALESCE(?, phone),
              alternative_phone = COALESCE(?, alternative_phone),
              email = COALESCE(?, email),
              local_body_id = COALESCE(?, local_body_id),
              ward_id = COALESCE(?, ward_id),
              department = COALESCE(?, department),
              date_filed = COALESCE(?, date_filed),
              updated_by_admin_id = ?
            WHERE id = ?
        `, [
            title, category, priority, status, description, location, address, address_line1, latitude, longitude,
            ...(internal_note !== undefined ? [internal_note] : []),
            complainant_name, phone, alternative_phone, email,
            local_body_id, ward_id, department, date_filed, req.admin?.id || null, id,
        ]);

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Idea not found.' });
        await logActivity(id, `Idea details updated by admin.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Idea ID ${id} updated`, resource: `ideas/${id}`, severity: 'success' });

        // Check if communication notification was requested
        const isNotify = notify_complainant === true || notify_complainant === 'true';
        let didSendSms = false;
        let didSendEmail = false;
        let finalSms = null;
        let finalEmail = null;

        if (isNotify) {
            const [[currentIdea]] = await pool.query('SELECT complainant_name, phone, email, reference_no, date_filed FROM ideas WHERE id = ?', [id]);
            const targetPhone = (phone || currentIdea?.phone || '').trim();
            const targetEmail = (email || currentIdea?.email || '').trim();
            const targetName = complainant_name || currentIdea?.complainant_name || 'Citizen';
            const refNo = currentIdea?.reference_no || `I-${id}`;
            const dateStr = new Date(date_filed || currentIdea?.date_filed || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

            const channels = Array.isArray(notify_channels)
                ? notify_channels
                : (typeof notify_channels === 'string' ? notify_channels.split(',').map(s => s.trim()) : []);
            const shouldSendSMS = channels.includes('sms') || channels.length === 0;
            const shouldSendEmail = channels.includes('email') || channels.length === 0;

            if (shouldSendSMS && targetPhone) {
                let smsBody = custom_sms_message?.trim() || submissionConfirmationSMS({
                    name: targetName,
                    dateFiled: date_filed || currentIdea?.date_filed || new Date().toISOString().split('T')[0],
                    referenceNo: refNo,
                    statusDetails: status_details,
                    moduleLabel: 'Idea',
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
                let emailBody = custom_email_message?.trim() || `Hi ${targetName},\n\nIdea received: ${dateStr}\n${reviewMsg}\nTracking ID: ${refNo}\n\nOffice of Kothamangalam MLA`;
                emailBody = emailBody
                    .replace(/\[Pending ID\]/g, refNo)
                    .replace(/{reference_no}/g, refNo)
                    .replace(/{date}/g, dateStr)
                    .replace(/{name}/g, targetName)
                    .replace(/^Hi Citizen,/m, `Hi ${targetName},`)
                    .replace(/^Hi Citizen /m, `Hi ${targetName} `);
                sendNotificationEmail({
                    to: targetEmail,
                    subject: `Update on your Idea [${refNo}]`,
                    message: emailBody,
                }).catch(err => console.error('[updateIdea:email]', err.message));
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
                `INSERT INTO idea_updates 
                 (idea_id, type, title, note, admin_user_id, comm_channel, comm_sent_at, sms_sent, sms_body, email_sent, email_body, hide_from_public, created_at)
                 VALUES (?, 'Follow-up', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 0, NOW())`,
                [id, followUpTitle, followUpNote, req.admin?.id || null, commChannel, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail]
            );
            commUpdateId = commUpRes.insertId;

            const commAdminId = req.admin?.id || null;
            if (didSendSms) {
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Idea', id, 'SMS', (phone || '').trim(), finalSms, commAdminId, commUpdateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }
            if (didSendEmail) {
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Idea', id, 'Email', (email || '').trim(), finalEmail, commAdminId, commUpdateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }
        } else if (status_details?.trim()) {
            await pool.query(
                `INSERT INTO idea_updates (idea_id, type, title, note, admin_user_id, created_at) VALUES (?, 'Status Update', ?, ?, ?, NOW())`,
                [id, status_details.trim(), null, req.admin?.id || null]
            );
        }

        const idea = await fetchFullIdea(id);
        res.json({ success: true, message: 'Idea updated.', data: idea });
    } catch (err) {
        console.error('[updateIdea]', err);
        res.status(500).json({ success: false, message: 'Failed to update idea.' });
    }
};

export const updateIdeaStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!status) return res.status(400).json({ success: false, message: 'status is required.' });

        const [result] = await pool.query('UPDATE ideas SET status = ?, updated_by_admin_id = ? WHERE id = ?', [status, req.admin?.id || null, id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Idea not found.' });

        await logActivity(id, `Status changed to "${status}".`, req.admin?.id);
        res.json({ success: true, message: `Status updated to ${status}.` });
    } catch (err) {
        console.error('[updateIdeaStatus]', err);
        res.status(500).json({ success: false, message: 'Failed to update status.' });
    }
};

export const trashIdea = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query(
            'UPDATE ideas SET is_deleted = 1, deleted_at = NOW() WHERE id = ? AND is_deleted = 0', [id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Idea not found or already trashed.' });
        await logActivity(id, 'Idea moved to trash.', req.admin?.id);
        auditLog(req, { action: 'Archived', module: 'Ideas', details: `Idea ID ${id} moved to trash`, resource: `ideas/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Idea moved to trash.' });
    } catch (err) {
        console.error('[trashIdea]', err);
        res.status(500).json({ success: false, message: 'Failed to trash idea.' });
    }
};

export const restoreIdea = async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await pool.query(
            'UPDATE ideas SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1', [id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Idea not found in trash.' });
        await logActivity(id, 'Idea restored from trash.', req.admin?.id);
        res.json({ success: true, message: 'Idea restored successfully.' });
    } catch (err) {
        console.error('[restoreIdea]', err);
        res.status(500).json({ success: false, message: 'Failed to restore idea.' });
    }
};

export const deleteIdea = async (req, res) => {
    try {
        const { id } = req.params;

        const [result] = await pool.query(
            'UPDATE ideas SET is_deleted = 1, deleted_at = NOW(), updated_by_admin_id = ? WHERE id = ?',
            [req.admin?.id || null, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Idea not found.' });

        await logActivity(id, 'Idea moved to Trash', req.admin?.id);
        auditLog(req, { action: 'Trashed', module: 'Ideas', details: `Idea ID ${id} moved to trash`, resource: `ideas/${id}`, severity: 'info' });
        res.json({ success: true, message: 'Idea moved to trash.' });
    } catch (err) {
        console.error('[deleteIdea]', err);
        res.status(500).json({ success: false, message: 'Failed to delete idea.' });
    }
};

export const addIdeaUpdate = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, title, note, notify_complainant, custom_sms_message, custom_email_message, notify_channels, hide_from_public } = req.body;
        if (!title) return res.status(400).json({ success: false, message: 'title is required.' });

        const isHidden = (hide_from_public === '1' || hide_from_public === 'true' || hide_from_public === 1 || hide_from_public === true) ? 1 : 0;

        const [result] = await pool.query(
            'INSERT INTO idea_updates (idea_id, type, title, note, admin_user_id, hide_from_public) VALUES (?,?,?,?,?,?)',
            [id, type || 'Status Update', title, note || null, req.admin?.id || null, isHidden]
        );
        const updateId = result.insertId;

        if (req.files && req.files['media'] && req.files['media'].length > 0) {
            const rows = req.files['media'].map(f => {
                const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
                return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, Math.round(f.size / 1024), updateId];
            });
            await pool.query(
                'INSERT INTO idea_media (idea_id, media_type, file_url, caption, file_name, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
            const rows = req.files['attachments'].map(f => [
                id, f.originalname, f.location, f.mimetype, Math.round(f.size / 1024), updateId
            ]);
            await pool.query(
                'INSERT INTO idea_attachments (idea_id, file_name, file_url, file_type, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        await logActivity(id, `Update added: "${title}"`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Added update to Idea ID ${id}`, resource: `ideas/${id}`, severity: 'info' });

        // Fire-and-forget: SMS/Email follow-up if admin chose to notify complainant
        if (notify_complainant === 'true' || notify_complainant === true) {
            let channels = [];
            try {
                if (notify_channels) channels = JSON.parse(notify_channels);
            } catch (e) {}

            const [[rec]] = await pool.query(
                'SELECT complainant_name, email, phone, reference_no, COALESCE(date_filed, created_at) AS date_filed FROM ideas WHERE id = ?', [id]
            );

            let didSendSms = false;
            let didSendEmail = false;
            let finalSms = null;
            let finalEmail = null;

            // Send SMS if selected
            if (rec?.phone && channels.includes('sms')) {
                finalSms = custom_sms_message?.trim() || followUpUpdateSMS({
                    name: rec.complainant_name,
                    referenceNo: rec.reference_no,
                    statusTitle: title,
                    moduleLabel: 'Idea',
                    updateDate: new Date(),
                    dateFiled: rec.date_filed,
                });
                sendSMSSafe(rec.phone, finalSms);
                didSendSms = true;
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Idea', id, 'SMS', rec.phone.trim(), finalSms, req.admin?.id || null, updateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }

            // Send Email if selected
            if (rec?.email && channels.includes('email') && custom_email_message?.trim()) {
                finalEmail = custom_email_message.trim();
                sendNotificationEmail({
                    to: rec.email,
                    subject: `Update on your Idea ${rec.reference_no || ''}`,
                    message: finalEmail
                }).catch(err => console.error('[addIdeaUpdate Email Error]', err));
                didSendEmail = true;
                await pool.query(
                    `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    ['Idea', id, 'Email', rec.email.trim(), finalEmail, req.admin?.id || null, updateId]
                ).catch(err => console.warn('[Log failed]', err.message));
            }

            if (didSendSms || didSendEmail) {
                const commChannel = (didSendSms && didSendEmail) ? 'both' : (didSendSms ? 'sms' : 'email');
                const now = new Date();
                await pool.query(
                    `UPDATE idea_updates 
                     SET comm_channel = ?, comm_sent_at = ?, sms_sent = ?, sms_body = ?, email_sent = ?, email_body = ?
                     WHERE id = ?`,
                    [commChannel, now, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail, updateId]
                ).catch(err => console.warn('[comm update failed]', err.message));
            }
        }

        const [[row]] = await pool.query('SELECT * FROM idea_updates WHERE id = ?', [updateId]);
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        console.error('[addIdeaUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to add update.' });
    }
};

export const editIdeaUpdate = async (req, res) => {
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
            `UPDATE idea_updates SET ${updateFields.join(', ')} WHERE id = ? AND idea_id = ?`,
            updateParams
        );

        let retainedMedia = [];
        let retainedAttachments = [];
        try { if (retained_media_ids) retainedMedia = JSON.parse(retained_media_ids); } catch(e){}
        try { if (retained_attachment_ids) retainedAttachments = JSON.parse(retained_attachment_ids); } catch(e){}

        const [currentMedia] = await pool.query('SELECT id, file_url FROM idea_media WHERE update_id = ?', [updateId]);
        const mediaToDelete = currentMedia.filter(m => !retainedMedia.includes(m.id));
        if (mediaToDelete.length > 0) {
            const idsToDelete = mediaToDelete.map(m => m.id);
            await Promise.all(mediaToDelete.map(m => deleteS3Object(m.file_url)));
            await pool.query('DELETE FROM idea_media WHERE id IN (?)', [idsToDelete]);
        }

        const [currentAtt] = await pool.query('SELECT id, file_url FROM idea_attachments WHERE update_id = ?', [updateId]);
        const attToDelete = currentAtt.filter(m => !retainedAttachments.includes(m.id));
        if (attToDelete.length > 0) {
            const idsToDelete = attToDelete.map(m => m.id);
            await Promise.all(attToDelete.map(m => deleteS3Object(m.file_url)));
            await pool.query('DELETE FROM idea_attachments WHERE id IN (?)', [idsToDelete]);
        }

        if (req.files && req.files['media'] && req.files['media'].length > 0) {
            const rows = req.files['media'].map(f => {
                const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
                return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, Math.round(f.size / 1024), updateId];
            });
            await pool.query(
                'INSERT INTO idea_media (idea_id, media_type, file_url, caption, file_name, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }

        if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
            const rows = req.files['attachments'].map(f => [
                id, f.originalname, f.location, f.mimetype, Math.round(f.size / 1024), updateId
            ]);
            await pool.query(
                'INSERT INTO idea_attachments (idea_id, file_name, file_url, file_type, file_size_kb, update_id) VALUES ?',
                [rows]
            );
        }
        
        await logActivity(id, `An update was edited: ${title}`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Edited update on Idea ID ${id}`, resource: `ideas/${id}`, severity: 'info' });

        res.json({ success: true, message: 'Update edited successfully.' });
    } catch (err) {
        console.error('[editIdeaUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to edit update.' });
    }
};

export const deleteIdeaUpdate = async (req, res) => {
    try {
        const { id, updateId } = req.params;
        const [result] = await pool.query(
            'DELETE FROM idea_updates WHERE id = ? AND idea_id = ?', [updateId, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Update not found.' });
        await logActivity(id, `An update entry was removed.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Removed update from Idea ID ${id}`, resource: `ideas/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Update deleted.' });
    } catch (err) {
        console.error('[deleteIdeaUpdate]', err);
        res.status(500).json({ success: false, message: 'Failed to delete update.' });
    }
};

export const uploadIdeaMedia = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.files?.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });

        const rows = req.files.map(f => {
            const isVideo = f.mimetype.startsWith('video/') || !!f.originalname.match(/\.(mp4|mov|avi|webm|mkv)$/i);
            const sizeKb = Math.round(f.size / 1024);
            return [id, isVideo ? 'video' : 'photo', f.location, f.originalname, f.originalname, sizeKb];
        });

        await pool.query(
            'INSERT INTO idea_media (idea_id, media_type, file_url, caption, file_name, file_size_kb) VALUES ?',
            [rows]
        );
        await logActivity(id, `${req.files.length} media file(s) uploaded.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Uploaded ${req.files.length} media file(s) to Idea ID ${id}`, resource: `ideas/${id}`, severity: 'info' });

        const [media] = await pool.query('SELECT * FROM idea_media WHERE idea_id = ? ORDER BY created_at ASC', [id]);
        res.status(201).json({ success: true, data: media });
    } catch (err) {
        console.error('[uploadIdeaMedia]', err);
        res.status(500).json({ success: false, message: 'Failed to upload media.' });
    }
};

export const deleteIdeaMedia = async (req, res) => {
    try {
        const { id, mediaId } = req.params;
        const [[row]] = await pool.query('SELECT file_url FROM idea_media WHERE id = ? AND idea_id = ?', [mediaId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Media not found.' });

        await deleteS3Object(row.file_url);
        await pool.query('DELETE FROM idea_media WHERE id = ?', [mediaId]);
        await logActivity(id, 'A media file was removed.', req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Removed media from Idea ID ${id}`, resource: `ideas/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Media deleted.' });
    } catch (err) {
        console.error('[deleteIdeaMedia]', err);
        res.status(500).json({ success: false, message: 'Failed to delete media.' });
    }
};

export const uploadIdeaAttachment = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.files?.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });

        const rows = req.files.map(f => {
            const ext = f.originalname.split('.').pop()?.toLowerCase() || '';
            const sizeKb = Math.round(f.size / 1024);
            return [id, f.originalname, f.location, ext, sizeKb];
        });

        await pool.query(
            'INSERT INTO idea_attachments (idea_id, file_name, file_url, file_type, file_size_kb) VALUES ?',
            [rows]
        );
        await logActivity(id, `${req.files.length} attachment(s) uploaded.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Uploaded ${req.files.length} attachment(s) to Idea ID ${id}`, resource: `ideas/${id}`, severity: 'info' });

        const [attachments] = await pool.query('SELECT * FROM idea_attachments WHERE idea_id = ? ORDER BY created_at ASC', [id]);
        res.status(201).json({ success: true, data: attachments });
    } catch (err) {
        console.error('[uploadIdeaAttachment]', err);
        res.status(500).json({ success: false, message: 'Failed to upload attachment.' });
    }
};

export const deleteIdeaAttachment = async (req, res) => {
    try {
        const { id, attachId } = req.params;
        const [[row]] = await pool.query('SELECT file_url FROM idea_attachments WHERE id = ? AND idea_id = ?', [attachId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Attachment not found.' });

        await deleteS3Object(row.file_url);
        await pool.query('DELETE FROM idea_attachments WHERE id = ?', [attachId]);
        await logActivity(id, 'An attachment was removed.', req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Removed attachment from Idea ID ${id}`, resource: `ideas/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Attachment deleted.' });
    } catch (err) {
        console.error('[deleteIdeaAttachment]', err);
        res.status(500).json({ success: false, message: 'Failed to delete attachment.' });
    }
};

export const addIdeaTeamMember = async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_user_id, role_label } = req.body;
        if (!admin_user_id) return res.status(400).json({ success: false, message: 'admin_user_id is required.' });

        const [[adminUser]] = await pool.query('SELECT id, full_name FROM admin_users WHERE id = ?', [admin_user_id]);
        if (!adminUser) return res.status(404).json({ success: false, message: 'Admin user not found.' });

        try {
            const [result] = await pool.query(
                'INSERT INTO idea_team (idea_id, admin_user_id, role_label) VALUES (?,?,?)',
                [id, admin_user_id, role_label || null]
            );
            await logActivity(id, `Team member "${adminUser.full_name}" added${role_label ? ` as ${role_label}` : ''}.`, req.admin?.id);
            auditLog(req, { action: 'Updated', module: 'Ideas', details: `Added team member "${adminUser.full_name}" to Idea ID ${id}`, resource: `ideas/${id}`, severity: 'info' });
            const [[row]] = await pool.query(`
                SELECT it.id, it.role_label, it.created_at,
                       au.id as admin_user_id, au.full_name as name, au.email
                FROM idea_team it
                JOIN admin_users au ON it.admin_user_id = au.id
                WHERE it.id = ?
            `, [result.insertId]);
            res.status(201).json({ success: true, data: row });
        } catch (dupErr) {
            if (dupErr.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, message: 'This admin is already in the team.' });
            }
            throw dupErr;
        }
    } catch (err) {
        console.error('[addIdeaTeamMember]', err);
        res.status(500).json({ success: false, message: 'Failed to add team member.' });
    }
};

export const removeIdeaTeamMember = async (req, res) => {
    try {
        const { id, memberId } = req.params;
        const [[row]] = await pool.query(`
            SELECT it.id, au.full_name
            FROM idea_team it JOIN admin_users au ON it.admin_user_id = au.id
            WHERE it.id = ? AND it.idea_id = ?
        `, [memberId, id]);
        if (!row) return res.status(404).json({ success: false, message: 'Team member not found.' });

        await pool.query('DELETE FROM idea_team WHERE id = ?', [memberId]);
        await logActivity(id, `Team member "${row.full_name}" removed.`, req.admin?.id);
        auditLog(req, { action: 'Updated', module: 'Ideas', details: `Removed team member "${row.full_name}" from Idea ID ${id}`, resource: `ideas/${id}`, severity: 'warning' });
        res.json({ success: true, message: 'Team member removed.' });
    } catch (err) {
        console.error('[removeIdeaTeamMember]', err);
        res.status(500).json({ success: false, message: 'Failed to remove team member.' });
    }
};

export const getIdeaCategories = async (req, res) => {
    try {
        const cats = ['Infrastructure', 'Education', 'Healthcare', 'Environment', 'Employment', 'Welfare', 'Other'];
        res.json({ success: true, data: cats.map((name, i) => ({ id: i + 1, name, status: 'Active' })) });
    } catch (err) {
        console.error('[getIdeaCategories]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch categories.' });
    }
};
