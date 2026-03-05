import express from 'express';
import { verifyToken } from '../middlewares/auth.js';
import {
    getAllEvents,
    getEventsByStatus,
    getEventById,
    createEvent,
    updateEvent,
    deleteEvent,
    saveEventContent,
    addEventMedia,
    addYouTubeMedia,
    deleteEventMedia,
    uploadInlineImage,
    sendEventInvitations,
} from '../controllers/eventController.js';

const router = express.Router();

// ─── Public ───────────────────────────────────────────────────
router.get('/', getAllEvents);
router.get('/by-status', getEventsByStatus);   // ?status=upcoming|ongoing|past
router.get('/:id', getEventById);

// ─── Protected (cookie JWT) ───────────────────────────────────
router.use(verifyToken);

router.post('/', createEvent);
router.put('/:id', updateEvent);
router.delete('/:id', deleteEvent);
router.post('/:id/content', saveEventContent);
router.post('/:id/media', addEventMedia);
router.post('/:id/youtube', addYouTubeMedia);
router.post('/:id/upload-inline-image', uploadInlineImage);
router.post('/:id/invite', sendEventInvitations);
router.delete('/media/:mediaId', deleteEventMedia);

export default router;
