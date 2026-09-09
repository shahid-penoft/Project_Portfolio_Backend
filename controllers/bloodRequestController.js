import {
    fetchAllBloodRequests,
    insertBloodRequest,
    updateBloodRequestInDB,
    deleteBloodRequestInDB,
} from '../models/bloodRequestModel.js';

/**
 * GET /api/blood-requests
 * Supports query params: ?status=Active&bloodGroup=O+&search=...&localBody=...&sort=...&page=1&limit=10
 */
export const getBloodRequests = async (req, res) => {
    try {
        let status = req.query.status;
        if (status === undefined || status === null) {
            // Default unauthenticated public requests to Active status
            status = req.admin ? '' : 'Active';
        } else if (status === 'All') {
            status = '';
        }

        const bloodGroup = (req.query.bloodGroup || req.query.blood_group || req.query.group || '').trim().toUpperCase();
        const search = req.query.search || req.query.q || '';
        const localBody = req.query.localBody || req.query.panchayat || '';
        const localBodyId = req.query.localBodyId || req.query.local_body_id || '';
        const sort = req.query.sort || req.query.sortBy || '';
        const page = req.query.page;
        const limit = req.query.limit;

        const result = await fetchAllBloodRequests({
            status,
            bloodGroup,
            search,
            localBody,
            localBodyId,
            sort,
            page,
            limit,
        });

        return res.json({
            success: true,
            data: result.data,
            pagination: result.pagination,
            counts: result.counts,
        });
    } catch (err) {
        console.error('[getBloodRequests error]:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve blood requests.',
        });
    }
};

/**
 * POST /api/blood-requests
 * Public endpoint (rate-limited) to submit an emergency blood request.
 */
export const addBloodRequest = async (req, res) => {
    try {
        const data = req.sanitizedRequest || req.body;

        const newRequest = await insertBloodRequest(data);

        return res.status(201).json({
            success: true,
            message: 'Blood request submitted successfully. We will broadcast this to verified donors shortly.',
            data: newRequest,
        });
    } catch (err) {
        console.error('[addBloodRequest error]:', err);
        return res.status(500).json({
            success: false,
            message: 'Server error while submitting blood request. Please try again.',
        });
    }
};

/**
 * PUT /api/blood-requests/:id
 * Admin: update status, notes, or other editable fields.
 */
export const updateBloodRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;

        await updateBloodRequestInDB(id, data);

        return res.json({
            success: true,
            message: 'Blood request updated successfully.',
        });
    } catch (err) {
        console.error('[updateBloodRequest error]:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to update blood request.',
        });
    }
};

/**
 * DELETE /api/blood-requests/:id
 * Admin: remove a blood request entry.
 */
export const deleteBloodRequest = async (req, res) => {
    try {
        const { id } = req.params;

        await deleteBloodRequestInDB(id);

        return res.json({
            success: true,
            message: 'Blood request deleted successfully.',
        });
    } catch (err) {
        console.error('[deleteBloodRequest error]:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete blood request.',
        });
    }
};
