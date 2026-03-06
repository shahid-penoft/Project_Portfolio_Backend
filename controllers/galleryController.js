import db from '../configs/db.js';
import { successResponse, errorResponse } from '../utils/helpers.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

const getFileType = (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return 'other';
};

// ─────────────────────────────────────────────────────────────
//  GET /api/gallery/images
//  Public — all event photos, grouped by event_type, searchable
// ─────────────────────────────────────────────────────────────
export const getGalleryImages = async (req, res) => {
    try {
        const { search, event_type_id } = req.query;

        const params = [];
        const mpParams = [];

        let emWhere = `WHERE em.media_type = 'photo'`;
        if (event_type_id) { emWhere += ' AND e.event_type_id = ?'; params.push(event_type_id); }
        if (search) { emWhere += ' AND (e.event_name LIKE ? OR em.caption LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

        let mpWhere = 'WHERE mp.video_url IS NULL AND mp.thumbnail_url IS NOT NULL';
        // Note: event_type_id doesn't apply directly to media_posts in the same way, 
        // but we can treat 'Media Centre' as a type.
        if (search) { mpWhere += ' AND mp.title LIKE ?'; mpParams.push(`%${search}%`); }

        const query = `
            SELECT * FROM (
                SELECT
                    em.id, em.file_url, em.thumbnail_url, em.caption, em.created_at,
                    e.id         AS event_id,
                    e.event_name,
                    e.event_date,
                    et.id        AS event_type_id,
                    et.type_name AS event_type
                FROM event_media em
                JOIN events      e  ON  e.id = em.event_id
                LEFT JOIN event_types et ON et.id  = e.event_type_id
                ${emWhere}
                
                UNION ALL
                
                SELECT
                    mp.id, mp.thumbnail_url AS file_url, mp.thumbnail_url, mp.title AS caption, mp.published_at AS created_at,
                    NULL AS event_id, mp.title AS event_name, mp.published_at AS event_date,
                    999 AS event_type_id, 'Media Centre' AS event_type
                FROM media_posts mp
                ${mpWhere}
            ) AS combined
            ORDER BY event_type ASC, event_date DESC
        `;

        const [rows] = await db.query(query, [...params, ...mpParams]);

        // Group by event type
        const grouped = {};
        for (const row of rows) {
            const key = row.event_type || 'Uncategorized';
            if (!grouped[key]) grouped[key] = { event_type_id: row.event_type_id, event_type: key, images: [] };
            grouped[key].images.push({
                id: row.id, file_url: row.file_url, thumbnail_url: row.thumbnail_url, caption: row.caption,
                event_id: row.event_id, event_name: row.event_name, event_date: row.event_date,
                created_at: row.created_at,
            });
        }

        return successResponse(res, {
            data: Object.values(grouped),
            total: rows.length,
        }, 'Gallery images fetched successfully.');
    } catch (err) {
        console.error('[getGalleryImages]', err);
        return errorResponse(res, 'Server error fetching gallery images.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/gallery/videos
//  Public — all event videos, grouped by event_type, searchable
// ─────────────────────────────────────────────────────────────
export const getGalleryVideos = async (req, res) => {
    try {
        const { search, event_type_id } = req.query;

        const params = [];
        const mpParams = [];

        let emWhere = `WHERE em.media_type = 'video'`;
        if (event_type_id) { emWhere += ' AND e.event_type_id = ?'; params.push(event_type_id); }
        if (search) { emWhere += ' AND (e.event_name LIKE ? OR em.caption LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

        let mpWhere = 'WHERE mp.video_url IS NOT NULL';
        if (search) { mpWhere += ' AND mp.title LIKE ?'; mpParams.push(`%${search}%`); }

        const query = `
            SELECT * FROM (
                SELECT
                    em.id, em.file_url, em.thumbnail_url, em.caption, em.created_at,
                    e.id         AS event_id,
                    e.event_name,
                    e.event_date,
                    et.id        AS event_type_id,
                    et.type_name AS event_type
                FROM event_media em
                JOIN events      e  ON  e.id = em.event_id
                LEFT JOIN event_types et ON et.id  = e.event_type_id
                ${emWhere}

                UNION ALL

                SELECT
                    mp.id, mp.video_url AS file_url, mp.thumbnail_url, mp.title AS caption, mp.published_at AS created_at,
                    NULL AS event_id, mp.title AS event_name, mp.published_at AS event_date,
                    999 AS event_type_id, 'Media Centre' AS event_type
                FROM media_posts mp
                ${mpWhere}
            ) AS combined
            ORDER BY event_type ASC, event_date DESC
        `;

        const [rows] = await db.query(query, [...params, ...mpParams]);

        // Group by event type
        const grouped = {};
        for (const row of rows) {
            const key = row.event_type || 'Uncategorized';
            if (!grouped[key]) grouped[key] = { event_type_id: row.event_type_id, event_type: key, videos: [] };
            grouped[key].videos.push({
                id: row.id, file_url: row.file_url, thumbnail_url: row.thumbnail_url, caption: row.caption,
                event_id: row.event_id, event_name: row.event_name, event_date: row.event_date,
                created_at: row.created_at,
            });
        }

        return successResponse(res, {
            data: Object.values(grouped),
            total: rows.length,
        }, 'Gallery videos fetched successfully.');
    } catch (err) {
        console.error('[getGalleryVideos]', err);
        return errorResponse(res, 'Server error fetching gallery videos.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/gallery/admin/files
//  Auth — lists all files in /uploads with pagination & type filter
// ─────────────────────────────────────────────────────────────
export const listUploadedFiles = (req, res) => {
    try {
        const { type, search } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, parseInt(req.query.limit, 10) || 24);

        if (!fs.existsSync(UPLOADS_DIR)) {
            return successResponse(res, { files: [], total: 0, page, limit, totalPages: 0 });
        }

        const entries = fs.readdirSync(UPLOADS_DIR);

        // Build enriched list
        let files = entries
            .map(filename => {
                const filePath = path.join(UPLOADS_DIR, filename);
                let stat;
                try { stat = fs.statSync(filePath); } catch { return null; }
                if (!stat.isFile()) return null;
                const fileType = getFileType(filename);
                if (fileType === 'other') return null; // skip non-media
                return {
                    filename,
                    type: fileType,
                    url: `/uploads/${filename}`,
                    size: stat.size,
                    created_at: stat.birthtime || stat.mtime,
                };
            })
            .filter(Boolean);

        // Filter by type
        if (type === 'image' || type === 'video') {
            files = files.filter(f => f.type === type);
        }

        // Filter by search (filename)
        if (search) {
            const q = search.toLowerCase();
            files = files.filter(f => f.filename.toLowerCase().includes(q));
        }

        // Sort newest first
        files.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const total = files.length;
        const totalPages = Math.ceil(total / limit);
        const paged = files.slice((page - 1) * limit, page * limit);

        return successResponse(res, { files: paged, total, page, limit, totalPages });
    } catch (err) {
        console.error('[listUploadedFiles]', err);
        return errorResponse(res, 'Failed to list uploaded files.');
    }
};

// ─────────────────────────────────────────────────────────────
//  DELETE /api/gallery/admin/files/:filename
//  Auth — permanently removes a file from /uploads
// ─────────────────────────────────────────────────────────────
export const deleteUploadedFile = (req, res) => {
    try {
        const { filename } = req.params;

        // Security: prevent path traversal
        if (!filename || filename.includes('/') || filename.includes('..')) {
            return errorResponse(res, 'Invalid filename.', 400);
        }

        const filePath = path.join(UPLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) {
            return errorResponse(res, 'File not found.', 404);
        }

        fs.unlinkSync(filePath);
        return successResponse(res, { filename }, 'File deleted successfully.');
    } catch (err) {
        console.error('[deleteUploadedFile]', err);
        return errorResponse(res, 'Failed to delete file.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/gallery/admin/media
//  Auth — flat paginated list from event_media & media_posts
// ─────────────────────────────────────────────────────────────
export const listAdminMedia = async (req, res) => {
    try {
        const { type, search } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, parseInt(req.query.limit, 10) || 24);
        const offset = (page - 1) * limit;

        const params = [];
        const mpParams = [];

        let emWhere = 'WHERE 1=1';
        if (type === 'photo' || type === 'video') {
            emWhere += ' AND em.media_type = ?';
            params.push(type);
        }
        if (search) {
            const like = `%${search}%`;
            emWhere += ' AND (e.event_name LIKE ? OR em.caption LIKE ?)';
            params.push(like, like);
        }

        let mpWhere = 'WHERE (mp.thumbnail_url IS NOT NULL OR mp.video_url IS NOT NULL)';
        if (type === 'photo') {
            mpWhere += ' AND mp.video_url IS NULL AND mp.thumbnail_url IS NOT NULL';
        } else if (type === 'video') {
            mpWhere += ' AND mp.video_url IS NOT NULL';
        }
        if (search) {
            const like = `%${search}%`;
            mpWhere += ' AND mp.title LIKE ?';
            mpParams.push(like);
        }

        const countQuery = `
            SELECT (
                SELECT COUNT(*) FROM event_media em JOIN events e ON e.id = em.event_id ${emWhere}
            ) + (
                SELECT COUNT(*) FROM media_posts mp ${mpWhere}
            ) AS total
        `;
        const [[{ total }]] = await db.query(countQuery, [...params, ...mpParams]);

        const query = `
            SELECT * FROM (
                SELECT
                    em.id, em.media_type AS type, em.file_url, em.thumbnail_url, em.caption, em.created_at,
                    e.id AS event_id, e.event_name, e.event_date, 'event' AS source
                FROM event_media em
                JOIN events e ON e.id = em.event_id
                ${emWhere}
                UNION ALL
                SELECT
                    mp.id, IF(mp.video_url IS NOT NULL, 'video', 'photo') AS type,
                    COALESCE(mp.video_url, mp.thumbnail_url) AS file_url,
                    mp.thumbnail_url, mp.title AS caption, mp.published_at AS created_at,
                    NULL AS event_id, mp.title AS event_name, mp.published_at AS event_date, 'media_centre' AS source
                FROM media_posts mp
                ${mpWhere}
            ) AS combined
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `;

        const [rows] = await db.query(query, [...params, ...mpParams, limit, offset]);

        return successResponse(res, {
            data: rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        console.error('[listAdminMedia]', err);
        return errorResponse(res, 'Failed to list media.');
    }
};

// ─────────────────────────────────────────────────────────────
//  DELETE /api/gallery/admin/media/:id
//  Auth — removes a row from event_media or media_posts (if source provided)
// ─────────────────────────────────────────────────────────────
export const deleteEventMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const { source } = req.query;

        if (source === 'media_centre') {
            const [[row]] = await db.query('SELECT thumbnail_url, video_url FROM media_posts WHERE id = ?', [id]);
            if (!row) return errorResponse(res, 'Media post not found.', 404);

            // For media posts, we usually don't delete the post itself when "deleting media"
            // unless the context is purely gallery management.
            // Requirement says "removes a row from event_media and deletes the file from disk".
            // For media_posts, it's a bit different because the "media" IS the post or its primary attachment.
            // If we are in the gallery, "deleting" it probably means removing the thumbnail/video or the post.
            // Let's assume we delete the URLs from the post to "remove it from gallery".
            await db.query('UPDATE media_posts SET thumbnail_url = NULL, video_url = NULL WHERE id = ?', [id]);
            return successResponse(res, { id }, 'Media post removed from gallery.');
        }

        // Default: event_media
        const [[row]] = await db.query('SELECT * FROM event_media WHERE id = ?', [id]);
        if (!row) return errorResponse(res, 'Media not found.', 404);

        // Delete physical file
        if (row.file_url?.startsWith('/uploads/') || row.file_url?.startsWith('uploads/')) {
            const filename = path.basename(row.file_url);
            const filePath = path.join(UPLOADS_DIR, filename);
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
        }
        if (row.thumbnail_url?.startsWith('/uploads/') || row.thumbnail_url?.startsWith('uploads/')) {
            const thumbName = path.basename(row.thumbnail_url);
            const thumbPath = path.join(UPLOADS_DIR, thumbName);
            try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch (_) { }
        }

        await db.query('DELETE FROM event_media WHERE id = ?', [id]);
        return successResponse(res, { id }, 'Media deleted successfully.');
    } catch (err) {
        console.error('[deleteEventMedia]', err);
        return errorResponse(res, 'Failed to delete media.');
    }
};



const paginatedGalleryResponse = async (res, mediaType, conditions, params, req, label) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 24);
    const offset = (page - 1) * limit;
    const search = req.query.search || req.query.q;

    const type = mediaType === 'photo' ? 'photo' : 'video';

    // Event Conditions
    const emConditions = [`em.media_type = '${type}'`, ...conditions];
    const emParams = [...params];
    if (search) {
        emConditions.push('(e.event_name LIKE ? OR em.caption LIKE ?)');
        emParams.push(`%${search}%`, `%${search}%`);
    }
    const emWhere = `WHERE ${emConditions.join(' AND ')}`;

    // Media Centre Conditions
    const mpConditions = [];
    if (type === 'photo') {
        mpConditions.push('mp.video_url IS NULL AND mp.thumbnail_url IS NOT NULL');
    } else {
        mpConditions.push('mp.video_url IS NOT NULL');
    }
    const mpParams = [];
    if (search) {
        mpConditions.push('mp.title LIKE ?');
        mpParams.push(`%${search}%`);
    }
    // If filtering by LB or Sector, and Media Centre doesn't have them, 
    // we should probably empty the MP results or exclude them.
    // For now, if 'conditions' (like local_body_id) are present, we skip MP.
    const isFiltered = conditions.some(c => c.includes('local_body_id') || c.includes('sector_id') || c.includes('YEAR(e.event_date)'));
    const mpWhere = (!isFiltered && mpConditions.length) ? `WHERE ${mpConditions.join(' AND ')}` : 'WHERE 1=0';

    const sql = `
        SELECT * FROM (
            SELECT
                em.id, em.file_url, em.thumbnail_url, em.caption, em.media_type AS type, em.created_at,
                e.id         AS event_id,
                e.event_name,
                e.event_date,
                YEAR(e.event_date) AS year,
                et.type_name AS event_type,
                lb.name      AS local_body_name,
                s.name       AS sector_name,
                'event'      AS source
            FROM event_media em
            JOIN   events      e  ON  e.id = em.event_id
            LEFT JOIN event_types et ON et.id = e.event_type_id
            LEFT JOIN local_bodies lb ON lb.id = e.local_body_id
            LEFT JOIN sectors      s  ON  s.id = e.sector_id
            ${emWhere}

            UNION ALL

            SELECT
                mp.id, COALESCE(mp.video_url, mp.thumbnail_url) AS file_url, mp.thumbnail_url, mp.title AS caption,
                IF(mp.video_url IS NOT NULL, 'video', 'photo') AS type, mp.published_at AS created_at,
                NULL AS event_id, mp.title AS event_name, mp.published_at AS event_date,
                YEAR(mp.published_at) AS year,
                'Media Centre' AS event_type,
                NULL AS local_body_name,
                NULL AS sector_name,
                'media_centre' AS source
            FROM media_posts mp
            ${mpWhere}
        ) AS combined
        ORDER BY event_date DESC, id DESC`;

    const allParams = [...emParams, ...mpParams];

    // Count total
    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS c`;
    const [[{ total }]] = await db.query(countSql, allParams);

    const [rows] = await db.query(`${sql} LIMIT ? OFFSET ?`, [...allParams, limit, offset]);

    return successResponse(res, {
        data: rows,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }, `${label} fetched successfully.`);
};

// ─── Images: by local body ──────────────────────────────────────────────────
// GET /api/gallery/images/local-body/:id
export const getImagesByLocalBody = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'photo',
            ['e.local_body_id = ?'], [req.params.id], req,
            'Images by local body');
    } catch (err) {
        console.error('[getImagesByLocalBody]', err);
        return errorResponse(res, 'Server error fetching images.');
    }
};

// ─── Images: by sector ─────────────────────────────────────────────────────
// GET /api/gallery/images/sector/:id
export const getImagesBySector = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'photo',
            ['e.sector_id = ?'], [req.params.id], req,
            'Images by sector');
    } catch (err) {
        console.error('[getImagesBySector]', err);
        return errorResponse(res, 'Server error fetching images.');
    }
};

// ─── Images: by year ───────────────────────────────────────────────────────
// GET /api/gallery/images/year/:year
export const getImagesByYear = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'photo',
            ['YEAR(e.event_date) = ?'], [req.params.year], req,
            'Images by year');
    } catch (err) {
        console.error('[getImagesByYear]', err);
        return errorResponse(res, 'Server error fetching images.');
    }
};

// ─── Images: search by event name ──────────────────────────────────────────
// GET /api/gallery/images/search?q=...
export const searchImages = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'photo', [], [], req, 'Images search');
    } catch (err) {
        console.error('[searchImages]', err);
        return errorResponse(res, 'Server error searching images.');
    }
};

// ─── Videos: by local body ─────────────────────────────────────────────────
// GET /api/gallery/videos/local-body/:id
export const getVideosByLocalBody = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'video',
            ['e.local_body_id = ?'], [req.params.id], req,
            'Videos by local body');
    } catch (err) {
        console.error('[getVideosByLocalBody]', err);
        return errorResponse(res, 'Server error fetching videos.');
    }
};

// ─── Videos: by sector ─────────────────────────────────────────────────────
// GET /api/gallery/videos/sector/:id
export const getVideosBySector = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'video',
            ['e.sector_id = ?'], [req.params.id], req,
            'Videos by sector');
    } catch (err) {
        console.error('[getVideosBySector]', err);
        return errorResponse(res, 'Server error fetching videos.');
    }
};

// ─── Videos: by year ───────────────────────────────────────────────────────
// GET /api/gallery/videos/year/:year
export const getVideosByYear = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'video',
            ['YEAR(e.event_date) = ?'], [req.params.year], req,
            'Videos by year');
    } catch (err) {
        console.error('[getVideosByYear]', err);
        return errorResponse(res, 'Server error fetching videos.');
    }
};

// ─── Videos: search by event name ──────────────────────────────────────────
// GET /api/gallery/videos/search?q=...
export const searchVideos = async (req, res) => {
    try {
        await paginatedGalleryResponse(res, 'video', [], [], req, 'Videos search');
    } catch (err) {
        console.error('[searchVideos]', err);
        return errorResponse(res, 'Server error searching videos.');
    }
};

