import pool from '../configs/db.js';
import generateCMFundsPdf from '../utils/cmFundsPdfTemplate.js';
import { logActivity as auditLog } from './teamsLogController.js';
import { broadcastNotification, createNotification } from '../utils/notificationHelper.js';
import { sendSMSSafe } from '../services/smsService.js';
import { followUpUpdateSMS, submissionConfirmationSMS } from '../services/smsTemplates.js';
import { sendNotificationEmail } from '../utils/email.js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

const parseDateToYMD = (val) => {
  if (!val || val === '—' || val === 'null' || val === 'undefined') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) return String(val).trim();
  const cleaned = String(val).trim().replace(/Sept/i, 'Sep');
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Helper to resolve raw category input (which could be an ID in cm_fund_categories,
 * an ID in mla_dropdown_lists, or a category name string) to a valid cm_fund_categories(id)
 * or NULL if invalid.
 */
async function resolveCategoryId(connection, rawCategoryId, applicationType = 'General') {
  if (!rawCategoryId || rawCategoryId === 'undefined' || rawCategoryId === 'null') return null;

  // 1. Check if rawCategoryId exists directly in cm_fund_categories
  const [existing] = await connection.query('SELECT id FROM cm_fund_categories WHERE id = ?', [rawCategoryId]);
  if (existing.length > 0) return existing[0].id;

  // 2. If rawCategoryId is numeric, check if it matches an option in mla_dropdown_lists
  let categoryName = String(rawCategoryId).trim();
  if (!isNaN(rawCategoryId)) {
    const [dropOpt] = await connection.query('SELECT value FROM mla_dropdown_lists WHERE id = ?', [rawCategoryId]);
    if (dropOpt.length > 0) {
      categoryName = dropOpt[0].value;
    }
  }

  // 3. Search cm_fund_categories by name (first preferring matching application_type)
  const normType = applicationType ? applicationType.trim() : 'General';
  const [byNameType] = await connection.query(
    'SELECT id FROM cm_fund_categories WHERE name = ? AND application_type = ? LIMIT 1',
    [categoryName, normType]
  );
  if (byNameType.length > 0) return byNameType[0].id;

  const [byName] = await connection.query('SELECT id FROM cm_fund_categories WHERE name = ? LIMIT 1', [categoryName]);
  if (byName.length > 0) return byName[0].id;

  // 4. If not found, attempt to insert into cm_fund_categories so foreign key constraint succeeds
  try {
    const [ins] = await connection.query(
      'INSERT INTO cm_fund_categories (name, application_type) VALUES (?, ?)',
      [categoryName, normType]
    );
    return ins.insertId;
  } catch (e) {
    console.warn('[resolveCategoryId] Fallback lookup failed:', e.message);
    return null;
  }
}

const generateAppId = async (connection, applicationType) => {
  const typeUpper = (applicationType || '').toUpperCase().trim();
  const isCmdrf = typeUpper === 'CMDRF' || typeUpper === 'CM FUND';
  const prefix = isCmdrf ? 'CM-' : 'A-';

  const [rows] = await connection.query(
    `SELECT id FROM cm_fund_requests WHERE id LIKE ? ORDER BY CAST(SUBSTR(id, ?) AS UNSIGNED) DESC LIMIT 1`,
    [`${prefix}%`, prefix.length + 1]
  );

  let nextNum = 1;
  if (rows.length > 0) {
    const lastId = rows[0].id;
    const lastNumStr = lastId.replace(prefix, '');
    const lastNum = parseInt(lastNumStr, 10);
    if (!isNaN(lastNum)) {
      nextNum = lastNum + 1;
    }
  }

  const paddedNum = nextNum.toString().padStart(3, '0');
  return `${prefix}${paddedNum}`;
};

export const getNextAppId = async (req, res) => {
  try {
    const { application_type } = req.query;
    const nextId = await generateAppId(pool, application_type || 'CMDRF');
    res.json({ nextId });
  } catch (err) {
    console.error('Error getting next application ID:', err);
    res.status(500).json({ error: 'Failed to generate application ID' });
  }
};

