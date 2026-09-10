import 'dotenv/config';
// Backend API Server - Blood requests reload trigger
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './configs/db.js';

import authRoutes from './routes/authRoutes.js';
import localBodyRoutes from './routes/localBodyRoutes.js';
import { getLocalBodiesWithWards } from './controllers/localBodyController.js';
import wardRoutes from './routes/wardRoutes.js';
import { getWardsByLocalBodyName } from './controllers/wardController.js';
import sectorRoutes from './routes/sectorRoutes.js';
import eventTypeRoutes from './routes/eventTypeRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import galleryRoutes from './routes/galleryRoutes.js';
import mediaCentreRoutes from './routes/mediaCentreRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import heroRoutes from './routes/heroRoutes.js';
import enteNaduRoutes from './routes/enteNaduRoutes.js';
import coreVisionRoutes from './routes/coreVisionRoutes.js';
import timelineRoutes from './routes/timelineRoutes.js';
import recognitionRoutes from './routes/recognitionRoutes.js';
import aboutSettingsRoutes from './routes/aboutSettingsRoutes.js';
import visualStoryRoutes from './routes/visualStoryRoutes.js';
import achievementsRoutes from './routes/achievementsRoutes.js';
import enteNaduTestimonialsRoutes from './routes/enteNaduTestimonialsRoutes.js';
import manifestoRoutes from './routes/manifestoRoutes.js';
import manifestoDevGoalsRoutes from './routes/manifestoDevGoalsRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import contactSettingsRoutes from './routes/contactSettingsRoutes.js';
import templateRoutes from './routes/templateRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import peopleRoutes from './routes/peopleRoutes.js';
import impactMetricsRoutes from './routes/impactMetricsRoutes.js';
import kothamangalamGalleryRoutes from './routes/kothamangalamGalleryRoutes.js';
import kothamangalamSettingsRoutes from './routes/kothamangalamSettingsRoutes.js';
import enteNaduSettingsRoutes from './routes/enteNaduSettingsRoutes.js';
import programRoutes from './routes/programRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import constituentAuthRoutes from './routes/constituentAuthRoutes.js';
import jobsRoutes from './routes/jobsRoutes.js';
import schemesRoutes from './routes/schemesRoutes.js';
import tourismRoutes from './routes/tourismRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';
import complaintsRoutes from './routes/complaintsRoutes.js';
import ideasRoutes from './routes/ideasRoutes.js';
import suggestionsRoutes from './routes/suggestionsRoutes.js';
import rbacRoutes from './routes/rbacRoutes.js';
import adminUsersRoutes from './routes/adminUsersRoutes.js';
import issuesRoutes from './routes/issuesRoutes.js';
import geoLocationRoutes from './routes/geoLocationRoutes.js';
import geoCategoryRoutes from './routes/geoCategoryRoutes.js';
import mlaDropdownsRoutes from './routes/mlaDropdownsRoutes.js';
import governingBodiesRoutes from './routes/governingBodiesRoutes.js';
import csrRoutes from './routes/csrRoutes.js';
import lettersRoutes from './routes/lettersRoutes.js';
import cmFundsRoutes from './routes/cmFundsRoutes.js';
import teamsLogRoutes from './routes/teamsLogRoutes.js';
import notificationsRoutes from './routes/notificationsRoutes.js';
import communicationsRoutes from './routes/communicationsRoutes.js';
import trackingRoutes from './routes/trackingRoutes.js';

import busTimingsRoutes from './routes/busTimingsRoutes.js';
import informationCenterRoutes from './routes/informationCenterRoutes.js';
import quickActionsRoutes from './routes/quickActionsRoutes.js';
import petitionsRoutes from './routes/petitionsRoutes.js';
import bloodDonorRoutes from './routes/bloodDonorRoutes.js';
import bloodRequestRoutes from './routes/bloodRequestRoutes.js';
import mlaCareRoutes from './routes/mlaCareRoutes.js';
import volunteersRoutes from './routes/volunteersRoutes.js';
import volunteerCategoriesRoutes from './routes/volunteerCategoriesRoutes.js';
import aboutSectionRoutes from './routes/aboutSectionRoutes.js';
import homeSectionOrderRoutes from './routes/homeSectionOrderRoutes.js';
import homeStatsRoutes from './routes/homeStatsRoutes.js';
import homeEventsSectionRoutes from './routes/homeEventsSectionRoutes.js';
import { initTrashPurge } from './services/trashPurgeService.js';
import { initScheduler } from './services/schedulerService.js';

import { apiLimiter } from './middlewares/rateLimiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy if you are behind a load balancer (Cloudflare, Nginx, Heroku, etc.)
app.set('trust proxy', 1);

