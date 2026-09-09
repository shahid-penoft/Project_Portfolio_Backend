import pool from '../configs/db.js';

/**
 * Fetch blood requests with optional status, blood group, search, local body, sort, and pagination.
 */
export const fetchAllBloodRequests = async ({
    status,
    bloodGroup,
    search,
    localBody,
    localBodyId,
    sort,
    page = 1,
    limit,
} = {}) => {
    const whereConditions = ['br.is_active = 1'];
    const params = [];

    // Status filter
    if (status && status !== 'All') {
        whereConditions.push('br.status = ?');
        params.push(status);
    }

    // Blood group filter (handle url decoded '+' as space e.g. 'B ' -> 'B+')
    let normGroup = (bloodGroup || '').toUpperCase().trim();
    if (['A', 'B', 'AB', 'O'].includes(normGroup)) {
        normGroup += '+';
    }
    if (normGroup && normGroup !== 'ALL') {
        whereConditions.push('br.blood_group = ?');
        params.push(normGroup);
    }

    // Local body ID or name filter
    if (localBodyId) {
        whereConditions.push('br.local_body_id = ?');
        params.push(parseInt(localBodyId, 10));
    } else if (localBody && localBody !== 'All') {
        whereConditions.push('(lb.name = ? OR lb.name LIKE ?)');
        params.push(localBody, `%${localBody}%`);
    }

    // Search query
    if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        whereConditions.push(`(
            br.patient_name LIKE ? OR
            br.contact_phone LIKE ? OR
            br.contact_person LIKE ? OR
            br.hospital_name LIKE ? OR
            br.department LIKE ? OR
            br.house_name LIKE ? OR
            br.ward_info LIKE ? OR
            br.notes LIKE ? OR
            lb.name LIKE ?
        )`);
        params.push(q, q, q, q, q, q, q, q, q);
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    // Count total matching items
    const countSql = `
        SELECT COUNT(*) AS total
        FROM blood_requests br
        LEFT JOIN local_bodies lb ON br.local_body_id = lb.id
        ${whereClause}
    `;
    const [[{ total }]] = await pool.query(countSql, params);

    // Sorting
    let orderBy = 'br.created_at DESC';
    const s = (sort || '').toLowerCase();
    if (s.includes('oldest') || s === 'asc') {
        orderBy = 'br.created_at ASC';
    } else if (s.includes('name a-z') || s === 'name_asc') {
        orderBy = 'br.patient_name ASC';
    } else if (s.includes('name z-a') || s === 'name_desc') {
        orderBy = 'br.patient_name DESC';
    }

    // Build data SQL
    let dataSql = `
        SELECT
            br.id,
            br.patient_name   AS patientName,
            br.blood_group    AS bloodGroup,
            br.units_needed   AS unitsNeeded,
            br.hospital_name  AS hospitalName,
            br.department     AS department,
            br.hospital_location AS hospitalLocation,
            br.house_name     AS houseName,
            br.ward_info      AS wardInfo,
            br.local_body_id  AS localBodyId,
            lb.name           AS localBody,
            br.ward_id        AS wardId,
            br.contact_person AS contactPerson,
            br.contact_phone  AS contactPhone,
            br.required_date  AS requiredDate,
            br.status,
            br.notes,
            br.created_at     AS createdAt
        FROM blood_requests br
        LEFT JOIN local_bodies lb ON br.local_body_id = lb.id
        ${whereClause}
        ORDER BY ${orderBy}
    `;

    const queryParams = [...params];

    // Pagination
    let parsedLimit = null;
    let parsedPage = parseInt(page, 10) || 1;
    if (parsedPage < 1) parsedPage = 1;

    if (limit && limit !== 'all') {
        parsedLimit = parseInt(limit, 10) || 10;
        const offset = (parsedPage - 1) * parsedLimit;
        dataSql += ` LIMIT ? OFFSET ?`;
        queryParams.push(parsedLimit, offset);
    }

    const [rows] = await pool.query(dataSql, queryParams);

    const formattedData = rows.map((r) => ({
        ...r,
        unitsNeeded: Number(r.unitsNeeded) || parseInt(r.unitsNeeded, 10) || r.unitsNeeded,
        requiredDate: r.requiredDate
            ? (r.requiredDate instanceof Date
                ? r.requiredDate.toISOString().split('T')[0]
                : String(r.requiredDate).split('T')[0])
            : null,
    }));

    // Status counts
    const [statusRows] = await pool.query(`
        SELECT status, COUNT(*) AS count
        FROM blood_requests
        WHERE is_active = 1
        GROUP BY status
    `);
    const statusCounts = { All: 0, Active: 0, Pending: 0, Fulfilled: 0 };
    for (const r of statusRows) {
        statusCounts[r.status] = Number(r.count);
        statusCounts.All += Number(r.count);
    }

    // Blood group counts (filtered by current status if provided)
    let bgSql = `SELECT blood_group AS bloodGroup, COUNT(*) AS count FROM blood_requests WHERE is_active = 1`;
    const bgParams = [];
    if (status && status !== 'All') {
        bgSql += ` AND status = ?`;
        bgParams.push(status);
    }
    bgSql += ` GROUP BY blood_group`;
    const [bgRows] = await pool.query(bgSql, bgParams);

    const bloodGroupCounts = {
        All: 0,
        'O+': 0, 'O-': 0,
        'A+': 0, 'A-': 0,
        'B+': 0, 'B-': 0,
        'AB+': 0, 'AB-': 0,
    };
    for (const r of bgRows) {
        if (r.bloodGroup && bloodGroupCounts[r.bloodGroup] !== undefined) {
            bloodGroupCounts[r.bloodGroup] = Number(r.count);
        }
        bloodGroupCounts.All += Number(r.count);
    }

    const totalPages = parsedLimit ? Math.ceil(total / parsedLimit) : 1;

    return {
        data: formattedData,
        pagination: {
            total: Number(total),
            page: parsedPage,
            limit: parsedLimit || total,
            totalPages: totalPages || 1,
        },
        counts: {
            statusCounts,
            bloodGroupCounts,
        },
    };
};