export const expandApplicationTypes = (rawAppType) => {
  if (!rawAppType || rawAppType === 'All') return null;
  const appTypes = String(rawAppType).split(',').map(t => t.trim()).filter(Boolean);
  const expandedTypes = new Set(appTypes);
  appTypes.forEach(t => {
    const lower = t.toLowerCase().trim();
    const clean = lower.replace(/[^a-z]/g, '');
    if (clean === 'tgrants' || clean === 'tgrantz') {
      expandedTypes.add('T-Grants');
      expandedTypes.add('T Grants');
      expandedTypes.add('TGrantz');
      expandedTypes.add('T-Grantz');
      expandedTypes.add('t- grantz');
    } else if (clean === 'cmdrf' || clean === 'cmfund' || lower === 'cm fund' || lower === 'aid') {
      expandedTypes.add('CMDRF');
      expandedTypes.add('CM Fund');
      expandedTypes.add('CM Relief Fund');
      expandedTypes.add('Aid');
    } else if (clean === 'mlafund' || clean === 'mla' || lower === 'mla fund') {
      expandedTypes.add('MLA Fund');
      expandedTypes.add('mlafund');
      expandedTypes.add('MLA-Fund');
    } else if (clean === 'general') {
      expandedTypes.add('General');
      expandedTypes.add('general');
      expandedTypes.add('General Application');
    }
  });
  return Array.from(expandedTypes);
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

// Helper: parse amount range string e.g. "Under ₹10,000", "₹10,000 – ₹25,000", "Above ₹1,00,000"
const parseAmountRange = (rangeStr) => {
  if (!rangeStr) return null;
  const s = String(rangeStr).replace(/[₹,]/g, '').trim();
  if (/under\s+(\d+)/i.test(s)) {
    const m = s.match(/under\s+(\d+)/i);
    return { min: 0, max: Number(m[1]) };
  }
  if (/above\s+(\d+)/i.test(s)) {
    const m = s.match(/above\s+(\d+)/i);
    return { min: Number(m[1]), max: null };
  }
  const match = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (match) {
    return { min: Number(match[1]), max: Number(match[2]) };
  }
  return null;
};

export const listRequests = async (req, res) => {
  try {
    const {
      status, priority, search, search_field, searchField, sort, order,
      application_type, applicationType,
      category, category_id,
      local_body_id, localBody,
      ward_id, ward,
      district,
      assigned_officer_id, assignedOfficer,
      created_by, createdBy,
      has_documents, hasDocuments,
      has_audio_notes, hasAudioNotes,
      phone_number, hasPhone,
      email_filter, hasEmail,
      communication_send, communicationSend,
      recommended_by, recommendedBy,
      amount_range, requestedAmountRange,
      startDate, endDate,
      page = 1, limit = 8
    } = req.query;

    const isTrash = req.query.is_deleted === '1' || req.query.trash === 'true';

    let baseQuery = `
      SELECT r.*,
             c.name as category_name,
             u.full_name as submitted_by_name,
             o.full_name as assigned_officer_name,
             d.full_name as deleted_by_name,
             lb.name as local_body_name,
             w.ward_no as ward_no,
             w.place_name as ward_place_name,
             IF(w.ward_no IS NOT NULL, 
                IF(w.place_name IS NOT NULL AND TRIM(w.place_name) != '', 
                   CONCAT('Ward ', w.ward_no, ' - ', w.place_name), 
                   CONCAT('Ward ', w.ward_no)
                ), 
                w.place_name
             ) as ward_name,
             (SELECT JSON_OBJECT(
                 'id', id, 'type', type, 'title', title, 'created_at', created_at
              ) FROM cm_fund_updates WHERE request_id = r.id AND type != 'Communication' ORDER BY created_at DESC LIMIT 1) as last_update,
             (SELECT JSON_OBJECT(
                 'id', cl1.id,
                 'channels', (
                     SELECT GROUP_CONCAT(DISTINCT cl2.channel)
                     FROM communications_logs cl2
                     WHERE cl2.entity_type = 'Application' AND cl2.entity_id = r.id
                     AND cl2.created_at >= cl1.created_at - INTERVAL 1 MINUTE
                     AND cl2.created_at <= cl1.created_at + INTERVAL 1 MINUTE
                 ),
                 'created_at', cl1.created_at
              ) FROM communications_logs cl1 WHERE cl1.entity_type = 'Application' AND cl1.entity_id = r.id ORDER BY cl1.created_at DESC LIMIT 1) as last_communication,
             (SELECT JSON_OBJECT(
                 'scheduled_at', j.scheduled_at,
                 'channels', j.channels
              ) FROM bulk_send_jobs j 
                WHERE j.status = 'scheduled' 
                AND JSON_CONTAINS(j.payload, JSON_OBJECT('id', r.id, 'module', 'F-'), '$.contacts') = 1
                ORDER BY j.scheduled_at ASC LIMIT 1
             ) as scheduled_communication
      FROM cm_fund_requests r
      LEFT JOIN cm_fund_categories c ON r.category_id = c.id
      LEFT JOIN admin_users u ON r.submitted_by_id = u.id
      LEFT JOIN admin_users o ON r.assigned_officer_id = o.id
      LEFT JOIN admin_users d ON r.deleted_by_id = d.id
      LEFT JOIN local_bodies lb ON r.local_body_id = lb.id
      LEFT JOIN local_body_wards w ON r.ward_id = w.id
      WHERE r.is_deleted = ?
    `;
    const queryParams = [isTrash ? 1 : 0];

    if (!isTrash && status && status !== 'All') {
      const statuses = status.split(',');
      if (statuses.length === 1) {
        baseQuery += ` AND r.status = ?`;
        queryParams.push(statuses[0]);
      } else {
        baseQuery += ` AND r.status IN (?)`;
        queryParams.push(statuses);
      }
    }
    if (priority && priority !== 'All') {
      const priorities = priority.split(',');
      baseQuery += ` AND r.priority IN (?)`;
      queryParams.push(priorities);
    }

    const rawAppType = application_type || applicationType;
    const expandedAppTypes = expandApplicationTypes(rawAppType);
    if (expandedAppTypes && expandedAppTypes.length > 0) {
      baseQuery += ` AND r.application_type IN (?)`;
      queryParams.push(expandedAppTypes);
    }

    const rawCategory = category || category_id;
    if (rawCategory && rawCategory !== 'All') {
      const cats = rawCategory.split(',');
      baseQuery += ` AND (r.category_id IN (?) OR c.name IN (?))`;
      queryParams.push(cats, cats);
    }

    const rawSubcategory = req.query.subcategory || req.query.sub_category;
    if (rawSubcategory && rawSubcategory !== 'All') {
      const subcats = rawSubcategory.split(',');
      baseQuery += ` AND r.sub_category IN (?)`;
      queryParams.push(subcats);
    }

    const rawLocalBody = local_body_id || localBody;
    if (rawLocalBody && rawLocalBody !== 'All') {
      const lbs = rawLocalBody.split(',');
      baseQuery += ` AND r.local_body_id IN (?)`;
      queryParams.push(lbs);
    }

    const rawWard = ward_id || ward;
    if (rawWard && rawWard !== 'All') {
      const wards = rawWard.split(',');
      baseQuery += ` AND r.ward_id IN (?)`;
      queryParams.push(wards);
    }

    const rawSource = req.query.submission_source || req.query.source;
    if (rawSource && rawSource !== 'All') {
      const sources = rawSource.split(',');
      baseQuery += ` AND r.submission_source IN (?)`;
      queryParams.push(sources);
    }

    // District filter
    if (district && district !== 'All') {
      const districts = district.split(',');
      baseQuery += ` AND r.district IN (?)`;
      queryParams.push(districts);
    }

    // Assigned Officer filter
    const rawOfficer = assigned_officer_id || assignedOfficer || req.query.assigned_officer;
    if (rawOfficer && rawOfficer !== 'All') {
      const officers = rawOfficer.split(',');
      baseQuery += ` AND r.assigned_officer_id IN (?)`;
      queryParams.push(officers);
    }

    // Created By admin filter
    const rawCreatedBy = created_by || createdBy;
    if (rawCreatedBy && rawCreatedBy !== 'All') {
      const creators = rawCreatedBy.split(',');
      baseQuery += ` AND r.submitted_by_id IN (?)`;
      queryParams.push(creators);
    }

    // Has Documents
    const hasDocs = has_documents || hasDocuments;
    if (hasDocs === 'Yes') {
      baseQuery += ` AND EXISTS (SELECT 1 FROM cm_fund_request_documents d WHERE d.request_id = r.id LIMIT 1)`;
    } else if (hasDocs === 'No') {
      baseQuery += ` AND NOT EXISTS (SELECT 1 FROM cm_fund_request_documents d WHERE d.request_id = r.id LIMIT 1)`;
    }

    // Has Audio Notes
    const hasAudio = has_audio_notes || hasAudioNotes;
    if (hasAudio === 'Yes') {
      baseQuery += ` AND EXISTS (SELECT 1 FROM cm_fund_request_documents d WHERE d.request_id = r.id AND d.doc_type_id = 'doc_audio_note' LIMIT 1)`;
    } else if (hasAudio === 'No') {
      baseQuery += ` AND NOT EXISTS (SELECT 1 FROM cm_fund_request_documents d WHERE d.request_id = r.id AND d.doc_type_id = 'doc_audio_note' LIMIT 1)`;
    }

    // Has Phone
    const hasPh = phone_number || hasPhone;
    if (hasPh === 'Yes') {
      baseQuery += ` AND (r.applicant_phone IS NOT NULL AND r.applicant_phone != '')`;
    } else if (hasPh === 'No') {
      baseQuery += ` AND (r.applicant_phone IS NULL OR r.applicant_phone = '')`;
    }

    // Has Email
    const hasEm = email_filter || hasEmail;
    if (hasEm === 'Yes') {
      baseQuery += ` AND (r.email IS NOT NULL AND r.email != '')`;
    } else if (hasEm === 'No') {
      baseQuery += ` AND (r.email IS NULL OR r.email = '')`;
    }

    // Communication Sent
    const commSend = communication_send || communicationSend;
    if (commSend && commSend !== 'All') {
      if (commSend === 'Never Sent') {
        baseQuery += ` AND NOT EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = 'Application' AND cl.entity_id = r.id LIMIT 1)`;
      } else {
        const days = parseDayLabel(commSend);
        if (days) {
          baseQuery += ` AND EXISTS (SELECT 1 FROM communications_logs cl WHERE cl.entity_type = 'Application' AND cl.entity_id = r.id AND cl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1)`;
          queryParams.push(days);
        }
      }
    }

    // Recommended By
    const rawRec = recommended_by || recommendedBy;
    if (rawRec && rawRec !== 'All') {
      const recs = rawRec.split(',');
      baseQuery += ` AND r.recommended_by IN (?)`;
      queryParams.push(recs);
    }

    // Requested Amount Range
    const rawAmountRange = amount_range || requestedAmountRange;
    if (rawAmountRange && rawAmountRange !== 'All') {
      const ranges = String(rawAmountRange).split(',').map(parseAmountRange).filter(Boolean);
      if (ranges.length > 0) {
        const rangeClauses = [];
        ranges.forEach(r => {
          if (r.max === null) {
            rangeClauses.push('r.amount_requested >= ?');
            queryParams.push(r.min);
          } else {
            rangeClauses.push('r.amount_requested BETWEEN ? AND ?');
            queryParams.push(r.min, r.max);
          }
        });
        baseQuery += ` AND (${rangeClauses.join(' OR ')})`;
      }
    }

    if (startDate) {
      baseQuery += ` AND COALESCE(r.date_filed, DATE(CONVERT_TZ(r.created_at, '+00:00', '+05:30'))) >= ?`;
      queryParams.push(startDate);
    }

    if (endDate) {
      baseQuery += ` AND COALESCE(r.date_filed, DATE(CONVERT_TZ(r.created_at, '+00:00', '+05:30'))) <= ?`;
      queryParams.push(endDate);
    }

    if (search) {
      const q = search.trim();
      const field = (search_field || searchField || 'all').toLowerCase();

      switch (field) {
        case 'id':
          baseQuery += ` AND (r.id = ? OR r.id LIKE ?)`;
          queryParams.push(q, `${q}%`);
          break;
        case 'phone':
        case 'number':
          const cleanPhone = q.replace(/[^0-9]/g, '');
          baseQuery += ` AND (r.applicant_phone LIKE ? OR r.alternate_phone LIKE ?)`;
          queryParams.push(`%${cleanPhone || q}%`, `%${cleanPhone || q}%`);
          break;
        case 'email':
          baseQuery += ` AND (r.applicant_name LIKE ? OR r.description LIKE ?)`;
          queryParams.push(`%${q}%`, `%${q}%`);
          break;
        case 'name':
          baseQuery += ` AND (r.applicant_name LIKE ? OR MATCH(r.applicant_name, r.address_line1, r.address, r.location) AGAINST(? IN BOOLEAN MODE))`;
          queryParams.push(`%${q}%`, `+${q}*`);
          break;
        case 'house_name':
        case 'address':
        case 'location':
          baseQuery += ` AND (r.address_line1 LIKE ? OR r.address LIKE ? OR r.location LIKE ? OR MATCH(r.applicant_name, r.address_line1, r.address, r.location) AGAINST(? IN BOOLEAN MODE))`;
          queryParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `+${q}*`);
          break;
        case 'all':
        default:
          baseQuery += ` AND (
            r.applicant_name LIKE ? OR 
            r.id LIKE ? OR 
            r.applicant_phone LIKE ? OR 
            r.alternate_phone LIKE ? OR
            r.application_title LIKE ? OR 
            r.application_type LIKE ? OR 
            c.name LIKE ? OR 
            r.sub_category LIKE ? OR 
            lb.name LIKE ? OR 
            w.place_name LIKE ? OR 
            o.full_name LIKE ? OR
            MATCH(r.applicant_name, r.address_line1, r.address, r.location) AGAINST(? IN BOOLEAN MODE)
          )`;
          const s = `%${q}%`;
          queryParams.push(s, s, s, s, s, s, s, s, s, s, s, `${q}*`);
          break;
      }
    }

    // Support both legacy aliases and new sort=<col>&order=<dir> style
    const SORT_COLS = {
      created_at: 'r.created_at',
      updated_at: 'r.updated_at',
      applicant_name: 'r.applicant_name',
      amount_requested: 'r.amount_requested',
      priority: 'r.priority',
      submitted_by_name: 'u.full_name',
    };
    let orderClause = 'ORDER BY r.created_at DESC';
    if (SORT_COLS[sort]) {
      orderClause = `ORDER BY ${SORT_COLS[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}`;
    } else if (sort === 'newest') {
      orderClause = 'ORDER BY r.created_at DESC';
    } else if (sort === 'oldest') {
      orderClause = 'ORDER BY r.created_at ASC';
    } else if (sort === 'amount_desc') {
      orderClause = 'ORDER BY r.amount_requested DESC';
    } else if (sort === 'amount_asc') {
      orderClause = 'ORDER BY r.amount_requested ASC';
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Total count query
    const countQuery = `SELECT COUNT(*) as total FROM (${baseQuery}) as t`;
    const [countRows] = await pool.query(countQuery, queryParams);
    const total = countRows[0].total;

    // Data query
    const dataQuery = `${baseQuery} ${orderClause} LIMIT ? OFFSET ?`;
    const [data] = await pool.query(dataQuery, [...queryParams, parseInt(limit), offset]);

    // Status counts — scoped to application type and deletion status
    let statusCountsQuery = `
      SELECT status, COUNT(*) as count 
      FROM cm_fund_requests 
      WHERE is_deleted = ?
    `;
    const statusCountsParams = [isTrash ? 1 : 0];

    if (expandedAppTypes && expandedAppTypes.length > 0) {
      statusCountsQuery += ` AND application_type IN (?)`;
      statusCountsParams.push(expandedAppTypes);
    }
    statusCountsQuery += ` GROUP BY status`;

    const [statusRows] = await pool.query(statusCountsQuery, statusCountsParams);

    const counts = { all: 0 };
    let totalCount = 0;
    statusRows.forEach(row => {
      const cnt = parseInt(row.count, 10);
      totalCount += cnt;
      counts[row.status] = cnt;
    });
    counts.all = totalCount;

    // Type-scoped draft count for the Drafts tab
    let draftCountQuery = `
      SELECT COUNT(*) as count 
      FROM cm_fund_requests 
      WHERE is_deleted = 0 AND status = 'Draft'
    `;
    const draftCountParams = [];
    if (expandedAppTypes && expandedAppTypes.length > 0) {
      draftCountQuery += ` AND application_type IN (?)`;
      draftCountParams.push(expandedAppTypes);
    }
    const [draftCountRows] = await pool.query(draftCountQuery, draftCountParams);
    const draftCount = draftCountRows[0]?.count || 0;
    counts.Drafts = draftCount;
    counts.Draft = draftCount;

    res.json({
      data,
      total,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      },
      counts,
      draftCount
    });
  } catch (err) {
    console.error('Error in listRequests:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
};

export const listRequestsByType = (targetType) => {
  return async (req, res) => {
    req.query.application_type = targetType;
    return listRequests(req, res);
  };
};

export const listCmdrfRequests = listRequestsByType('CMDRF');
export const listMlaFundRequests = listRequestsByType('MLA Fund');
export const listGeneralRequests = listRequestsByType('General');
export const listTGrantsRequests = listRequestsByType('T-Grants');

export const getDraftCounts = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT application_type, COUNT(*) as count 
      FROM cm_fund_requests 
      WHERE is_deleted = 0 AND status = 'Draft'
      GROUP BY application_type
    `);

    const counts = {
      all: 0,
      CMDRF: 0,
      'MLA Fund': 0,
      General: 0,
      'T-Grants': 0
    };

    rows.forEach(r => {
      const type = r.application_type;
      const count = parseInt(r.count, 10);
      counts.all += count;
      if (type === 'CMDRF') counts.CMDRF = count;
      else if (type === 'General') counts.General = count;
      else if (type === 'MLA Fund') counts['MLA Fund'] = count;
      else if (type === 'T-Grants' || type === 'T Grants') counts['T-Grants'] += count;
    });

    res.json({ success: true, data: counts });
  } catch (err) {
    console.error('Error getting draft counts:', err);
    res.status(500).json({ error: 'Failed to get draft counts' });
  }
};

export const createRequest = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Accept both snake_case (FormData from frontend) and camelCase
    const b = req.body;
    const applicationTitle = b.application_title || b.applicationTitle || null;
    const applicantName = b.applicant_name || b.applicantName;
    const applicationType = b.application_type || b.applicationType || 'CMDRF';
    const applicantPhone = b.applicant_phone || b.applicantPhone || '';
    const email = b.email || b.applicant_email || b.applicantEmail || null;
    const alternatePhone = b.alternate_phone || b.alternatePhone || null;
    const aadhaarNumber = b.aadhaar_number || b.aadhaarNumber || null;
    const rationCardNumber = b.ration_card_number || b.rationCardNumber || null;
    const panCardNumber = b.pan_card_number || b.panCardNumber || null;
    const localBody = b.local_body || b.localBody || null;
    const ward = b.ward || null;
    const addressLine1 = b.address_line1 || b.addressLine1 || '';
    const addressLine2 = b.address_line2 || b.addressLine2 || null;
    const address = b.address || null;
    const location = b.location || null;
    const latitude = b.latitude || null;
    const longitude = b.longitude || null;
    const city = b.city || '';
    const district = b.district || '';
    const state = b.state || 'Kerala';
    const pincode = b.pincode || '';
    const rawCategoryId = b.category_id || b.category;
    const categoryId = await resolveCategoryId(pool, rawCategoryId, applicationType);
    const subCategory = b.sub_category || b.subCategory || null;
    const priority = b.priority || 'Normal';
    const amountRequested = b.amount_requested || b.amountRequested || null;
    const description = b.description || '';
    const bankName = b.bank_name || b.bankName || '';
    const accountNumber = b.account_number || b.accountNumber || '';
    const ifscCode = b.ifsc_code || b.ifscCode || '';
    const branch = b.branch || '';
    const accountHolderName = b.account_holder_name || b.accountHolderName || '';
    const recommendedBy = b.recommended_by || b.recommendedBy || '';
    const recommenderName = b.recommender_name || b.recommenderName || null;
    const recommenderContact = b.recommender_contact || b.recommenderContact || null;
    const remarks = b.remarks || null;
    const dateFiled = parseDateToYMD(b.date_filed || b.dateFiled) || new Date().toISOString().split('T')[0];
    const statusDetails = b.status_details || null;

    if (!applicationType || !applicantName) {
      return res.status(400).json({ error: 'Missing required fields: Application Type or Applicant Name' });
    }

    await connection.beginTransaction();

    const appId = await generateAppId(connection, applicationType);
    const isPublicSubmitRoute = req.path === '/public-submit' || req.originalUrl?.includes('/public-submit');
    const isExplicitAdminPortal = req.headers['x-app-portal'] === 'admin';
    const isExplicitPublicPortal = req.headers['x-app-portal'] === 'public' || req.headers['x-app-portal'] === 'constituent';

    const userId = (!isPublicSubmitRoute && !isExplicitPublicPortal && req.admin) ? req.admin.id : null;
    const constituentId = req.constituent?.id || null;
    const isAdminCreation = !isPublicSubmitRoute && !isExplicitPublicPortal && (isExplicitAdminPortal || (userId && !constituentId));

    let assignedOfficerId = b.assigned_officer_id || b.officer || null;
    if (assignedOfficerId === "Unassigned") assignedOfficerId = null;
    let initialStatus = b.status || (isAdminCreation ? 'Submitted' : 'Draft');
    const submissionSource = isAdminCreation ? 'Admin Panel' : 'Public Portal';

    await connection.query(`
      INSERT INTO cm_fund_requests (
        id, application_title, applicant_name, applicant_phone, email, alternate_phone, aadhaar_number, ration_card_number, pan_card_number,
        local_body_id, ward_id, address_line1, address_line2, address, location, latitude, longitude, city, district, state, pincode, application_type,
        category_id, sub_category, priority, amount_requested, description,
        bank_name, account_number, ifsc_code, branch, account_holder_name,
        recommended_by, recommender_name, recommender_contact, remarks,
        status, assigned_officer_id, submitted_by_id, date_filed, submission_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      appId, applicationTitle, applicantName, applicantPhone, email, alternatePhone, aadhaarNumber, rationCardNumber, panCardNumber,
      localBody, ward, addressLine1, addressLine2, address, location, latitude, longitude, city, district, state, pincode, applicationType,
      categoryId, subCategory, priority, amountRequested, description,
      bankName, accountNumber, ifscCode, branch, accountHolderName,
      recommendedBy, recommenderName, recommenderContact, remarks,
      initialStatus, assignedOfficerId, userId, dateFiled, submissionSource
    ]);

    // Handle uploaded documents
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        let docId = file.fieldname;
        if (docId.startsWith('audioNotes')) {
          docId = 'doc_audio_note';
        } else {
          const match = docId.match(/documents\[(.*?)\]/);
          if (match) docId = match[1];
        }

        const fileUrl = file.location || `/uploads/cm_fund_documents/${file.filename}`;

        await connection.query(`
          INSERT INTO cm_fund_request_documents (request_id, doc_type_id, file_url, original_filename)
          VALUES (?, ?, ?, ?)
        `, [appId, docId, fileUrl, file.originalname]);
      }
    }

    // Add timeline event
    await connection.query(`
      INSERT INTO cm_fund_timeline_events (request_id, event_type, to_status, actor_id, note)
      VALUES (?, 'Application Received', ?, ?, 'Application submitted successfully')
    `, [appId, initialStatus, userId]);

    await connection.commit();
    auditLog(req, { action: 'Created', module: 'CM Funds', details: `CM Funds application submitted — ${applicantName} (${appId})`, resource: `cm-funds/${appId}`, severity: 'info' });

    // Auto-insert timeline update.
    // - Public/constituent submission → auto-insert "We are reviewing your submission."
    // - Admin creation with status_details → insert custom text
    // - Admin creation without status_details → insert nothing (no regression)
    const sdTrimmed = statusDetails?.trim();
    const updateTitle = sdTrimmed || (isAdminCreation ? null : 'We are reviewing your submission.');
    const updateNote = sdTrimmed || (isAdminCreation ? null : `Your application has been registered and is under initial review by the MLA Office.\n\nApplicant: ${applicantName}\nTracking ID: ${appId}`);
    if (updateTitle) {
      try {
        await pool.query(
          `INSERT INTO cm_fund_updates (request_id, type, title, note, created_at) VALUES (?, 'Status Update', ?, ?, NOW())`,
          [appId, updateTitle, updateNote]
        );
      } catch (updateErr) {
        // Non-fatal — log but don't fail the overall response
        console.warn('[createRequest] Failed to insert initial review update:', updateErr.message);
      }
    }

    // Notify all admins
    broadcastNotification({
      title: `New CM Fund Request ${appId}`,
      message: `${applicantName} has submitted a new CM Fund application.`,
      type: 'cmfund', module: 'CM Funds',
      record_id: null, record_ref: appId,
      link_path: `/mlaconnect/cm-funds/${appId}`,
    });

    // Notify Applicant
    if (b.notify_applicant === 'true' && applicantPhone) {
      let message = b.custom_message;
      if (!message || message.trim() === '') {
        message = submissionConfirmationSMS({
          name: applicantName,
          dateFiled: dateFiled || new Date().toISOString().split('T')[0],
          referenceNo: appId,
          statusDetails: statusDetails,
          moduleLabel: 'Application',
        });
      } else {
        if (applicantName && applicantName.trim() && applicantName.trim().toLowerCase() !== 'citizen') {
          const nameTrimmed = applicantName.trim();
          message = message
            .replace(/^Hi Citizen,/mi, `Hi ${nameTrimmed},`)
            .replace(/^Hi Citizen /mi, `Hi ${nameTrimmed} `)
            .replace(/\{applicant_name\}/gi, nameTrimmed)
            .replace(/\{name\}/gi, nameTrimmed);
        }
        message = message
          .replace(/\{tracking_id\}/gi, appId)
          .replace(/\{reference_no\}/gi, appId)
          .replace(/\[Pending ID\]/gi, appId)
          .replace(/\[PendingID\]/gi, appId)
          .replace(/Tracking ID:\s*[A-Za-z0-9_-]+/gi, `Tracking ID: ${appId}`);
      }
      await sendSMSSafe(applicantPhone, message, {
        referenceNo: appId,
        module: 'cm-funds',
        recipientName: applicantName
      });

      // Log SMS communication
      await pool.query(
        `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id) VALUES (?, ?, ?, ?, ?, ?)`,
        ['Application', appId, 'SMS', applicantPhone, message, req.admin?.id || null]
      ).catch(err => console.warn('[Log failed]', err.message));
    }

    res.status(201).json({ message: 'Application submitted successfully', id: appId });
  } catch (err) {
    await connection.rollback();
    console.error('Error in createRequest:', err);
    res.status(500).json({ error: 'Failed to create request' });
  } finally {
    connection.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/cm-funds/draft
// Lightweight quick-add — only 5 fields required; status forced to 'Draft'.
// Does NOT affect the main createRequest validation.
// ─────────────────────────────────────────────────────────────────────────────
export const createDraftRequest = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const b = req.body;
    const applicantName = b.applicant_name || b.applicantName;
    const applicationType = b.application_type || b.applicationType || 'CMDRF';
    const applicantPhone = b.applicant_phone || b.applicantPhone || b.phone;
    const email = b.email || b.applicant_email || b.applicantEmail || null;
    const applicationTitle = b.application_title || b.applicationTitle || null;
    const rawCategoryId = b.category_id || b.category;
    const categoryId = await resolveCategoryId(pool, rawCategoryId, applicationType);
    const subCategory = b.sub_category || b.subCategory || null;
    const addressLine1 = b.address_line1 || b.addressLine1 || b.house_name || '';
    const localBody = b.local_body || b.localBody || null;
    const ward = b.ward || null;
    const recommendedBy = b.recommended_by || b.recommendedBy || '';
    const amountRequested = b.amount_requested || b.amountRequested || null;
    const description = b.description || '';
    const priority = b.priority || 'Normal';
    const remarks = b.remarks || null;
    const status = b.status || 'Draft';

    if (!applicantName || !applicantPhone) {
      return res.status(400).json({
        error: 'Missing required fields: applicant_name, phone',
      });
    }

    await connection.beginTransaction();

    const appId = await generateAppId(connection, applicationType);
    const userId = req.admin ? req.admin.id : null;

    const dateFiled = parseDateToYMD(b.date_filed || b.dateFiled) || new Date().toISOString().split('T')[0];

    await connection.query(`
      INSERT INTO cm_fund_requests (
        id, application_title, applicant_name, applicant_phone, email, category_id, sub_category, priority,
        amount_requested, description, remarks,
        status, submitted_by_id,
        address_line1, local_body_id, ward_id, city, district, state, pincode, application_type,
        bank_name, account_number, ifsc_code, branch, account_holder_name, recommended_by, date_filed, submission_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      appId, applicationTitle, applicantName, applicantPhone, email, categoryId, subCategory, priority,
      amountRequested, description, remarks,
      status, userId,
      addressLine1, localBody, ward, '', '', 'Kerala', '', applicationType,
      '', '', '', '', '', recommendedBy, dateFiled, 'Admin Panel'
    ]);

    await connection.query(`
      INSERT INTO cm_fund_timeline_events (request_id, event_type, to_status, actor_id, note)
      VALUES (?, 'Status Initialized', ?, ?, 'Saved via quick form')
    `, [appId, status, userId]);

    // Handle uploaded documents (including audioNotes which we will map to doc_audio_note)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        let docId = file.fieldname;
        // Check if it's audioNotes
        if (docId.startsWith('audioNotes')) {
          docId = 'doc_audio_note';
        } else {
          // Standard document array e.g. documents[doc_med_cert]
          const match = docId.match(/documents\[(.*?)\]/);
          if (match) docId = match[1];
        }

        const fileUrl = file.location || `/uploads/cm_fund_documents/${file.filename}`;

        await connection.query(`
          INSERT INTO cm_fund_request_documents (request_id, doc_type_id, file_url, original_filename)
          VALUES (?, ?, ?, ?)
        `, [appId, docId, fileUrl, file.originalname]);
      }
    }

    // Notify Applicant
    if (b.notify_applicant === 'true' && applicantPhone) {
      let message = b.custom_message;
      if (!message || message.trim() === '') {
        message = submissionConfirmationSMS({
          name: applicantName,
          dateFiled: new Date().toISOString().split('T')[0],
          referenceNo: appId,
        });
      } else {
        if (applicantName && applicantName.trim() && applicantName.trim().toLowerCase() !== 'citizen') {
          const nameTrimmed = applicantName.trim();
          message = message
            .replace(/^Hi Citizen,/mi, `Hi ${nameTrimmed},`)
            .replace(/^Hi Citizen /mi, `Hi ${nameTrimmed} `)
            .replace(/\{applicant_name\}/gi, nameTrimmed)
            .replace(/\{name\}/gi, nameTrimmed);
        }
        message = message
          .replace(/\{tracking_id\}/gi, appId)
          .replace(/\{reference_no\}/gi, appId)
          .replace(/\[Pending ID\]/gi, appId)
          .replace(/\[PendingID\]/gi, appId)
          .replace(/Tracking ID:\s*[A-Za-z0-9_-]+/gi, `Tracking ID: ${appId}`);
      }
      await sendSMSSafe(applicantPhone, message, {
        referenceNo: appId,
        module: 'cm-funds',
        recipientName: applicantName
      });

      // Log SMS communication so it shows in the Communications tab
      await pool.query(
        `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id) VALUES (?, ?, ?, ?, ?, ?)`,
        ['Application', appId, 'SMS', applicantPhone, message, req.admin?.id || null]
      ).catch(err => console.warn('[createDraftRequest SMS Log failed]', err.message));
    }

    await connection.commit();
    auditLog(req, { action: 'Created', module: 'CM Funds', details: `CM Funds draft saved — ${applicantName} (${appId})`, resource: `cm-funds/${appId}`, severity: 'info' });
    res.status(201).json({ message: 'Draft saved successfully', id: appId });
  } catch (err) {
    await connection.rollback();
    console.error('[createDraftRequest]', err);
    res.status(500).json({ error: 'Failed to save draft' });
  } finally {
    connection.release();
  }
};

export const getRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT r.*,
             c.name as category_name,
             u.full_name as submitted_by_name,
             o.full_name as assigned_officer_name,
             d.full_name as deleted_by_name,
             lb.name as local_body_name,
             up.full_name as updated_by_admin_name,
             w.ward_no as ward_no,
             w.place_name as ward_place_name,
             IF(w.ward_no IS NOT NULL, 
                IF(w.place_name IS NOT NULL AND TRIM(w.place_name) != '', 
                   CONCAT('Ward ', w.ward_no, ' - ', w.place_name), 
                   CONCAT('Ward ', w.ward_no)
                ), 
                w.place_name
             ) as ward_name
      FROM cm_fund_requests r
      LEFT JOIN cm_fund_categories c ON r.category_id = c.id
      LEFT JOIN admin_users u ON r.submitted_by_id = u.id
      LEFT JOIN admin_users o ON r.assigned_officer_id = o.id
      LEFT JOIN admin_users d ON r.deleted_by_id = d.id
      LEFT JOIN admin_users up ON r.updated_by_admin_id = up.id
      LEFT JOIN local_bodies lb ON r.local_body_id = lb.id
      LEFT JOIN local_body_wards w ON r.ward_id = w.id
      WHERE r.id = ? AND r.is_deleted = 0
    `, [id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = rows[0];

    const [docs] = await pool.query(`
      SELECT d.*, t.name as doc_name, t.description as doc_description
      FROM cm_fund_request_documents d
      LEFT JOIN cm_fund_document_types t ON d.doc_type_id = t.id
      WHERE d.request_id = ?
    `, [id]);

    const [timeline] = await pool.query(`
      SELECT t.*, COALESCE(u.full_name, r.applicant_name, 'Applicant') as actor_name
      FROM cm_fund_timeline_events t
      LEFT JOIN cm_fund_requests r ON t.request_id = r.id
      LEFT JOIN admin_users u ON t.actor_id = u.id
      WHERE t.request_id = ?
      ORDER BY t.created_at DESC
    `, [id]);

    const [updates] = await pool.query(`
      SELECT u.*, au.full_name AS author_name, au.full_name AS admin_name, m.id AS media_id, m.media_type, m.file_url, m.file_name
      FROM cm_fund_updates u
      LEFT JOIN admin_users au ON u.admin_user_id = au.id
      LEFT JOIN cm_fund_update_media m ON u.id = m.update_id
      WHERE u.request_id = ?
      ORDER BY u.created_at DESC
    `, [id]);

    const formattedUpdatesMap = {};
    updates.forEach(row => {
      if (!formattedUpdatesMap[row.id]) {
        formattedUpdatesMap[row.id] = {
          id: row.id,
          request_id: row.request_id,
          type: row.type,
          title: row.title,
          note: row.note,
          created_at: row.created_at,
          notify_complainant: row.notify_complainant,
          admin_user_id: row.admin_user_id,
          author_name: row.author_name,
          admin_name: row.author_name,
          hide_from_public: row.hide_from_public,
          comm_channel: row.comm_channel,
          comm_sent_at: row.comm_sent_at,
          sms_sent: row.sms_sent,
          sms_body: row.sms_body,
          email_sent: row.email_sent,
          email_body: row.email_body,
          gallery: [],
          attachments: []
        };
      }
      if (row.file_url) {
        if (row.media_type === 'document') {
          formattedUpdatesMap[row.id].attachments.push({
            id: row.media_id || row.file_url,
            name: row.file_name || 'Document',
            file_url: row.file_url
          });
        } else {
          formattedUpdatesMap[row.id].gallery.push({
            id: row.media_id || row.file_url,
            type: row.media_type,
            previewUrl: row.file_url
          });
        }
      }
    });

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
       WHERE (cl.entity_type = 'Application' OR cl.entity_type = 'CM_Fund' OR cl.entity_type = 'cm_fund') 
         AND cl.entity_id COLLATE utf8mb4_unicode_ci = ?
       ORDER BY cl.created_at DESC`,
      [id]
    );

    const commLogsMapped = commLogs.map(cl => ({
      id: `comm_${cl.id}`,
      rawId: cl.id,
      request_id: id,
      type: 'Communication',
      channel: cl.channel,
      recipient: cl.recipient,
      update_id: cl.update_id,
      title: cl.title,
      note: cl.note,
      created_at: cl.created_at,
      _source: 'communications_logs',
      admin_user_id: cl.admin_user_id,
      sent_by_name: cl.sent_by_name,
      author_name: cl.sent_by_name,
      gallery: [],
      attachments: []
    }));

    // Convert map to array and merge with commLogs, then sort DESC
    const updatesArray = [...Object.values(formattedUpdatesMap), ...commLogsMapped].sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || ((Number(b.id) || 0) - (Number(a.id) || 0)));

    const [team] = await pool.query(`
      SELECT ct.id, ct.role_label, ct.created_at,
             au.id as admin_user_id, au.full_name as name, au.email
      FROM cm_fund_team ct
      JOIN admin_users au ON ct.admin_user_id = au.id
      WHERE ct.request_id = ?
      ORDER BY ct.created_at ASC
    `, [id]);

    res.json({ data: { ...request, documents: docs, timeline, updates: updatesArray, team } });
  } catch (err) {
    console.error('Error in getRequest:', err);
    res.status(500).json({ error: 'Failed to fetch request' });
  }
};

export const updateRequest = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const statusDetails = req.body.status_details || null;

    // Partial update allowed
    const updatableFields = [
      'application_title', 'applicant_name', 'applicant_phone', 'alternate_phone', 'aadhaar_number', 'ration_card_number', 'pan_card_number',
      'local_body_id', 'ward_id', 'address_line1', 'address_line2', 'address', 'location', 'latitude', 'longitude', 'city', 'district', 'state', 'pincode', 'application_type',
      'category_id', 'sub_category', 'priority', 'amount_requested', 'description',
      'bank_name', 'account_number', 'ifsc_code', 'branch', 'account_holder_name',
      'recommended_by', 'recommender_name', 'recommender_contact', 'remarks', 'date_filed'
    ];

    const setParts = [];
    const values = [];

    // Map body keys to DB columns
    const bodyToDb = {
      applicationTitle: 'application_title', panCardNumber: 'pan_card_number', address: 'address', location: 'location', latitude: 'latitude', longitude: 'longitude',
      applicantName: 'applicant_name', applicantPhone: 'applicant_phone', alternatePhone: 'alternate_phone',
      email: 'email', applicantEmail: 'email', applicant_email: 'email',
      aadhaarNumber: 'aadhaar_number', rationCardNumber: 'ration_card_number',
      localBody: 'local_body_id', ward: 'ward_id', addressLine1: 'address_line1', addressLine2: 'address_line2',
      city: 'city', district: 'district', state: 'state', pincode: 'pincode', applicationType: 'application_type',
      category: 'category_id', subCategory: 'sub_category', priority: 'priority',
      amountRequested: 'amount_requested', description: 'description',
      bankName: 'bank_name', accountNumber: 'account_number', ifscCode: 'ifsc_code',
      branch: 'branch', accountHolderName: 'account_holder_name',
      recommendedBy: 'recommended_by', recommenderName: 'recommender_name',
      recommenderContact: 'recommender_contact', remarks: 'remarks',
      status: 'status', officer: 'assigned_officer_id', assignedOfficerId: 'assigned_officer_id',
      dateFiled: 'date_filed', date_filed: 'date_filed'
    };

    const sanitize = (val) => (val === 'undefined' || val === 'null') ? '' : val;

    // Fields that are NOT NULL in the database schema
    const notNullFields = new Set([
      'applicant_name', 'applicant_phone', 'address_line1', 'city', 'district', 'pincode',
      'description', 'bank_name', 'account_number', 'ifsc_code', 'branch', 'account_holder_name', 'recommended_by'
    ]);

    const processedDbKeys = new Set();

    for (const [camelKey, dbKey] of Object.entries(bodyToDb)) {
      if (processedDbKeys.has(dbKey)) continue;

      // Check for either the snake_case key (from FormData) or the camelCase key
      let value = req.body[dbKey] !== undefined ? req.body[dbKey] : req.body[camelKey];

      if (typeof value === 'string') {
        value = sanitize(value);
      }

      if (dbKey === 'assigned_officer_id' && value === 'Unassigned') {
        value = null;
      }
      if (dbKey === 'category_id' && value) {
        const reqAppType = req.body.application_type || req.body.applicationType || 'General';
        value = await resolveCategoryId(pool, value, reqAppType);
      }
      if (dbKey === 'date_filed' && value !== undefined) {
        value = parseDateToYMD(value);
      }
      if (value !== undefined) {
        processedDbKeys.add(dbKey);
        setParts.push(`${dbKey} = ?`);
        if (value === '' || value === null) {
          values.push(notNullFields.has(dbKey) ? '' : null);
        } else {
          values.push(value);
        }
      }
    }

    if (setParts.length === 0 && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'No data provided to update' });
    }

    // Ensure required fields are not being nullified or are provided if updating
    const getVal = (snake, camel) => req.body[snake] !== undefined ? req.body[snake] : req.body[camel];

    const checkAppType = sanitize(getVal('application_type', 'applicationType'));
    const checkAppName = sanitize(getVal('applicant_name', 'applicantName'));
    const checkCategory = sanitize(getVal('category_id', 'category'));
    const checkDesc = sanitize(getVal('description', 'description'));

    if (
      (checkAppType !== undefined && !checkAppType) ||
      (checkAppName !== undefined && !checkAppName) ||
      (checkCategory !== undefined && !checkCategory) ||
      (checkDesc !== undefined && !checkDesc)
    ) {
      return res.status(400).json({ error: 'Missing required fields: Application Type, Applicant Name, Category, or Description cannot be empty' });
    }

    await connection.beginTransaction();

    if (setParts.length > 0) {
      setParts.push('updated_by_admin_id = ?');
      values.push(req.admin?.id || null);
      values.push(id);
      await connection.query(`UPDATE cm_fund_requests SET ${setParts.join(', ')} WHERE id = ?`, values);
    }

    // Handle uploaded documents
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        let docId = file.fieldname;
        if (docId.startsWith('audioNotes')) {
          docId = 'doc_audio_note';
        } else {
          const match = docId.match(/documents\[(.*?)\]/);
          if (match) docId = match[1];
        }

        const fileUrl = file.location || `/uploads/cm_fund_documents/${file.filename}`;

        // Upsert strategy for documents (remove old one first if exists)
        await connection.query(`DELETE FROM cm_fund_request_documents WHERE request_id = ? AND doc_type_id = ?`, [id, docId]);

        await connection.query(`
          INSERT INTO cm_fund_request_documents (request_id, doc_type_id, file_url, original_filename)
          VALUES (?, ?, ?, ?)
        `, [id, docId, fileUrl, file.originalname]);
      }
    }

    // Add timeline event
    const userId = req.admin ? req.admin.id : null;
    await connection.query(`
      INSERT INTO cm_fund_timeline_events (request_id, event_type, actor_id, note)
      VALUES (?, 'Application Updated', ?, 'Application details/documents were modified')
    `, [id, userId]);

    if (statusDetails?.trim()) {
      await connection.query(`
        INSERT INTO cm_fund_updates (request_id, type, title, note)
        VALUES (?, 'Status Update', ?, ?)
      `, [id, statusDetails.trim(), null]);
    }

    await connection.commit();
    auditLog(req, { action: 'Updated', module: 'CM Funds', details: `CM Funds application updated — ID ${id}`, resource: `cm-funds/${id}`, severity: 'success' });
    res.json({ message: 'Application updated successfully' });
  } catch (err) {
    await connection.rollback();
    console.error('Error in updateRequest:', err);
    res.status(500).json({ error: 'Failed to update request' });
  } finally {
    connection.release();
  }
};

export const updateStatus = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status, approvedAmount } = req.body;

    if (!status) return res.status(400).json({ error: 'Status is required' });

    await connection.beginTransaction();

    const [rows] = await connection.query('SELECT status FROM cm_fund_requests WHERE id = ?', [id]);
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }
    const oldStatus = rows[0].status;

    if (oldStatus === status) {
      await connection.rollback();
      return res.json({ message: 'Status is already ' + status });
    }

    const updateQuery = `UPDATE cm_fund_requests SET status = ?, updated_by_admin_id = ? ${approvedAmount !== undefined ? ', approved_amount = ?' : ''} WHERE id = ?`;
    const updateParams = approvedAmount !== undefined ? [status, req.admin?.id || null, approvedAmount, id] : [status, req.admin?.id || null, id];

    await connection.query(updateQuery, updateParams);

    // Event type logic
    let eventType = 'Status Changed';
    if (status === 'Under Review') eventType = 'Review Started';
    else if (status === 'Approved') eventType = 'Approved for CM Fund';
    else if (status === 'Disbursed') eventType = 'Funds Disbursed';
    else if (status === 'Rejected') eventType = 'Application Rejected';

    const userId = req.admin ? req.admin.id : null;
    await connection.query(`
      INSERT INTO cm_fund_timeline_events (request_id, event_type, from_status, to_status, actor_id, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, eventType, oldStatus, status, userId, `Status updated to ${status}`]);

    await connection.commit();
    const auditSeverity = status === 'Disbursed' ? 'success' : (status === 'Rejected' ? 'error' : 'info');
    auditLog(req, { action: 'Updated', module: 'CM Funds', details: `CM Funds application ${id} status changed: ${oldStatus} → ${status}`, resource: `cm-funds/${id}`, severity: auditSeverity });
    // Notify assigned officer if present
    const [[cmReq]] = await pool.query('SELECT assigned_officer_id FROM cm_fund_requests WHERE id = ?', [id]);
    if (cmReq?.assigned_officer_id) {
      createNotification(cmReq.assigned_officer_id, {
        title: `CM Fund ${id} status updated to ${status}`,
        message: `Status changed from "${oldStatus}" to "${status}".`,
        type: 'cmfund', module: 'CM Funds',
        record_ref: id, link_path: `/mlaconnect/cm-funds/${id}`,
      });
    }
    res.json({ message: 'Status updated successfully' });
  } catch (err) {
    await connection.rollback();
    console.error('Error in updateStatus:', err);
    res.status(500).json({ error: 'Failed to update status' });
  } finally {
    connection.release();
  }
};