// ─── Global CORS Middleware ────────────────────────────────────
app.use(cors({
    origin: function (origin, callback) {
        // Extract strictly the origin (e.g., scheme://domain:port) from the configured URLs
        const allowedOrigins = process.env.FRONTEND_URL
            ? process.env.FRONTEND_URL.split(',').map(urlStr => {
                try {
                    return new URL(urlStr.trim()).origin;
                } catch (e) {
                    // Fallback if it's not a valid URL
                    return urlStr.trim().replace(/\/+$/, '');
                }
            })
            : ['http://localhost:5173', 'http://localhost:3000'];

        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));

// ─── Static: serve uploaded media files (exempt from API rate limiting) ──────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Health Check (exempt from API rate limiting) ───────────────
app.get('/health', (_, res) =>
    res.json({ success: true, message: 'Server is running', timestamp: new Date() })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// ─── API Rate Limiting ────────────────────────────────────────
app.use(apiLimiter);

// ─── URL Shortener Redirection ────────────────────────────────
app.get('/api/r/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const [rows] = await db.query(
            'SELECT long_url FROM short_links WHERE code = ? AND expires_at > UTC_TIMESTAMP()',
            [code]
        );
        if (rows.length > 0) {
            return res.redirect(302, rows[0].long_url);
        }
        // If expired or invalid
        const _urls1 = (process.env.FRONTEND_URL || '').split(',').map(u => u.trim()).filter(Boolean);
        const frontendUrl = _urls1.find(u => !u.includes('localhost') && !u.includes('127.0.0.1')) || _urls1[0] || 'http://localhost:5173';
        return res.redirect(302, `${frontendUrl}/admin/login?error=link-expired`);
    } catch (err) {
        console.error('[ShortLinkError]', err);
        const _urls2 = (process.env.FRONTEND_URL || '').split(',').map(u => u.trim()).filter(Boolean);
        const frontendUrl2 = _urls2.find(u => !u.includes('localhost') && !u.includes('127.0.0.1')) || _urls2[0] || 'http://localhost:5173';
        return res.redirect(302, `${frontendUrl2}/admin/login?error=server-error`);
    }
});

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.get('/api/local-bodies-with-wards', getLocalBodiesWithWards);
app.use('/api/local-bodies/:localBodyId/wards', wardRoutes);
app.use('/api/local-bodies', localBodyRoutes);
app.get('/api/wards/by-name/:name', getWardsByLocalBodyName);
app.use('/api/sectors', sectorRoutes);
app.use('/api/event-types', eventTypeRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/gallery', galleryRoutes);
app.use('/api/media-centre', mediaCentreRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/hero', heroRoutes);
app.use('/api/ente-nadu', enteNaduRoutes);
app.use('/api/core-vision', coreVisionRoutes);
app.use('/api/about-section', aboutSectionRoutes);
app.use('/api/home/section-order', homeSectionOrderRoutes);
app.use('/api/home/stats', homeStatsRoutes);
app.use('/api/home/events-section', homeEventsSectionRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/recognitions', recognitionRoutes);
app.use('/api/about-settings', aboutSettingsRoutes);
app.use('/api/visual-stories', visualStoryRoutes);
app.use('/api/achievements', achievementsRoutes);
app.use('/api/ente-nadu-testimonials', enteNaduTestimonialsRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/manifesto/long-term-commitments', manifestoRoutes);
app.use('/api/manifesto/development-goals', manifestoDevGoalsRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/contact-settings', contactSettingsRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/impact-metrics', impactMetricsRoutes);
app.use('/api/kothamangalam-gallery', kothamangalamGalleryRoutes);
app.use('/api/kothamangalam-settings', kothamangalamSettingsRoutes);
app.use('/api/ente-nadu-settings', enteNaduSettingsRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/mla-connect/auth', constituentAuthRoutes);
app.use('/api/schemes', schemesRoutes);
app.use('/api/tourism', tourismRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/complaints',  complaintsRoutes);
app.use('/api/ideas',       ideasRoutes);
app.use('/api/suggestions', suggestionsRoutes);
app.use('/api/rbac/roles', rbacRoutes);
app.use('/api/admin-users', adminUsersRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/petitions', petitionsRoutes);  // Public petition tracker (no auth required)
app.use('/api/blood-donors', bloodDonorRoutes);          // Voluntary Blood Donor Directory & Emergency Needs
app.use('/api/blood-requests', bloodRequestRoutes);      // Emergency Blood Requests (public submit + admin manage)
app.use('/api/mla-care', mlaCareRoutes);                 // MLA Care Applications (public submit + admin manage)
app.use('/api/volunteers', volunteersRoutes);             // Volunteers Corps Directory
app.use('/api/volunteer-categories', volunteerCategoriesRoutes); // Volunteer Activity Categories (admin-managed)
app.use('/api/geo-locations', geoLocationRoutes);
app.use('/api/geo-categories', geoCategoryRoutes);
app.use('/api/mla/dropdowns', mlaDropdownsRoutes);
app.use('/api/admin/governing-bodies', governingBodiesRoutes);
app.use('/api/csr', csrRoutes);
app.use('/api/letters', lettersRoutes);
app.use('/api/admin/letters', lettersRoutes);
app.use('/api/cm-funds',       cmFundsRoutes); // Public intake: POST /api/cm-funds/public-submit
app.use('/api/admin/cm-funds', cmFundsRoutes);
app.use('/api/admin/teams-log', teamsLogRoutes);
app.use('/api/notifications',  notificationsRoutes);
app.use('/api/communications',   communicationsRoutes);
app.use('/api/tracking',         trackingRoutes);
app.use('/api/bus-timings', busTimingsRoutes);
app.use('/api/information-center', informationCenterRoutes);
app.use('/api/admin/quick-actions', quickActionsRoutes);

// ─── 404 Handler ─────────────────────────────────────────────
app.use((req, res) =>
    res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` })
);

// ─── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[GlobalError]', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            success: false,
            message: 'File size too large. (Max 10 MB for images, 50 MB for documents, 200 MB for videos).'
        });
    }
    if (err.name === 'MulterError') {
        return res.status(400).json({
            success: false,
            message: err.message || 'File upload error occurred.'
        });
    }
    res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀  Server running on http://localhost:${PORT}`);
    initTrashPurge();
    initScheduler();
});

// Enquiries status & dropdown modules loaded


// Geo filterCounts enabled
export default app;