/**
 * Insert a new blood request.
 */
export const insertBloodRequest = async ({
    patientName,
    bloodGroup,
    unitsNeeded,
    hospitalName,
    department,
    hospitalLocation,
    houseName,
    localBodyId,
    wardId,
    contactPerson,
    contactPhone,
    requiredDate,
    notes,
    status,
}) => {
    const parsedLbId = localBodyId ? parseInt(localBodyId, 10) : null;
    const parsedWardId = wardId ? parseInt(wardId, 10) : null;
    const reqStatus = status || 'Pending';

    // Resolve localBody name and wardInfo from DB
    let wardInfo = null;
    try {
        if (parsedLbId && parsedWardId) {
            const [[ward]] = await pool.query(
                'SELECT ward_no, place_name FROM local_body_wards WHERE id = ?',
                [parsedWardId]
            );
            if (ward) {
                wardInfo = ward.ward_no
                    ? `Ward ${ward.ward_no}${ward.place_name ? ' - ' + ward.place_name : ''}`
                    : ward.place_name;
            }
        }
    } catch (err) {
        console.error('[insertBloodRequest] Ward resolve error:', err.message);
    }

    // Parse required_date — handle ISO string or Date object
    let parsedDate = requiredDate;
    if (requiredDate && typeof requiredDate === 'string') {
        parsedDate = requiredDate.split('T')[0]; // keep YYYY-MM-DD
    }

    const [result] = await pool.query(
        `INSERT INTO blood_requests
         (patient_name, blood_group, units_needed, hospital_name, department, hospital_location, house_name, local_body_id, ward_id, ward_info, contact_person, contact_phone, required_date, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            patientName,
            bloodGroup || 'O+',
            String(unitsNeeded || '2'),
            hospitalName,
            department || null,
            hospitalLocation || null,
            houseName || null,
            parsedLbId,
            parsedWardId,
            wardInfo,
            contactPerson || null,
            contactPhone,
            parsedDate,
            reqStatus,
            notes || null,
        ]
    );

    return {
        id: result.insertId,
        patientName,
        bloodGroup: bloodGroup || 'O+',
        unitsNeeded: unitsNeeded || '2',
        hospitalName,
        department: department || null,
        hospitalLocation: hospitalLocation || null,
        houseName: houseName || null,
        wardInfo,
        localBodyId: parsedLbId,
        wardId: parsedWardId,
        contactPerson: contactPerson || null,
        contactPhone,
        requiredDate: parsedDate,
        status: reqStatus,
        notes: notes || null,
    };
};

/**
 * Update an existing blood request (partial update).
 */
export const updateBloodRequestInDB = async (id, data) => {
    const fields = [];
    const values = [];

    if (data.patientName !== undefined) {
        fields.push('patient_name = ?');
        values.push(data.patientName);
    }
    if (data.bloodGroup !== undefined) {
        fields.push('blood_group = ?');
        values.push(data.bloodGroup);
    }
    if (data.unitsNeeded !== undefined) {
        fields.push('units_needed = ?');
        values.push(String(data.unitsNeeded));
    }
    if (data.hospitalName !== undefined) {
        fields.push('hospital_name = ?');
        values.push(data.hospitalName);
    }
    if (data.department !== undefined) {
        fields.push('department = ?');
        values.push(data.department || null);
    }
    if (data.hospitalLocation !== undefined) {
        fields.push('hospital_location = ?');
        values.push(data.hospitalLocation || null);
    }
    if (data.houseName !== undefined) {
        fields.push('house_name = ?');
        values.push(data.houseName || null);
    }
    if (data.contactPerson !== undefined) {
        fields.push('contact_person = ?');
        values.push(data.contactPerson || null);
    }
    if (data.contactPhone !== undefined) {
        fields.push('contact_phone = ?');
        values.push(data.contactPhone);
    }
    if (data.requiredDate !== undefined) {
        fields.push('required_date = ?');
        const d = data.requiredDate;
        values.push(typeof d === 'string' ? d.split('T')[0] : d);
    }
    if (data.status !== undefined) {
        fields.push('status = ?');
        values.push(data.status);
    }
    if (data.notes !== undefined) {
        fields.push('notes = ?');
        values.push(data.notes || null);
    }

    if (fields.length === 0) return true;

    values.push(id);
    const sql = `UPDATE blood_requests SET ${fields.join(', ')} WHERE id = ?`;
    await pool.query(sql, values);
    return true;
};

/**
 * Hard-delete a blood request.
 */
export const deleteBloodRequestInDB = async (id) => {
    await pool.query('DELETE FROM blood_requests WHERE id = ?', [id]);
    return true;
};
