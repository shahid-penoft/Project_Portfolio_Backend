import pool from '../configs/db.js';
import { successResponse, errorResponse } from '../utils/helpers.js';

// Get all templates
export const getAllTemplates = async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM message_templates ORDER BY created_at DESC');
        return successResponse(res, { data: rows }, 'Templates fetched successfully.');
    } catch (err) {
        console.error('[getAllTemplates]', err);
        return errorResponse(res, 'Failed to fetch templates.');
    }
};

// Get template by ID
export const getTemplateById = async (req, res) => {
    try {
        const [[row]] = await pool.query('SELECT * FROM message_templates WHERE id = ?', [req.params.id]);
        if (!row) return errorResponse(res, 'Template not found.', 404);
        return successResponse(res, { data: row }, 'Template fetched successfully.');
    } catch (err) {
        console.error('[getTemplateById]', err);
        return errorResponse(res, 'Failed to fetch template.');
    }
};

// Create template
export const createTemplate = async (req, res) => {
    const { name, type, subject, header_type, header_url, content, buttons_json, is_active } = req.body;

    if (!name || !type || !content) {
        return errorResponse(res, 'Name, type, and content are required.', 400);
    }

    try {
        const [result] = await pool.query(
            `INSERT INTO message_templates 
             (name, type, subject, header_type, header_url, content, buttons_json, is_active) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                type,
                subject || null,
                header_type || 'none',
                header_url || null,
                content,
                buttons_json ? JSON.stringify(buttons_json) : null,
                is_active !== undefined ? is_active : 1
            ]
        );
        return successResponse(res, { id: result.insertId }, 'Template created successfully.', 201);
    } catch (err) {
        console.error('[createTemplate]', err);
        return errorResponse(res, 'Failed to create template.');
    }
};

// Update template
export const updateTemplate = async (req, res) => {
    const { name, type, subject, header_type, header_url, content, buttons_json, is_active } = req.body;

    try {
        const [result] = await pool.query(
            `UPDATE message_templates 
             SET name = ?, type = ?, subject = ?, header_type = ?, header_url = ?, content = ?, buttons_json = ?, is_active = ? 
             WHERE id = ?`,
            [
                name,
                type,
                subject || null,
                header_type || 'none',
                header_url || null,
                content,
                buttons_json ? JSON.stringify(buttons_json) : null,
                is_active !== undefined ? is_active : 1,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) return errorResponse(res, 'Template not found.', 404);
        return successResponse(res, null, 'Template updated successfully.');
    } catch (err) {
        console.error('[updateTemplate]', err);
        return errorResponse(res, 'Failed to update template.');
    }
};

// Delete template
export const deleteTemplate = async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM message_templates WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return errorResponse(res, 'Template not found.', 404);
        return successResponse(res, null, 'Template deleted successfully.');
    } catch (err) {
        console.error('[deleteTemplate]', err);
        return errorResponse(res, 'Failed to delete template.');
    }
};
