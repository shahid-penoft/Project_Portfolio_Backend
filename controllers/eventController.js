import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../configs/db.js';
import { uploadMedia, uploadMediaFields, uploadImage, runMulter } from '../configs/multer.js';
import { successResponse, errorResponse } from '../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
//  HELPER — Compute status automatically from event_date + event_time
//  Logic:
//    • If event datetime has not started yet             → 'upcoming'
//    • If event is within the ongoing window (2 hours)   → 'ongoing'
//    • If event datetime + ongoing window has passed     → 'past'
// ─────────────────────────────────────────────────────────────
const ONGOING_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

function computeStatus(event_date, event_time) {
    // Build a JS Date from the stored date + time values
    // event_date can be a Date object (from MySQL) or a string 'YYYY-MM-DD'
    // event_time can be a string 'HH:MM:SS' or 'HH:MM'
    const dateStr = event_date instanceof Date
        ? event_date.toISOString().slice(0, 10)
        : String(event_date).slice(0, 10);          // 'YYYY-MM-DD'

    const timeStr = String(event_time || '00:00:00').slice(0, 8); // 'HH:MM:SS'

    const eventStart = new Date(`${dateStr}T${timeStr}`);
    const eventEnd = new Date(eventStart.getTime() + ONGOING_WINDOW_MS);
    const now = new Date();

    if (now < eventStart) return 'upcoming';
    if (now <= eventEnd) return 'ongoing';
    return 'past';
}

