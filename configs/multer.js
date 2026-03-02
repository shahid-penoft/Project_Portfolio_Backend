import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ─── Storage engine ───────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    },
});

// ─── File type filter ─────────────────────────────────────────
const fileFilter = (req, file, cb) => {
    const allowed = [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'video/webm', 'video/quicktime',
    ];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    }
};

// ─── File type filter for icons (SVG, PNG, etc) ──────────────
const iconFileFilter = (req, file, cb) => {
    const allowed = [
        'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'
    ];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Icon file type not allowed: ${file.mimetype}`), false);
    }
};

// ─── Exports for different size limits ───────────────────────
export const uploadImage = multer({
    storage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).single('file');

export const uploadVideo = multer({
    storage,
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
}).single('file');

export const uploadMedia = multer({
    storage,
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 },
}).single('file');

export const uploadMediaFields = multer({
    storage,
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 },
}).fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
]);

export const uploadThumbnail = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('thumbnail');

export const uploadVisualStoryFiles = multer({
    storage,
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
}).fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
]);

// ─── Icon uploads (for Ente Nadu, etc) ──────────────────────
const iconStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const iconDir = path.join(uploadDir, 'ente-nadu-icons');
        if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });
        cb(null, iconDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    },
});

export const uploadIcon = multer({
    storage: iconStorage,
    fileFilter: iconFileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB for icons
}).single('icon');

// Helper: wrap multer in a promise (for use inside async controllers)
export const runMulter = (multerFn, req, res) =>
    new Promise((resolve, reject) =>
        multerFn(req, res, (err) => (err ? reject(err) : resolve()))
    );

// Safe wrapper for uploadIcon that ensures req.body exists
export const safeUploadIcon = (req, res, next) => {
    uploadIcon(req, res, (err) => {
        // Ensure req.body is an object
        if (!req.body) req.body = {};

        // Log any multer errors but don't fail the request
        if (err) {
            console.warn('Multer error (non-fatal):', err.message);
        }

        next();
    });
};
