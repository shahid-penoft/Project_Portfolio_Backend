import { Router } from 'express';
import { verifyToken } from '../middlewares/auth.js';
import {
    submitContact,
    getEnquiries,
    getEnquiryById,
    updateEnquiryStatus,
    deleteEnquiry,
    sendSMS,
    sendEmail,
    sendWhatsApp,
    sendVoice,
    getCommunications,
    bulkSend,
} from '../controllers/contactController.js';

const router = Router();

// ─── Public ───────────────────────────────────────────────────
router.post('/', submitContact);   // anyone can submit a contact form

// ─── Protected (admin only) ───────────────────────────────────
router.use(verifyToken);
router.get('/', getEnquiries);
router.post('/bulk/send', bulkSend);
router.get('/:id', getEnquiryById);
router.patch('/:id/status', updateEnquiryStatus);
router.delete('/:id', deleteEnquiry);

// ─── Communication Routes ───────────────────────────────────────────
router.post('/:id/send-email', sendEmail);
router.post('/:id/send-sms', sendSMS);
router.post('/:id/send-whatsapp', sendWhatsApp);
router.post('/:id/send-voice', sendVoice);
router.get('/:id/communications', getCommunications);

// ─── Automation Management ─────────────────────────────────────
import { getAutomations, upsertAutomation, deleteAutomation } from '../controllers/contactController.js';
router.get('/config/automations', getAutomations);
router.post('/config/automations', upsertAutomation);
router.delete('/config/automations/:id', deleteAutomation);

export default router;
