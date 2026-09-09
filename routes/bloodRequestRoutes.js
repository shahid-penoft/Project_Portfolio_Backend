import express from 'express';
import rateLimit from 'express-rate-limit';
import {
    getBloodRequests,
    addBloodRequest,
    updateBloodRequest,
    deleteBloodRequest,
} from '../controllers/bloodRequestController.js';
import { validateBloodRequest } from '../middlewares/validateBloodRequest.js';
import { verifyToken, optionalVerifyToken } from '../middlewares/auth.js';

const router = express.Router();

/** Rate limiter: max 10 blood request submissions per 15 min per IP */
const requestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many blood requests submitted from this IP. Please wait 15 minutes before trying again.',
    },
});

// GET /api/blood-requests — public / admin with optional token
router.get('/', optionalVerifyToken, getBloodRequests);

// POST /api/blood-requests — public (rate-limited) + validated
router.post('/', requestLimiter, validateBloodRequest, addBloodRequest);

// PUT /api/blood-requests/:id — admin only
router.put('/:id', verifyToken, updateBloodRequest);

// DELETE /api/blood-requests/:id — admin only
router.delete('/:id', verifyToken, deleteBloodRequest);

export default router;
