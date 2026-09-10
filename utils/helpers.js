import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import db from '../configs/db.js';
/**
 * Generate a secure random token (hex string)
 */
export const generateToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/**
 * Return UTC datetime N minutes from now (for DB storage)
 */
export const minutesFromNow = (minutes) => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + minutes);
    // MySQL DATETIME format
    return d.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Create a short link in the database and return the short URL.
 */
export const createShortLink = async (longUrl, minutesValid = 30) => {
    // Generate an 8-character alphanumeric short code
    const code = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';

    await db.query(
        'INSERT INTO short_links (code, long_url, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)',
        [code, longUrl, minutesValid]
    );

    return `${backendUrl}/api/r/${code}`;
};

/**
 * Standard API success response
 */
export const successResponse = (res, data = {}, message = 'Success', statusCode = 200) =>
    res.status(statusCode).json({ success: true, message, ...data });

/**
 * Standard API error response
 */
export const errorResponse = (res, message = 'Something went wrong', statusCode = 500) =>
    res.status(statusCode).json({ success: false, message });
/**
 * Convert string to URL-friendly slug
 */
export const slugify = (text) => {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/gu, '-')                    // Replace spaces with - (Unicode-aware)
        .replace(/[^\p{L}\p{N}-]+/gu, '')         // Remove all non-word chars (Unicode letters/digits)
        .replace(/--+/g, '-')                     // Replace multiple - with single -
        .replace(/^-+/, '')                       // Trim - from start of text
        .replace(/-+$/, '');                      // Trim - from end of text
};

/**
 * Rename an array of uploaded image URLs to an SEO-friendly name based on a title.
 * e.g. ["/uploads/IMG1.jpg", "/uploads/IMG2.png"] -> ["/uploads/my-title.jpg", "/uploads/my-title-(1).png"]
 */
export const renameMediaToSeoFriendly = (urls, baseTitle) => {
    if (!urls || !Array.isArray(urls) || urls.length === 0 || !baseTitle) return urls;

    const baseSlug = slugify(baseTitle);
    const newUrls = [];

    // Assuming uploads are mapped to the 'uploads' folder in the project root
    // For safety, we resolve the absolute path relative to `helpers.js` location (which is Backend/utils)
    const backendRoot = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([a-zA-Z]:\/)/, '$1'), '..');

    urls.forEach((url, index) => {
        if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
            newUrls.push(url); // Skip external URLs or malformed strings
            return;
        }

        const oldPath = path.join(backendRoot, url);
        if (!fs.existsSync(oldPath)) {
            newUrls.push(url); // Skip if file doesn't actually exist on disk
            return;
        }

        const ext = path.extname(url); // e.g., .jpg
        const suffix = index === 0 ? '' : `-(${index})`;
        const newFilename = `${baseSlug}${suffix}${ext}`;
        const newUrl = `/uploads/${newFilename}`;
        const newPath = path.join(backendRoot, newUrl);

        try {
            // Only rename if the new name is actually different
            if (oldPath !== newPath) {
                // If a file with the new name already exists (rare but possible), we can just overwrite or add a timestamp
                // Using renameSync will overwrite on most systems.
                fs.renameSync(oldPath, newPath);
            }
            newUrls.push(newUrl);
        } catch (err) {
            console.error(`[renameMediaToSeoFriendly] Failed to rename ${oldPath} to ${newPath}:`, err);
            newUrls.push(url); // Fallback to original URL if rename fails
        }
    });

    return newUrls;
};