export const deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.admin ? req.admin.id : null;

    // Soft-delete: mark as deleted, set timestamp and actor
    await pool.query(
      `UPDATE cm_fund_requests SET is_deleted = 1, deleted_at = NOW(), deleted_by_id = ? WHERE id = ?`,
      [userId, id]
    );

    auditLog(req, { action: 'Deleted', module: 'CM Funds', details: `CM Funds application ${id} moved to trash`, resource: `cm-funds/${id}`, severity: 'warning' });
    res.json({ message: 'Application moved to trash' });
  } catch (err) {
    console.error('Error in deleteRequest:', err);
    res.status(500).json({ error: 'Failed to delete application' });
  }
};

export const restoreRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`SELECT id FROM cm_fund_requests WHERE id = ? AND is_deleted = 1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Trashed application not found' });

    await pool.query(
      `UPDATE cm_fund_requests SET is_deleted = 0, deleted_at = NULL, deleted_by_id = NULL WHERE id = ?`,
      [id]
    );

    auditLog(req, { action: 'Restored', module: 'CM Funds', details: `CM Funds application ${id} restored from trash`, resource: `cm-funds/${id}`, severity: 'info' });
    res.json({ message: 'Application restored successfully' });
  } catch (err) {
    console.error('Error in restoreRequest:', err);
    res.status(500).json({ error: 'Failed to restore application' });
  }
};

export const permanentDeleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      `UPDATE cm_fund_requests SET is_deleted = 1, deleted_at = NOW(), deleted_by_id = ? WHERE id = ?`,
      [req.user?.id || req.admin?.id || null, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    auditLog(req, { action: 'Trashed', module: 'CM Funds', details: `CM Funds application ${id} moved to trash`, resource: `cm-funds/${id}`, severity: 'info' });
    res.json({ message: 'Application moved to trash' });
  } catch (err) {
    console.error('Error in permanentDeleteRequest:', err);
    res.status(500).json({ error: 'Failed to delete application' });
  }
};

export const downloadPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT r.*, 
             c.name as category_name
      FROM cm_fund_requests r
      LEFT JOIN cm_fund_categories c ON r.category_id = c.id
      WHERE r.id = ?
    `, [id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });

    const [settings] = await pool.query(`
      SELECT value FROM site_settings WHERE setting_key = 'mla_letter_template' LIMIT 1
    `);
    const templateConfig = settings.length > 0 && settings[0].value ? JSON.parse(settings[0].value) : null;

    const pdfBuffer = await generateCMFundsPdf(rows[0], templateConfig);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error in downloadPdf:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
};

