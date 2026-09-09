const VALID_BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const VALID_STATUSES = ['Pending', 'Active', 'Fulfilled'];

/**
 * Middleware: validates and sanitizes blood request payload.
 * Attaches sanitized data to req.sanitizedRequest.
 */
export const validateBloodRequest = (req, res, next) => {
    const body = req.body || {};
    const errors = [];

    // ── Required fields ───────────────────────────────────────────────────────
    if (!body.patientName || !String(body.patientName).trim()) {
        errors.push('patientName is required.');
    }
    if (!body.hospitalName || !String(body.hospitalName).trim()) {
        errors.push('hospitalName is required.');
    }
    if (!body.contactPhone || !String(body.contactPhone).trim()) {
        errors.push('contactPhone is required.');
    }
    if (!body.requiredDate) {
        errors.push('requiredDate is required.');
    }

    // ── Blood Group ───────────────────────────────────────────────────────────
    const bloodGroup = (body.bloodGroup || '').trim().toUpperCase();
    if (!VALID_BLOOD_GROUPS.includes(bloodGroup)) {
        errors.push(`bloodGroup must be one of: ${VALID_BLOOD_GROUPS.join(', ')}.`);
    }

    // ── Required Date ─────────────────────────────────────────────────────────
    if (body.requiredDate) {
        const d = new Date(body.requiredDate);
        if (isNaN(d.getTime())) {
            errors.push('requiredDate must be a valid date.');
        }
    }

    if (errors.length > 0) {
        return res.status(422).json({
            success: false,
            message: 'Validation failed.',
            errors,
        });
    }

    // ── Sanitize and attach ───────────────────────────────────────────────────
    req.sanitizedRequest = {
        patientName: String(body.patientName).trim().slice(0, 100),
        bloodGroup,
        unitsNeeded: body.unitsNeeded || '2',
        hospitalName: String(body.hospitalName).trim().slice(0, 200),
        department: body.department ? String(body.department).trim().slice(0, 100) : null,
        hospitalLocation: body.hospitalLocation ? String(body.hospitalLocation).trim().slice(0, 2000) : null,
        houseName: body.houseName ? String(body.houseName).trim().slice(0, 200) : null,
        localBodyId: body.localBodyId ? (parseInt(body.localBodyId, 10) || null) : null,
        wardId: body.wardId ? (parseInt(body.wardId, 10) || null) : null,
        contactPerson: body.contactPerson ? String(body.contactPerson).trim().slice(0, 100) : null,
        contactPhone: String(body.contactPhone).trim().slice(0, 20),
        requiredDate: body.requiredDate,
        notes: body.notes ? String(body.notes).trim().slice(0, 2000) : null,
        status: VALID_STATUSES.includes(body.status) ? body.status : 'Active',
    };

    next();
};
