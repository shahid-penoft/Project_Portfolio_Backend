import db from '../configs/db.js';
import { successResponse, errorResponse } from '../utils/helpers.js';

// GET /api/local-bodies/:localBodyId/wards
export const getWardsByLocalBody = async (req, res) => {
    try {
        const { localBodyId } = req.params;
        const { page, limit, search } = req.query;

        if (!page || !limit) {
            const [rows] = await db.query(
                'SELECT * FROM local_body_wards WHERE local_body_id = ? ORDER BY CAST(ward_no AS UNSIGNED) ASC, ward_no ASC',
                [localBodyId]
            );
            return successResponse(res, { data: rows }, 'Wards fetched successfully.');
        }

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 6;
        const offset = (pageNum - 1) * limitNum;

        let query = 'SELECT * FROM local_body_wards WHERE local_body_id = ?';
        let countQuery = 'SELECT COUNT(*) as total FROM local_body_wards WHERE local_body_id = ?';
        const queryParams = [localBodyId];

        if (search) {
            query += ' AND (ward_no LIKE ? OR place_name LIKE ?)';
            countQuery += ' AND (ward_no LIKE ? OR place_name LIKE ?)';
            queryParams.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY CAST(ward_no AS UNSIGNED) ASC, ward_no ASC LIMIT ? OFFSET ?';

        const [rows] = await db.query(query, [...queryParams, limitNum, offset]);
        const [countResult] = await db.query(countQuery, queryParams);

        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limitNum);

        return successResponse(res, {
            data: rows,
            pagination: { total, page: pageNum, limit: limitNum, totalPages }
        }, 'Wards fetched successfully.');
    } catch (err) {
        console.error('[getWardsByLocalBody]', err);
        return errorResponse(res, 'Server error fetching wards.');
    }
};

// POST /api/local-bodies/:localBodyId/wards
export const createWard = async (req, res) => {
    try {
        const { localBodyId } = req.params;
        const { ward_no, place_name } = req.body;

        if (!ward_no || !place_name) {
            return errorResponse(res, 'ward_no and place_name are required.', 400);
        }

        const [result] = await db.query(
            'INSERT INTO local_body_wards (local_body_id, ward_no, place_name) VALUES (?, ?, ?)',
            [localBodyId, ward_no.trim(), place_name.trim()]
        );

        const [rows] = await db.query('SELECT * FROM local_body_wards WHERE id = ?', [result.insertId]);
        return successResponse(res, { data: rows[0] }, 'Ward created successfully.', 201);
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return errorResponse(res, 'A ward with this number already exists in this local body.', 409);
        }
        if (err.code === 'ER_NO_REFERENCED_ROW_2') {
            return errorResponse(res, 'Local body not found.', 404);
        }
        console.error('[createWard]', err);
        return errorResponse(res, 'Server error creating ward.');
    }
};

// PUT /api/local-bodies/:localBodyId/wards/:id
export const updateWard = async (req, res) => {
    try {
        const { localBodyId, id } = req.params;
        const { ward_no, place_name } = req.body;

        if (!ward_no || !place_name) {
            return errorResponse(res, 'ward_no and place_name are required.', 400);
        }

        const [result] = await db.query(
            'UPDATE local_body_wards SET ward_no = ?, place_name = ? WHERE id = ? AND local_body_id = ?',
            [ward_no.trim(), place_name.trim(), id, localBodyId]
        );

        if (!result.affectedRows) {
            return errorResponse(res, 'Ward not found or does not belong to this local body.', 404);
        }

        const [rows] = await db.query('SELECT * FROM local_body_wards WHERE id = ?', [id]);
        return successResponse(res, { data: rows[0] }, 'Ward updated successfully.');
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return errorResponse(res, 'A ward with this number already exists in this local body.', 409);
        }
        console.error('[updateWard]', err);
        return errorResponse(res, 'Server error updating ward.');
    }
};

// DELETE /api/local-bodies/:localBodyId/wards/:id
export const deleteWard = async (req, res) => {
    try {
        const { localBodyId, id } = req.params;
        const [result] = await db.query(
            'DELETE FROM local_body_wards WHERE id = ? AND local_body_id = ?',
            [id, localBodyId]
        );

        if (!result.affectedRows) {
            return errorResponse(res, 'Ward not found or does not belong to this local body.', 404);
        }

        return successResponse(res, {}, 'Ward deleted successfully.');
    } catch (err) {
        console.error('[deleteWard]', err);
        return errorResponse(res, 'Server error deleting ward.');
    }
};
// GET /api/wards/by-name/:name
export const getWardsByLocalBodyName = async (req, res) => {
    try {
        const { name } = req.params;
        const { page, limit, search } = req.query;

        // 1. Find local body ID by name
        const [lbRows] = await db.query('SELECT id FROM local_bodies WHERE name = ?', [name]);
        if (!lbRows.length) {
            return errorResponse(res, 'Local body not found by name.', 404);
        }
        const localBodyId = lbRows[0].id;

        if (!page || !limit) {
            const [rows] = await db.query(
                'SELECT * FROM local_body_wards WHERE local_body_id = ? ORDER BY CAST(ward_no AS UNSIGNED) ASC, ward_no ASC',
                [localBodyId]
            );
            return successResponse(res, {
                data: rows,
                local_body: { id: localBodyId, name }
            }, 'Wards fetched successfully by local body name.');
        }

        // 2. Reuse pagination logic (or copy for simplicity here)
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 6;
        const offset = (pageNum - 1) * limitNum;

        let query = 'SELECT * FROM local_body_wards WHERE local_body_id = ?';
        let countQuery = 'SELECT COUNT(*) as total FROM local_body_wards WHERE local_body_id = ?';
        const queryParams = [localBodyId];

        if (search) {
            query += ' AND (ward_no LIKE ? OR place_name LIKE ?)';
            countQuery += ' AND (ward_no LIKE ? OR place_name LIKE ?)';
            queryParams.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY CAST(ward_no AS UNSIGNED) ASC, ward_no ASC LIMIT ? OFFSET ?';

        const [rows] = await db.query(query, [...queryParams, limitNum, offset]);
        const [countResult] = await db.query(countQuery, queryParams);

        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limitNum);

        return successResponse(res, {
            data: rows,
            pagination: { total, page: pageNum, limit: limitNum, totalPages },
            local_body: { id: localBodyId, name }
        }, 'Wards fetched successfully by local body name.');
    } catch (err) {
        console.error('[getWardsByLocalBodyName]', err);
        return errorResponse(res, 'Server error fetching wards by local body name.');
    }
};