// ─────────────────────────────────────────────────────────────
//  GET /api/events
//  Public — paginated list with optional filters
// ─────────────────────────────────────────────────────────────
export const getAllEvents = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 10);
        const offset = (page - 1) * limit;

        const { status, event_type_id, local_body_id, sector_id, search } = req.query;

        let where = 'WHERE 1=1';
        const params = [];

        if (status) { where += ' AND e.status = ?'; params.push(status); }
        if (event_type_id) { where += ' AND e.event_type_id = ?'; params.push(event_type_id); }
        if (local_body_id) { where += ' AND e.local_body_id = ?'; params.push(local_body_id); }
        if (sector_id) { where += ' AND e.sector_id = ?'; params.push(sector_id); }
        if (search) { where += ' AND e.event_name LIKE ?'; params.push(`%${search}%`); }

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM events e ${where}`, params
        );

        const [rows] = await db.query(
            `SELECT e.*,
              et.type_name,
              lb.name AS local_body_name,
              s.name  AS sector_name,
              (SELECT file_url FROM event_media em WHERE em.event_id = e.id AND em.media_type = 'photo' LIMIT 1) AS cover_image
       FROM events e
       LEFT JOIN event_types  et ON et.id = e.event_type_id
       LEFT JOIN local_bodies lb ON lb.id = e.local_body_id
       LEFT JOIN sectors       s ON  s.id = e.sector_id
       ${where}
       ORDER BY e.event_date DESC
       LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return successResponse(res, {
            data: rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        }, 'Events fetched successfully.');
    } catch (err) {
        console.error('[getAllEvents]', err);
        return errorResponse(res, 'Server error fetching events.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/events/by-status?status=upcoming|ongoing|past
//  Public — fetch events filtered by auto-computed status
//  Supports optional pagination: ?page=1&limit=10
// ─────────────────────────────────────────────────────────────
export const getEventsByStatus = async (req, res) => {
    try {
        const { status } = req.query;
        const VALID = ['upcoming', 'ongoing', 'past'];

        if (!status || !VALID.includes(status)) {
            return errorResponse(
                res,
                `status query param is required and must be one of: ${VALID.join(', ')}.`,
                400
            );
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 10);
        const offset = (page - 1) * limit;

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM events e WHERE e.status = ?`, [status]
        );

        const [rows] = await db.query(
            `SELECT e.*,
              et.type_name,
              lb.name AS local_body_name,
              s.name  AS sector_name,
              (SELECT file_url FROM event_media em WHERE em.event_id = e.id AND em.media_type = 'photo' LIMIT 1) AS cover_image
       FROM events e
       LEFT JOIN event_types  et ON et.id = e.event_type_id
       LEFT JOIN local_bodies lb ON lb.id = e.local_body_id
       LEFT JOIN sectors       s ON  s.id = e.sector_id
       WHERE e.status = ?
       ORDER BY e.event_date DESC
       LIMIT ? OFFSET ?`,
            [status, limit, offset]
        );

        return successResponse(res, {
            data: rows,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        }, `${status.charAt(0).toUpperCase() + status.slice(1)} events fetched successfully.`);
    } catch (err) {
        console.error('[getEventsByStatus]', err);
        return errorResponse(res, 'Server error fetching events by status.');
    }
};

// ─────────────────────────────────────────────────────────────
//  GET /api/events/:id
//  Public — full event detail with content blocks and media
// ─────────────────────────────────────────────────────────────
export const getEventById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await db.query(
            `SELECT e.*,
              et.type_name,
              lb.name AS local_body_name,
              s.name  AS sector_name
       FROM events e
       LEFT JOIN event_types  et ON et.id = e.event_type_id
       LEFT JOIN local_bodies lb ON lb.id = e.local_body_id
       LEFT JOIN sectors       s ON  s.id = e.sector_id
       WHERE e.id = ?`,
            [id]
        );
        if (!rows.length) return errorResponse(res, 'Event not found.', 404);

        const event = rows[0];

        // Fetch ordered content paragraphs
        const [content] = await db.query(
            'SELECT * FROM event_content WHERE event_id = ? ORDER BY content_order ASC',
            [id]
        );

        // Fetch all media items
        const [media] = await db.query(
            'SELECT * FROM event_media WHERE event_id = ? ORDER BY created_at ASC',
            [id]
        );

        return successResponse(res, {
            data: {
                ...event,
                content,
                media: {
                    photos: media.filter(m => m.media_type === 'photo'),
                    videos: media.filter(m => m.media_type === 'video'),
                },
            },
        }, 'Event fetched successfully.');
    } catch (err) {
        console.error('[getEventById]', err);
        return errorResponse(res, 'Server error fetching event.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/events  (Auth)
//  Status is auto-computed; any status in body is ignored.
// ─────────────────────────────────────────────────────────────
export const createEvent = async (req, res) => {
    try {
        const {
            event_name, event_date, event_time, event_time_to, venue,
            short_description,
            event_type_id, local_body_id, sector_id,
        } = req.body;

        if (!event_name || !event_date || !event_time || !venue)
            return errorResponse(res, 'event_name, event_date, event_time, and venue are required.', 400);

        // Auto-compute status — body value is intentionally ignored
        const status = computeStatus(event_date, event_time);

        const [result] = await db.query(
            `INSERT INTO events
         (event_name, event_date, event_time, event_time_to, venue, short_description, status, event_type_id, local_body_id, sector_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                event_name, event_date, event_time, event_time_to || null, venue,
                short_description || null, status,
                event_type_id || null, local_body_id || null, sector_id || null,
            ]
        );

        const [rows] = await db.query('SELECT * FROM events WHERE id = ?', [result.insertId]);
        return successResponse(res, { data: rows[0] }, 'Event created successfully.', 201);
    } catch (err) {
        console.error('[createEvent]', err);
        return errorResponse(res, 'Server error creating event.');
    }
};

// ─────────────────────────────────────────────────────────────
//  PUT /api/events/:id  (Auth)
//  Status is auto-computed; any status in body is ignored.
// ─────────────────────────────────────────────────────────────
export const updateEvent = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            event_name, event_date, event_time, event_time_to, venue,
            short_description,
            event_type_id, local_body_id, sector_id,
        } = req.body;

        if (!event_name || !event_date || !event_time || !venue)
            return errorResponse(res, 'event_name, event_date, event_time, and venue are required.', 400);

        // Auto-compute status — body value is intentionally ignored
        const status = computeStatus(event_date, event_time);

        const [result] = await db.query(
            `UPDATE events SET
         event_name = ?, event_date = ?, event_time = ?, event_time_to = ?, venue = ?,
         short_description = ?, status = ?,
         event_type_id = ?, local_body_id = ?, sector_id = ?
       WHERE id = ?`,
            [
                event_name, event_date, event_time, event_time_to || null, venue,
                short_description || null, status,
                event_type_id || null, local_body_id || null, sector_id || null,
                id,
            ]
        );
        if (!result.affectedRows) return errorResponse(res, 'Event not found.', 404);
        const [rows] = await db.query('SELECT * FROM events WHERE id = ?', [id]);
        return successResponse(res, { data: rows[0] }, 'Event updated successfully.');
    } catch (err) {
        console.error('[updateEvent]', err);
        return errorResponse(res, 'Server error updating event.');
    }
};

