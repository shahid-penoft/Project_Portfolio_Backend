import db from '../configs/db.js';
import { successResponse, errorResponse } from '../utils/helpers.js';
import { expandApplicationTypes } from './cmFundsController.js';

const parseArrayParam = (param) => {
    if (!param) return [];
    if (Array.isArray(param)) return param.map(s => String(s).trim()).filter(Boolean);
    return String(param).split(',').map(s => s.trim()).filter(Boolean);
};

export const getUnifiedItems = async (req, res) => {
    try {
        const {
            type = 'draft', // 'draft' or 'trash'
            page = 1,
            limit = 10,
            search = '',
            module = 'all',
            application_type = '',
            applicationType = '',
            priority = '',
            daysLeft = '', // comma-separated: 'critical,warning,safe'
            sortBy = '', // 'Most Recent', 'Least Recent', 'Title A-Z', 'Title Z-A', 'Expiring Soon', 'Expiring Last', 'Recently Deleted'
            datePreset = '',
            startDate = '',
            endDate = '',
            localBody = '',
            ward = '',
            createdBy = '',
            deletedBy = '',
            category = '',
            department = ''
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const parsedLimit = parseInt(limit);
        
        let statusFilter = '';
        if (type === 'draft') {
            statusFilter = "status = 'Draft' AND is_deleted = 0";
        } else if (type === 'trash') {
            statusFilter = "is_deleted = 1";
        } else {
            return errorResponse(res, "Invalid type. Must be 'draft' or 'trash'.", 400);
        }

        const lettersStatusFilter = type === 'draft' ? "status = 'Draft' AND trashed_at IS NULL" : "trashed_at IS NOT NULL";
        
        // Base Union Query mapping disparate tables to unified schema
        const baseQuery = `
            SELECT 
                c.id AS raw_id,
                IFNULL(c.reference_no, CONCAT('C-', c.id)) AS display_id,
                'Complaints' AS module,
                c.title AS title,
                c.category AS category,
                c.department AS department,
                c.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                c.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                c.priority AS priority,
                c.status AS status,
                NULL AS application_type,
                c.created_at AS created_at,
                c.updated_at AS updated_at,
                c.deleted_at AS deleted_at,
                c.submission_source AS submission_source,
                c.filed_by_admin_id AS created_by_id,
                COALESCE(u.full_name, c.complainant_name) AS created_by,
                c.complainant_name AS submitter_name,
                del_u.full_name AS deleted_by
            FROM complaints c
            LEFT JOIN local_bodies lb ON c.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON c.ward_id = w.id
            LEFT JOIN admin_users u ON c.filed_by_admin_id = u.id
            LEFT JOIN admin_users del_u ON COALESCE(c.updated_by_admin_id, (SELECT admin_user_id FROM complaint_activity WHERE complaint_id = c.id AND text LIKE '%trash%' ORDER BY created_at DESC LIMIT 1)) = del_u.id 
            WHERE c.${statusFilter}
            
            UNION ALL
            
            SELECT 
                i.id AS raw_id,
                IFNULL(i.reference_no, CONCAT('P-', i.id)) AS display_id,
                'Public Issue' AS module,
                i.title AS title,
                i.category AS category,
                i.department AS department,
                i.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                i.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                i.priority AS priority,
                i.status AS status,
                NULL AS application_type,
                i.created_at AS created_at,
                i.updated_at AS updated_at,
                i.deleted_at AS deleted_at,
                i.submission_source AS submission_source,
                i.filed_by_admin_id AS created_by_id,
                COALESCE(u.full_name, i.submitter_name) AS created_by,
                i.submitter_name AS submitter_name,
                del_u.full_name AS deleted_by
            FROM issues i
            LEFT JOIN local_bodies lb ON i.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON i.ward_id = w.id
            LEFT JOIN admin_users u ON i.filed_by_admin_id = u.id
            LEFT JOIN admin_users del_u ON COALESCE(i.updated_by_admin_id, (SELECT admin_user_id FROM issue_activity WHERE issue_id = i.id AND text LIKE '%trash%' ORDER BY created_at DESC LIMIT 1)) = del_u.id
            WHERE i.${statusFilter}
            
            UNION ALL
            
            SELECT 
                f.id AS raw_id,
                CAST(f.id AS CHAR) AS display_id,
                'Applications' AS module,
                COALESCE(NULLIF(TRIM(f.application_title), ''), f.applicant_name, 'Untitled Application') AS title,
                c.name AS category,
                NULL AS department,
                f.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                f.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                f.priority AS priority,
                f.status AS status,
                f.application_type AS application_type,
                f.created_at AS created_at,
                f.updated_at AS updated_at,
                f.deleted_at AS deleted_at,
                f.submission_source AS submission_source,
                IF(f.submission_source = 'Public Portal', NULL, f.submitted_by_id) AS created_by_id,
                IF(f.submission_source = 'Public Portal' OR f.submitted_by_id IS NULL, f.applicant_name, COALESCE(u.full_name, f.applicant_name)) AS created_by,
                f.applicant_name AS submitter_name,
                del_u.full_name AS deleted_by
            FROM cm_fund_requests f
            LEFT JOIN cm_fund_categories c ON f.category_id = c.id
            LEFT JOIN local_bodies lb ON f.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON f.ward_id = w.id
            LEFT JOIN admin_users u ON f.submitted_by_id = u.id
            LEFT JOIN admin_users del_u ON f.deleted_by_id = del_u.id
            WHERE f.${statusFilter}
            
            UNION ALL
            
            SELECT 
                l.id AS raw_id,
                IFNULL(l.letter_id COLLATE utf8mb4_unicode_ci, CONCAT('L-', l.id)) AS display_id,
                'Letters' AS module,
                l.subject AS title,
                NULL AS category,
                NULL AS department,
                NULL AS local_body_id,
                NULL AS local_body_name,
                NULL AS ward_id,
                NULL AS ward_no,
                NULL AS ward_name,
                l.priority AS priority,
                l.status AS status,
                NULL AS application_type,
                l.created_at AS created_at,
                l.updated_at AS updated_at,
                l.trashed_at AS deleted_at,
                'Admin Panel' AS submission_source,
                l.prepared_by_user_id AS created_by_id,
                u.full_name AS created_by,
                NULL AS submitter_name,
                del_u.full_name AS deleted_by
            FROM mla_letters l
            LEFT JOIN admin_users u ON l.prepared_by_user_id = u.id
            LEFT JOIN admin_users del_u ON l.trashed_by_id = del_u.id
            WHERE l.${lettersStatusFilter}
            
            UNION ALL
            
            SELECT 
                g.id AS raw_id,
                IF(g.governing_body_type COLLATE utf8mb4_unicode_ci ='OTHER', CONCAT('O-', g.id), CONCAT('M-', g.id)) AS display_id,
                IF(g.governing_body_type COLLATE utf8mb4_unicode_ci ='OTHER', 'Office', 'Governing Body') AS module,
                g.name AS title,
                NULL AS category,
                NULL AS department,
                g.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                g.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                'Normal' AS priority,
                g.status AS status,
                NULL AS application_type,
                g.created_at AS created_at,
                g.updated_at AS updated_at,
                g.deleted_at AS deleted_at,
                'Admin Panel' AS submission_source,
                creator_log.admin_user_id AS created_by_id,
                u.full_name AS created_by,
                NULL AS submitter_name,
                del_u.full_name AS deleted_by
            FROM governing_representatives g
            LEFT JOIN local_bodies lb ON g.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON g.ward_id = w.id
            LEFT JOIN (
                SELECT governing_body_id, MIN(admin_user_id) AS admin_user_id
                FROM governing_body_activity_logs
                WHERE text LIKE 'Created%'
                GROUP BY governing_body_id
            ) creator_log ON g.id = creator_log.governing_body_id
            LEFT JOIN admin_users u ON creator_log.admin_user_id = u.id
            LEFT JOIN (
                SELECT governing_body_id, MAX(admin_user_id) AS admin_user_id
                FROM governing_body_activity_logs
                WHERE text LIKE '%trash%' OR text LIKE '%delete%' OR text LIKE '%Delete%'
                GROUP BY governing_body_id
            ) deleter_log ON g.id = deleter_log.governing_body_id
            LEFT JOIN admin_users del_u ON COALESCE(deleter_log.admin_user_id, creator_log.admin_user_id) = del_u.id
            WHERE g.${statusFilter}
            
            UNION ALL
            
            SELECT 
                id.id AS raw_id,
                IFNULL(id.reference_no, CONCAT('I-', id.id)) AS display_id,
                'Ideas' AS module,
                id.title AS title,
                id.category AS category,
                id.department AS department,
                id.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                id.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                id.priority AS priority,
                id.status AS status,
                NULL AS application_type,
                id.created_at AS created_at,
                id.updated_at AS updated_at,
                id.deleted_at AS deleted_at,
                id.submission_source AS submission_source,
                id.filed_by_admin_id AS created_by_id,
                COALESCE(u.full_name, id.complainant_name) AS created_by,
                id.complainant_name AS submitter_name,
                del_u.full_name AS deleted_by
            FROM ideas id
            LEFT JOIN local_bodies lb ON id.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON id.ward_id = w.id
            LEFT JOIN admin_users u ON id.filed_by_admin_id = u.id
            LEFT JOIN admin_users del_u ON COALESCE(id.updated_by_admin_id, (SELECT admin_user_id FROM idea_activity WHERE idea_id = id.id AND text LIKE '%trash%' ORDER BY created_at DESC LIMIT 1)) = del_u.id
            WHERE id.${statusFilter}
            
            UNION ALL
            
            SELECT 
                s.id AS raw_id,
                IFNULL(s.reference_no, CONCAT('S-', s.id)) AS display_id,
                'Suggestions' AS module,
                s.title AS title,
                s.category AS category,
                s.department AS department,
                s.local_body_id AS local_body_id,
                lb.name AS local_body_name,
                s.ward_id AS ward_id,
                w.ward_no AS ward_no,
                IFNULL(w.place_name, IF(w.ward_no IS NOT NULL, CONCAT('Ward ', w.ward_no), NULL)) AS ward_name,
                s.priority AS priority,
                s.status AS status,
                NULL AS application_type,
                s.created_at AS created_at,
                s.updated_at AS updated_at,
                s.deleted_at AS deleted_at,
                s.submission_source AS submission_source,
                s.filed_by_admin_id AS created_by_id,
                COALESCE(u.full_name, s.complainant_name) AS created_by,
                s.complainant_name AS submitter_name,
                del_u.full_name AS deleted_by
            FROM suggestions s
            LEFT JOIN local_bodies lb ON s.local_body_id = lb.id
            LEFT JOIN local_body_wards w ON s.ward_id = w.id
            LEFT JOIN admin_users u ON s.filed_by_admin_id = u.id
            LEFT JOIN admin_users del_u ON COALESCE(s.updated_by_admin_id, (SELECT admin_user_id FROM suggestion_activity WHERE suggestion_id = s.id AND text LIKE '%trash%' ORDER BY created_at DESC LIMIT 1)) = del_u.id
            WHERE s.${statusFilter}
        `;

        // Wrap the union in a subquery to apply global filters/sort
        let outerQuery = `SELECT *, 
            CAST(GREATEST(0, DATEDIFF(DATE_ADD(deleted_at, INTERVAL 30 DAY), NOW())) AS SIGNED) AS daysLeft
            FROM (${baseQuery}) AS unified WHERE 1=1`;
        
        const params = [];

        const mArray = parseArrayParam(module).filter(m => m !== 'all');
        if (mArray.length > 0) {
            const placeholders = mArray.map(() => '?').join(',');
            outerQuery += ` AND module IN (${placeholders})`;
            params.push(...mArray);
        }

        const catArray = parseArrayParam(category).filter(c => c !== 'All');
        if (catArray.length > 0) {
            const placeholders = catArray.map(() => '?').join(',');
            outerQuery += ` AND category IN (${placeholders})`;
            params.push(...catArray);
        }

        const deptArray = parseArrayParam(department).filter(d => d !== 'All');
        if (deptArray.length > 0) {
            const deptClauses = deptArray.map(() => 'department LIKE ?');
            outerQuery += ` AND (${deptClauses.join(' OR ')})`;
            deptArray.forEach(d => params.push(`%${d}%`));
        }

        const rawAppType = application_type || applicationType;
        const expandedAppTypes = expandApplicationTypes(rawAppType);
        if (expandedAppTypes && expandedAppTypes.length > 0) {
            const placeholders = expandedAppTypes.map(() => '?').join(',');
            outerQuery += ` AND (application_type IN (${placeholders}) OR module != 'Applications')`;
            params.push(...expandedAppTypes);
        }

        const pArray = parseArrayParam(priority);
        if (pArray.length > 0) {
            const placeholders = pArray.map(() => '?').join(',');
            outerQuery += ` AND priority IN (${placeholders})`;
            params.push(...pArray);
        }

        const dateCol = type === 'trash' ? 'COALESCE(deleted_at, created_at)' : 'created_at';

        if (startDate) {
            outerQuery += ` AND DATE(${dateCol}) >= ?`;
            params.push(startDate);
        }

        if (endDate) {
            outerQuery += ` AND DATE(${dateCol}) <= ?`;
            params.push(endDate);
        }

        if (!startDate && !endDate && datePreset) {
            if (datePreset === 'Today') {
                outerQuery += ` AND DATE(${dateCol}) = CURDATE()`;
            } else if (datePreset === 'Yesterday') {
                outerQuery += ` AND DATE(${dateCol}) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`;
            } else if (datePreset === 'Last 7 Days') {
                outerQuery += ` AND ${dateCol} >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
            } else if (datePreset === 'Last 30 Days') {
                outerQuery += ` AND ${dateCol} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
            } else if (datePreset === 'This Month') {
                outerQuery += ` AND YEAR(${dateCol}) = YEAR(NOW()) AND MONTH(${dateCol}) = MONTH(NOW())`;
            } else if (datePreset === 'This Year') {
                outerQuery += ` AND YEAR(${dateCol}) = YEAR(NOW())`;
            }
        }

        const lbArray = parseArrayParam(localBody);
        if (lbArray.length > 0) {
            const placeholders = lbArray.map(() => '?').join(',');
            outerQuery += ` AND (local_body_name IN (${placeholders}) OR CAST(local_body_id AS CHAR) IN (${placeholders}))`;
            params.push(...lbArray, ...lbArray);
        }

        const wArray = parseArrayParam(ward);
        if (wArray.length > 0) {
            const placeholders = wArray.map(() => '?').join(',');
            const likeClauses = wArray.map(() => `ward_name LIKE ? OR CONCAT('Ward ', ward_no) LIKE ?`).join(' OR ');
            outerQuery += ` AND (ward_name IN (${placeholders}) OR CAST(ward_id AS CHAR) IN (${placeholders}) OR ${likeClauses})`;
            params.push(...wArray, ...wArray);
            wArray.forEach(w => {
                const clean = w.replace(/^Ward\s+\d+\s*-\s*/i, '').trim();
                params.push(`%${clean}%`, `%${clean}%`);
            });
        }

        const cbArray = parseArrayParam(createdBy);
        if (cbArray.length > 0) {
            const placeholders = cbArray.map(() => '?').join(',');
            outerQuery += ` AND created_by IN (${placeholders})`;
            params.push(...cbArray);
        }

        const dbArray = parseArrayParam(deletedBy);
        if (dbArray.length > 0) {
            const placeholders = dbArray.map(() => '?').join(',');
            outerQuery += ` AND deleted_by IN (${placeholders})`;
            params.push(...dbArray);
        }

        if (search) {
            const searchPattern = `%${search}%`;
            outerQuery += ` AND (title LIKE ? OR display_id LIKE ? OR created_by LIKE ? OR deleted_by LIKE ?)`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        if (type === 'trash' && daysLeft) {
            const dlArray = parseArrayParam(daysLeft);
            const conditions = [];
            const daysExpr = `CAST(GREATEST(0, DATEDIFF(DATE_ADD(deleted_at, INTERVAL 30 DAY), NOW())) AS SIGNED)`;
            if (dlArray.includes('critical')) conditions.push(`${daysExpr} <= 3`);
            if (dlArray.includes('warning')) conditions.push(`(${daysExpr} >= 4 AND ${daysExpr} <= 15)`);
            if (dlArray.includes('safe')) conditions.push(`${daysExpr} > 15`);
            
            if (conditions.length > 0) {
                outerQuery += ` AND (${conditions.join(' OR ')})`;
            }
        }

        // Count Query
        const countQuery = `SELECT COUNT(*) AS total FROM (${outerQuery}) AS filteredCount`;
        const [[{ total }]] = await db.query(countQuery, params);

        // Sorting
        let orderByClause = '';
        if (sortBy === 'Most Recent') orderByClause = 'ORDER BY created_at DESC';
        else if (sortBy === 'Least Recent') orderByClause = 'ORDER BY created_at ASC';
        else if (sortBy === 'Title A–Z' || sortBy === 'Title A-Z') orderByClause = 'ORDER BY title ASC';
        else if (sortBy === 'Title Z–A' || sortBy === 'Title Z-A') orderByClause = 'ORDER BY title DESC';
        else if (sortBy === 'Expiring Soon') orderByClause = 'ORDER BY daysLeft ASC, deleted_at ASC';
        else if (sortBy === 'Expiring Last') orderByClause = 'ORDER BY daysLeft DESC, deleted_at DESC';
        else if (sortBy === 'Recently Deleted') orderByClause = 'ORDER BY deleted_at DESC';
        else {
            if (type === 'draft') orderByClause = 'ORDER BY created_at DESC';
            else orderByClause = 'ORDER BY daysLeft ASC, deleted_at ASC';
        }

        outerQuery += ` ${orderByClause} LIMIT ? OFFSET ?`;
        params.push(parsedLimit, offset);

        const [rows] = await db.query(outerQuery, params);

        return successResponse(res, {
            data: rows,
            pagination: {
                total,
                page: parseInt(page),
                limit: parsedLimit,
                totalPages: Math.ceil(total / parsedLimit)
            }
        });
    } catch (error) {
        console.error('[Unified Quick Actions Error]', error);
        return errorResponse(res, "Failed to retrieve unified items.");
    }
};
