import db from '../configs/db.js';
import { errorResponse, successResponse, createShortLink } from '../utils/helpers.js';
import { sendAdminInviteEmail } from '../utils/email.js';
import { sendAdminInviteSMS } from '../services/smsService.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const generateToken = () => crypto.randomBytes(32).toString('hex');

// Get all admin users
export const getAdminUsers = async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT 
                u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at, u.last_login,
                u.role_id, r.name as role_name, r.is_system
            FROM admin_users u
            LEFT JOIN admin_roles r ON u.role_id = r.id
            ORDER BY u.created_at DESC
        `);
        return successResponse(res, { data: users }, 'Admin users fetched successfully');
    } catch (error) {
        console.error('[getAdminUsers]', error);
        return errorResponse(res, 'Failed to fetch admin users', 500);
    }
};

// Create (Invite) a new admin user
export const createAdminUser = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { full_name, email, phone, role_id } = req.body;
        
        if (!full_name || (!email && !phone) || !role_id) {
            return errorResponse(res, 'Name, role, and at least an email or mobile number are required', 400);
        }

        // Check if email or phone already exists
        if (email) {
            const [existingEmail] = await connection.query('SELECT id FROM admin_users WHERE email = ?', [email]);
            if (existingEmail.length > 0) {
                connection.release();
                return errorResponse(res, 'Email already exists', 400);
            }
        }
        if (phone) {
            const [existingPhone] = await connection.query('SELECT id FROM admin_users WHERE phone = ?', [phone]);
            if (existingPhone.length > 0) {
                connection.release();
                return errorResponse(res, 'Phone number already exists', 400);
            }
        }

        // Fetch role to get the name for the email/sms
        const [roles] = await connection.query('SELECT name FROM admin_roles WHERE id = ?', [role_id]);
        if (roles.length === 0) {
            connection.release();
            return errorResponse(res, 'Invalid role selected', 400);
        }
        const roleName = roles[0].name;

        await connection.beginTransaction();

        // 1. Create the user with a temporary random password
        const randomTempPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomTempPassword, 12);

        const [result] = await connection.query(
            'INSERT INTO admin_users (full_name, email, phone, password, role_id, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [full_name, email || null, phone || null, hashedPassword, role_id]
        );
        const userId = result.insertId;

        // 2. Generate invite token (reusing password_resets table)
        const token = generateToken();
        const identifier = email || phone;
        // Invite link valid for 7 days
        await connection.query(
            'INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 7 DAY)',
            [identifier, token]
        );

        // 3. Send the invite (Email and/or SMS)
        if (email) {
            await sendAdminInviteEmail({
                to: email,
                name: full_name,
                token,
                roleName
            });
        }
        if (phone) {
            const urls = (process.env.FRONTEND_URL || '').split(',').map(u => u.trim()).filter(Boolean);
            const frontendUrl = urls.find(u => !u.includes('localhost') && !u.includes('127.0.0.1')) || urls[0] || 'http://localhost:5173';
            const fullLink = `${frontendUrl}/admin/reset-password?token=${token}`;
            const shortLink = await createShortLink(fullLink, 7 * 24 * 60); // 7 days in minutes
            await sendAdminInviteSMS({
                to: phone,
                name: full_name,
                link: shortLink
            });
        }

        await connection.commit();
        return successResponse(res, { id: userId }, 'User invited successfully');
    } catch (error) {
        await connection.rollback();
        console.error('[createAdminUser]', error);
        return errorResponse(res, 'Failed to invite user', 500);
    } finally {
        connection.release();
    }
};

// Update an existing admin user
export const updateAdminUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { full_name, role_id, is_active, phone, email } = req.body;

        if (!full_name || !role_id) {
            return errorResponse(res, 'Name and role are required', 400);
        }

        if (email) {
            const [existingEmail] = await db.query('SELECT id FROM admin_users WHERE email = ? AND id != ?', [email, id]);
            if (existingEmail.length > 0) {
                return errorResponse(res, 'Email already exists', 400);
            }
        }

        // Protect Superadmin modifications if needed, but since this route is superadmin only, 
        // we mainly want to prevent taking away the superadmin role from the last superadmin.
        // For simplicity, we just allow the update.
        await db.query(
            'UPDATE admin_users SET full_name = ?, role_id = ?, is_active = ?, phone = ?, email = ? WHERE id = ?',
            [full_name, role_id, is_active, phone || null, email || null, id]
        );

        return successResponse(res, {}, 'User updated successfully');
    } catch (error) {
        console.error('[updateAdminUser]', error);
        return errorResponse(res, 'Failed to update user', 500);
    }
};

// Delete an admin user
export const deleteAdminUser = async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting oneself
        if (req.admin.id == id) {
            return errorResponse(res, 'You cannot delete your own account', 400);
        }

        const [result] = await db.query('DELETE FROM admin_users WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return errorResponse(res, 'User not found', 404);
        }

        return successResponse(res, {}, 'User deleted successfully');
    } catch (error) {
        console.error('[deleteAdminUser]', error);
        
        // Handle Foreign Key Constraint Error (errno 1451 in MySQL)
        if (error.errno === 1451) {
            return errorResponse(
                res, 
                'Cannot delete this user because they are assigned to existing records (e.g., CM Funds or Complaints). Please deactivate their account instead.', 
                409 // 409 Conflict
            );
        }
        
        return errorResponse(res, 'Failed to delete user', 500);
    }
};