// ─────────────────────────────────────────────────────────────
//  DELETE /api/events/:id  (Auth)
// ─────────────────────────────────────────────────────────────
export const deleteEvent = async (req, res) => {
    try {
        const { id } = req.params;

        // Delete physical media files first
        const [mediaRows] = await db.query('SELECT file_url FROM event_media WHERE event_id = ?', [id]);
        for (const row of mediaRows) {
            const filePath = path.join(__dirname, '..', row.file_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        const [result] = await db.query('DELETE FROM events WHERE id = ?', [id]);
        if (!result.affectedRows) return errorResponse(res, 'Event not found.', 404);
        return successResponse(res, {}, 'Event deleted successfully.');
    } catch (err) {
        console.error('[deleteEvent]', err);
        return errorResponse(res, 'Server error deleting event.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/events/:id/content  (Auth)
//  Replace all content paragraphs for an event
// ─────────────────────────────────────────────────────────────
export const saveEventContent = async (req, res) => {
    try {
        const { id } = req.params;
        const { paragraphs } = req.body; // Array of { content_order, paragraph_text }

        if (!Array.isArray(paragraphs) || !paragraphs.length)
            return errorResponse(res, 'paragraphs must be a non-empty array.', 400);

        // Check event exists
        const [evtRows] = await db.query('SELECT id FROM events WHERE id = ?', [id]);
        if (!evtRows.length) return errorResponse(res, 'Event not found.', 404);

        // Delete existing content and replace
        await db.query('DELETE FROM event_content WHERE event_id = ?', [id]);

        const values = paragraphs.map((p, i) => [id, p.content_order ?? i, p.paragraph_text || '']);
        await db.query(
            'INSERT INTO event_content (event_id, content_order, paragraph_text) VALUES ?',
            [values]
        );

        const [content] = await db.query(
            'SELECT * FROM event_content WHERE event_id = ? ORDER BY content_order ASC', [id]
        );
        return successResponse(res, { data: content }, 'Event content saved successfully.');
    } catch (err) {
        console.error('[saveEventContent]', err);
        return errorResponse(res, 'Server error saving event content.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/events/:id/media  (Auth + Multer)
//  Upload a single photo or video with optional caption + thumbnail
// ─────────────────────────────────────────────────────────────
export const addEventMedia = async (req, res) => {
    try {
        // Accept two fields: 'file' (the media) and 'thumbnail' (optional)
        await new Promise((resolve, reject) =>
            uploadMediaFields(req, res, (err) => (err ? reject(err) : resolve()))
        );

        const { id } = req.params;
        const { caption, media_type } = req.body;

        const mainFile = req.files?.file?.[0];
        const thumbFile = req.files?.thumbnail?.[0];

        if (!mainFile)
            return errorResponse(res, 'No file uploaded.', 400);

        if (!['photo', 'video'].includes(media_type))
            return errorResponse(res, 'media_type must be "photo" or "video".', 400);

        // Check event exists
        const [evtRows] = await db.query('SELECT id FROM events WHERE id = ?', [id]);
        if (!evtRows.length) {
            fs.unlinkSync(mainFile.path);
            if (thumbFile) fs.unlinkSync(thumbFile.path);
            return errorResponse(res, 'Event not found.', 404);
        }

        const fileUrl = `uploads/${mainFile.filename}`;
        const thumbnailUrl = thumbFile ? `uploads/${thumbFile.filename}` : null;

        const [result] = await db.query(
            'INSERT INTO event_media (event_id, media_type, file_url, thumbnail_url, caption) VALUES (?, ?, ?, ?, ?)',
            [id, media_type, fileUrl, thumbnailUrl, caption || null]
        );

        const [rows] = await db.query('SELECT * FROM event_media WHERE id = ?', [result.insertId]);
        return successResponse(res, { data: rows[0] }, 'Media uploaded successfully.', 201);
    } catch (err) {
        if (req.files?.file?.[0]?.path && fs.existsSync(req.files.file[0].path)) fs.unlinkSync(req.files.file[0].path);
        if (req.files?.thumbnail?.[0]?.path && fs.existsSync(req.files.thumbnail[0].path)) fs.unlinkSync(req.files.thumbnail[0].path);
        console.error('[addEventMedia]', err);
        return errorResponse(res, err.message || 'Server error uploading media.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/events/:id/youtube  (Auth + optional thumbnail upload)
//  Add a YouTube embedded video link with optional thumbnail
// ─────────────────────────────────────────────────────────────
export const addYouTubeMedia = async (req, res) => {
    try {
        // Accept optional thumbnail image
        const thumbUpload = uploadImage.single('thumbnail');
        await new Promise((resolve, reject) =>
            thumbUpload(req, res, (err) => (err ? reject(err) : resolve()))
        );

        const { id } = req.params;
        const { youtube_url, caption } = req.body;

        if (!youtube_url || !youtube_url.trim())
            return errorResponse(res, 'youtube_url is required.', 400);

        // Normalise: accept full URL or just video ID, always store embed URL
        const embedUrl = normaliseYouTubeUrl(youtube_url.trim());
        if (!embedUrl)
            return errorResponse(res, 'Invalid YouTube URL or video ID.', 400);

        const [evtRows] = await db.query('SELECT id FROM events WHERE id = ?', [id]);
        if (!evtRows.length) {
            if (req.file) fs.unlinkSync(req.file.path);
            return errorResponse(res, 'Event not found.', 404);
        }

        const thumbnailUrl = req.file ? `uploads/${req.file.filename}` : null;

        const [result] = await db.query(
            'INSERT INTO event_media (event_id, media_type, file_url, thumbnail_url, youtube_url, caption) VALUES (?, ?, ?, ?, ?, ?)',
            [id, 'video', embedUrl, thumbnailUrl, embedUrl, caption || null]
        );

        const [rows] = await db.query('SELECT * FROM event_media WHERE id = ?', [result.insertId]);
        return successResponse(res, { data: rows[0] }, 'YouTube video added successfully.', 201);
    } catch (err) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('[addYouTubeMedia]', err);
        return errorResponse(res, err.message || 'Server error adding YouTube video.');
    }
};

/** Convert any YouTube URL form to embed URL, or return null if invalid */
function normaliseYouTubeUrl(input) {
    // Already an embed URL
    if (input.includes('youtube.com/embed/')) return input;
    // youtu.be short link
    const shortMatch = input.match(/youtu\.be\/([\w-]{11})/);
    if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
    // Standard watch URL
    const watchMatch = input.match(/[?&]v=([\w-]{11})/);
    if (watchMatch) return `https://www.youtube.com/embed/${watchMatch[1]}`;
    // 11-char raw video ID
    if (/^[\w-]{11}$/.test(input)) return `https://www.youtube.com/embed/${input}`;
    return null;
}


// ─────────────────────────────────────────────────────────────
//  DELETE /api/events/media/:mediaId  (Auth)
// ─────────────────────────────────────────────────────────────
export const deleteEventMedia = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const [rows] = await db.query('SELECT * FROM event_media WHERE id = ?', [mediaId]);
        if (!rows.length) return errorResponse(res, 'Media item not found.', 404);

        // Delete physical file (main + thumbnail)
        const deleteFile = (relPath) => {
            if (!relPath || relPath.startsWith('http')) return;
            const fp = path.join(__dirname, '..', relPath);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        };
        deleteFile(rows[0].file_url);
        deleteFile(rows[0].thumbnail_url);

        await db.query('DELETE FROM event_media WHERE id = ?', [mediaId]);
        return successResponse(res, {}, 'Media deleted successfully.');
    } catch (err) {
        console.error('[deleteEventMedia]', err);
        return errorResponse(res, 'Server error deleting media.');
    }
};

// ─────────────────────────────────────────────────────────────
//  POST /api/events/:id/upload-inline-image  (Auth + Multer)
//  Upload image inline for rich text editor
//  Returns { url: '/uploads/...' } for Quill to insert
// ─────────────────────────────────────────────────────────────
export const uploadInlineImage = async (req, res) => {
    try {
        await runMulter(uploadImage, req, res);

        const { id } = req.params;

        if (!req.file)
            return errorResponse(res, 'No image file uploaded.', 400);

        // Check event exists
        const [evtRows] = await db.query('SELECT id FROM events WHERE id = ?', [id]);
        if (!evtRows.length) {
            // Clean up orphaned upload
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return errorResponse(res, 'Event not found.', 404);
        }

        const imageUrl = `/uploads/${req.file.filename}`;
        // Return full URL for image embed in rich text editor
        const fullUrl = `${req.protocol}://${req.get('host')}${imageUrl}`;
        return successResponse(res, { url: fullUrl }, 'Image uploaded for editor.');
    } catch (err) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('[uploadInlineImage]', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
            return errorResponse(res, 'Image too large (max 10 MB).', 413);
        }
        return errorResponse(res, err.message || 'Server error uploading image.');
    }
};