export const addUpdate = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { type, title, note, notify_complainant, custom_sms_message, custom_email_message, notify_channels } = req.body;
    const isNotify = notify_complainant === 'true' || notify_complainant === true;

    if (!title || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await connection.beginTransaction();

    const [requestRows] = await connection.query(
      `SELECT applicant_name, applicant_phone, email, status, created_at as date_filed FROM cm_fund_requests WHERE id = ?`,
      [id]
    );
    if (requestRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Application not found' });
    }
    const application = requestRows[0];

    const isHidden = (req.body.hide_from_public === '1' || req.body.hide_from_public === 'true' || req.body.hide_from_public === 1 || req.body.hide_from_public === true) ? 1 : 0;

    // Insert the update
    const [result] = await connection.query(`
      INSERT INTO cm_fund_updates (request_id, type, title, note, notify_complainant, admin_user_id, hide_from_public)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, type, title, note || null, isNotify ? 1 : 0, req.admin?.id || null, isHidden]);

    const updateId = result.insertId;

    // Insert Media
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileUrl = file.location || `/uploads/cm_fund_documents/${file.filename}`;
        const isVideo = file.mimetype.startsWith('video/');
        let mediaType = isVideo ? 'video' : 'photo';
        if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
          mediaType = 'document';
        }
        await connection.query(`
          INSERT INTO cm_fund_update_media (update_id, media_type, file_url, file_name)
          VALUES (?, ?, ?, ?)
        `, [updateId, mediaType, fileUrl, file.originalname]);
      }
    }

    // Update Application Status if changed
    let oldStatus = application.status;
    if (type !== application.status) {
      await connection.query(`UPDATE cm_fund_requests SET status = ?, updated_by_admin_id = ? WHERE id = ?`, [type, req.admin?.id || null, id]);

      // Log Status Change Timeline Event
      await connection.query(`
        INSERT INTO cm_fund_timeline_events (request_id, event_type, from_status, to_status, actor_id, note)
        VALUES (?, 'Status Updated', ?, ?, ?, ?)
      `, [id, oldStatus, type, req.admin ? req.admin.id : null, `Status changed via Follow-up Update: ${title}`]);
    } else {
      // Just log an update event
      await connection.query(`
        INSERT INTO cm_fund_timeline_events (request_id, event_type, to_status, actor_id, note)
        VALUES (?, 'Follow-up Added', ?, ?, ?)
      `, [id, type, req.admin ? req.admin.id : null, title]);
    }

    await connection.commit();

    // Send SMS / Email Notification
    if (isNotify) {
      let channels = [];
      try {
        if (notify_channels) channels = JSON.parse(notify_channels);
      } catch (e) { }

      let didSendSms = false;
      let didSendEmail = false;
      let finalSms = null;
      let finalEmail = null;

      // Send SMS if selected
      if (application.applicant_phone && channels.includes('sms')) {
        finalSms = custom_sms_message || followUpUpdateSMS({
          name: application.applicant_name,
          referenceNo: id,
          statusTitle: title,
          moduleLabel: 'Application',
          updateDate: new Date(),
          dateFiled: application.date_filed,
        });
        sendSMSSafe(application.applicant_phone, finalSms);
        didSendSms = true;

        // Log SMS communication
        await pool.query(
          `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['Application', id, 'SMS', application.applicant_phone, finalSms, req.admin?.id || null, updateId]
        ).catch(err => console.warn('[addCmFundUpdate SMS Log failed]', err.message));
      }

      // Send Email if selected
      const targetEmail = req.body.email || req.body.applicant_email || null;
      if (targetEmail && channels.includes('email') && custom_email_message?.trim()) {
        finalEmail = custom_email_message.trim();
        sendNotificationEmail({
          to: targetEmail,
          subject: `Update on your CM Fund Application #${id}`,
          message: finalEmail
        }).catch(err => console.error('[addCmFundUpdate Email Error]', err));
        didSendEmail = true;

        // Log Email communication
        await pool.query(
          `INSERT INTO communications_logs (entity_type, entity_id, channel, recipient, message, admin_user_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['Application', id, 'Email', targetEmail, finalEmail, req.admin?.id || null, updateId]
        ).catch(err => console.warn('[addCmFundUpdate Email Log failed]', err.message));
      }

      if (didSendSms || didSendEmail) {
        const commChannel = (didSendSms && didSendEmail) ? 'both' : (didSendSms ? 'sms' : 'email');
        const now = new Date();
        await pool.query(
          `UPDATE cm_fund_updates 
           SET comm_channel = ?, comm_sent_at = ?, sms_sent = ?, sms_body = ?, email_sent = ?, email_body = ?
           WHERE id = ?`,
          [commChannel, now, didSendSms ? 1 : 0, finalSms, didSendEmail ? 1 : 0, finalEmail, updateId]
        ).catch(err => console.warn('[addCmFundUpdate comm update failed]', err.message));
      }
    }

    auditLog(req, { action: 'Updated', module: 'CM Funds', details: `Added follow-up to Application ${id}`, resource: `cm-funds/${id}`, severity: 'info' });

    res.status(201).json({ message: 'Update added successfully', updateId });
  } catch (err) {
    await connection.rollback();
    console.error('Error adding update:', err);
    res.status(500).json({ error: 'Failed to add update' });
  } finally {
    connection.release();
  }
};

export const editUpdate = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id, updateId } = req.params;
    const { type, title, note, retained_media_ids, hide_from_public } = req.body;

    await connection.beginTransaction();

    const updateFields = ['type = ?', 'title = ?', 'note = ?'];
    const updateParams = [type, title, note || null];

    if (hide_from_public !== undefined) {
      const isHidden = (hide_from_public === '1' || hide_from_public === 'true' || hide_from_public === 1 || hide_from_public === true) ? 1 : 0;
      updateFields.push('hide_from_public = ?');
      updateParams.push(isHidden);
    }

    updateParams.push(updateId, id);
    await connection.query(
      `UPDATE cm_fund_updates SET ${updateFields.join(', ')} WHERE id = ? AND request_id = ?`,
      updateParams
    );

    let retainedMedia = [];
    try { if (retained_media_ids) retainedMedia = JSON.parse(retained_media_ids); } catch (e) { }

    const [currentMedia] = await connection.query('SELECT id, file_url FROM cm_fund_update_media WHERE update_id = ?', [updateId]);
    const mediaToDelete = currentMedia.filter(m => !retainedMedia.includes(m.id));
    if (mediaToDelete.length > 0) {
      const idsToDelete = mediaToDelete.map(m => m.id);
      await Promise.all(mediaToDelete.map(m => deleteS3Object(m.file_url)));
      await connection.query('DELETE FROM cm_fund_update_media WHERE id IN (?)', [idsToDelete]);
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileUrl = file.location || `/uploads/cm_fund_documents/${file.filename}`;
        const isVideo = file.mimetype.startsWith('video/');
        let mediaType = isVideo ? 'video' : 'photo';
        if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
          mediaType = 'document';
        }
        await connection.query(`
          INSERT INTO cm_fund_update_media (update_id, media_type, file_url, file_name)
          VALUES (?, ?, ?, ?)
        `, [updateId, mediaType, fileUrl, file.originalname]);
      }
    }

    await connection.query(`
      INSERT INTO cm_fund_timeline_events (request_id, event_type, actor_id, note)
      VALUES (?, 'Update Edited', ?, ?)
    `, [id, req.admin ? req.admin.id : null, `Follow-up updated: ${title}`]);

    await connection.commit();
    auditLog(req, { action: 'Updated', module: 'CM Funds', details: `Edited follow-up on Application ${id}`, resource: `cm-funds/${id}`, severity: 'info' });
    res.json({ message: 'Update edited successfully' });
  } catch (err) {
    await connection.rollback();
    console.error('Error editing update:', err);
    res.status(500).json({ error: 'Failed to edit update' });
  } finally {
    connection.release();
  }
};

export const deleteUpdate = async (req, res) => {
  try {
    const { id, updateId } = req.params;
    const [result] = await pool.query('DELETE FROM cm_fund_updates WHERE id = ? AND request_id = ?', [updateId, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Update not found' });
    }

    auditLog(req, { action: 'Deleted', module: 'CM Funds', details: `Deleted follow-up ${updateId} from Application ${id}`, resource: `cm-funds/${id}`, severity: 'warning' });
    res.json({ message: 'Update deleted successfully' });
  } catch (err) {
    console.error('Error deleting update:', err);
    res.status(500).json({ error: 'Failed to delete update' });
  }
};

export const addCmFundTeamMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_user_id, role_label } = req.body;
    if (!admin_user_id) return res.status(400).json({ success: false, message: 'admin_user_id is required.' });

    const [[adminUser]] = await pool.query('SELECT id, full_name FROM admin_users WHERE id = ?', [admin_user_id]);
    if (!adminUser) return res.status(404).json({ success: false, message: 'Admin user not found.' });

    try {
      const [result] = await pool.query(
        'INSERT INTO cm_fund_team (request_id, admin_user_id, role_label) VALUES (?,?,?)',
        [id, admin_user_id, role_label || null]
      );
      auditLog(req, { action: 'Updated', module: 'CM Funds', details: `Added team member "${adminUser.full_name}" to Application ID ${id}`, resource: `cm-funds/${id}`, severity: 'info' });
      const [[row]] = await pool.query(`
        SELECT ct.id, ct.role_label, ct.created_at,
               au.id as admin_user_id, au.full_name as name, au.email
        FROM cm_fund_team ct
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
    console.error('[addCmFundTeamMember]', err);
    res.status(500).json({ success: false, message: 'Failed to add team member.' });
  }
};

export const removeCmFundTeamMember = async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const [[row]] = await pool.query(`
      SELECT ct.id, au.full_name
      FROM cm_fund_team ct JOIN admin_users au ON ct.admin_user_id = au.id
      WHERE ct.id = ? AND ct.request_id = ?
    `, [memberId, id]);
    if (!row) return res.status(404).json({ success: false, message: 'Team member not found.' });

    await pool.query('DELETE FROM cm_fund_team WHERE id = ?', [memberId]);
    auditLog(req, { action: 'Updated', module: 'CM Funds', details: `Removed team member "${row.full_name}" from Application ID ${id}`, resource: `cm-funds/${id}`, severity: 'warning' });
    res.json({ success: true, message: 'Team member removed.' });
  } catch (err) {
    console.error('[removeCmFundTeamMember]', err);
    res.status(500).json({ success: false, message: 'Failed to remove team member.' });
  }
};
