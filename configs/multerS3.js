import multer from 'multer';
import multerS3 from 'multer-s3';
import { S3Client } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// ─── S3 Config ───────────────────────────────────────────
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});

const s3Bucket = process.env.AWS_S3_BUCKET || 'my-portfolio-bucket';

// ─── File type filter ─────────────────────────────────────────
const fileFilter = (req, file, cb) => {
    // Decode latin1 to utf8 for international characters like Malayalam
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    fs.appendFileSync('multer_debug.log', `fileFilter called for: ${file.originalname} mimetype: ${file.mimetype}\n`);
    // User requested to allow all file types
    cb(null, true);
};

const iconFileFilter = (req, file, cb) => {
    // Decode latin1 to utf8 for international characters like Malayalam
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const allowed = [
        'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'
    ];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Icon file type not allowed: ${file.mimetype}`), false);
    }
};

// ─── Base S3 Storage Configuration ────────────────────────────
const s3StorageOptions = (folder = 'uploads') => ({
    s3: s3Client,
    bucket: s3Bucket,
    acl: (req, file, cb) => cb(null, undefined), // Do not pass ACL header (prevents "The bucket does not allow ACLs" error)
    contentType: (req, file, cb) => {
        cb(null, file.mimetype);
    },
    key: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        // Replace spaces and invalid file system/URL characters with a hyphen, but preserve unicode letters.
        const name = file.originalname.replace(/[\s\/\\:*?"<>|]/g, '-');
        cb(null, `${folder}/${uniqueSuffix}-${name}`);
    },
});

// ─── Exports for different size limits ───────────────────────
export const uploadDocument = multer({
    storage: multerS3(s3StorageOptions('documents')),
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
}).single('file');

export const uploadImage = multer({
    storage: multerS3(s3StorageOptions('images')),
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
}).fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
]);

export const uploadVideo = multer({
    storage: multerS3(s3StorageOptions('videos')),
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
}).single('file');

export const uploadMedia = multer({
    storage: multerS3(s3StorageOptions('media')),
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 },
}).single('file');

export const uploadMediaArray = multer({
    storage: multerS3(s3StorageOptions('media')),
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
}).array('media');

export const uploadMediaFields = multer({
    storage: multerS3(s3StorageOptions('media')),
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 },
}).fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
]);

export const uploadThumbnail = multer({
    storage: multerS3(s3StorageOptions('thumbnails')),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('thumbnail');

export const uploadVisualStoryFiles = multer({
    storage: multerS3(s3StorageOptions('visual-stories')),
    fileFilter,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
}).fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
]);

export const uploadIcon = multer({
    storage: multerS3(s3StorageOptions('ente-nadu-icons')),
    fileFilter: iconFileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
}).single('icon');

export const uploadJobDocuments = multer({
    storage: multerS3(s3StorageOptions('job-applications')),
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
}).array('documents');

export const uploadGoverningBodyPhoto = multer({
    storage: multerS3(s3StorageOptions('governing-bodies')),
    fileFilter: iconFileFilter, // Only allow standard images for avatars
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('photo');

// ─── Complaint Uploads ────────────────────────────────────────
export const uploadComplaintMedia = multer({
    storage: multerS3(s3StorageOptions('complaints/media')),
    fileFilter,
}).array('files');

export const uploadComplaintAttachments = multer({
    storage: multerS3(s3StorageOptions('complaints/attachments')),
    fileFilter,
}).array('files');

// ─── Issue Uploads ────────────────────────────────────────
export const uploadIssueMedia = multer({
    storage: multerS3(s3StorageOptions('issues/media')),
    fileFilter,
}).array('files');

export const uploadIssueAttachments = multer({
    storage: multerS3(s3StorageOptions('issues/attachments')),
    fileFilter,
}).array('files');

// ─── Scheme Uploads ───────────────────────────────────────
export const uploadSchemeAttachments = multer({
    storage: multerS3(s3StorageOptions('schemes')),
    fileFilter,
}).fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'files' }
]);

export const uploadSchemeApplicationDocs = multer({
    storage: multerS3(s3StorageOptions('schemes/applications')),
    fileFilter,
}).array('files');

// ─── Idea Uploads ────────────────────────────────────────
export const uploadIdeaMediaS3 = multer({
    storage: multerS3(s3StorageOptions('ideas/media')),
    fileFilter,
}).array('files');

export const uploadIdeaAttachmentsS3 = multer({
    storage: multerS3(s3StorageOptions('ideas/attachments')),
    fileFilter,
}).array('files');

// ─── Suggestion Uploads ────────────────────────────────────────
export const uploadSuggestionMediaS3 = multer({
    storage: multerS3(s3StorageOptions('suggestions/media')),
    fileFilter,
}).array('files');

export const uploadSuggestionAttachmentsS3 = multer({
    storage: multerS3(s3StorageOptions('suggestions/attachments')),
    fileFilter,
}).array('files');

// ─── Geo Location Uploads ────────────────────────────────────────
export const uploadGeoLocationMedia = multer({
    storage: multerS3(s3StorageOptions('geo-locations/media')),
    fileFilter,
}).array('files');

export const uploadGeoLocationAttachments = multer({
    storage: multerS3(s3StorageOptions('geo-locations/attachments')),
    fileFilter,
}).array('files');


// ─── CM Funds Uploads ────────────────────────────────────────
export const uploadCMFundDocsS3 = multer({
    storage: multerS3(s3StorageOptions('cm_fund_documents')),
    fileFilter,
}).any();


// ─── Letters Uploads ─────────────────────────────────────────
export const uploadLetterAttachmentsS3 = multer({
    storage: multerS3(s3StorageOptions('letters/attachments')),
    fileFilter,
}).any();


// ─── Updates Uploads (Combined Media & Attachments) ──────────
export const uploadComplaintUpdateFiles = multer({
    storage: multerS3(s3StorageOptions('complaints/updates')),
    fileFilter,
}).fields([
    { name: 'media' },
    { name: 'attachments' }
]);

export const uploadIssueUpdateFiles = multer({
    storage: multerS3(s3StorageOptions('issues/updates')),
    fileFilter,
}).fields([
    { name: 'media' },
    { name: 'attachments' }
]);

export const uploadIdeaUpdateFiles = multer({
    storage: multerS3(s3StorageOptions('ideas/updates')),
    fileFilter,
}).fields([
    { name: 'media' },
    { name: 'attachments' }
]);

export const uploadSuggestionUpdateFiles = multer({
    storage: multerS3(s3StorageOptions('suggestions/updates')),
    fileFilter,
}).fields([
    { name: 'media' },
    { name: 'attachments' }
]);

// ─── Information Center Uploads ─────────────────────────────────
export const uploadInformationCenterFiles = multer({
    storage: multerS3(s3StorageOptions('information-center')),
    fileFilter,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'attachments' }
]);

// Helper: automatically rewrite S3 location to custom assets domain
export const transformFileLocations = (req) => {
    const baseUrl = (process.env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) return;

    const transform = (f) => {
        if (f && f.key) {
            f.location = `${baseUrl}/${f.key.replace(/^\/+/, '')}`;
        }
    };

    if (req.file) transform(req.file);
    if (req.files) {
        if (Array.isArray(req.files)) {
            req.files.forEach(transform);
        } else if (typeof req.files === 'object') {
            Object.values(req.files).flat().forEach(transform);
        }
    }
};

// Helper: wrap multer in a promise (for use inside async controllers)
export const runMulter = (multerFn, req, res) =>
    new Promise((resolve, reject) =>
        multerFn(req, res, (err) => {
            if (!req.body) req.body = {};
            if (!err) {
                if (!req.file && req.files) {
                    if (Array.isArray(req.files)) {
                        req.file = req.files[0];
                    } else if (typeof req.files === 'object') {
                        req.file = req.files.image?.[0] || req.files.file?.[0] || req.files.photo?.[0] || Object.values(req.files).flat()[0];
                    }
                }
                transformFileLocations(req);
            }
            return err ? reject(err) : resolve();
        })
    );

// Safe wrapper for uploadIcon that ensures req.body exists
export const safeUploadIcon = (req, res, next) => {
    uploadIcon(req, res, (err) => {
        if (!req.body) req.body = {};
        if (!err) transformFileLocations(req);
        if (err) {
            console.warn('Multer S3 error (non-fatal):', err.message);
        }
        next();
    });
};
