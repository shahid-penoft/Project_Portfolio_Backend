import 'dotenv/config';
import transporter from '../configs/mailer.js';
import pool from '../configs/db.js';

const APP_NAME = process.env.APP_NAME || 'Shibu Theckumpuram';
const MAIL_FROM = process.env.MAIL_FROM || `"${APP_NAME}" <no-reply@shibu-theckumpuram.com>`;
// Reads FRONTEND_URL fresh on every call so hot-reloaded env changes take effect.
// When multiple URLs are provided (comma-separated), prefers the first non-localhost
// entry so that production invite/reset links never point to localhost:5173.
const getFrontendUrl = () => {
  const urls = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return 'http://localhost:5173';
  const nonLocal = urls.find(
    u => !u.includes('localhost') && !u.includes('127.0.0.1')
  );
  return nonLocal || urls[0];
};

// ─────────────────────────────────────────────────────────────
//  Forgot Password Email
// ─────────────────────────────────────────────────────────────
export const sendPasswordResetEmail = async ({ to, name, token }) => {
  const resetLink = `${getFrontendUrl()}/admin/reset-password?token=${token}`;

  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Password Reset Request`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Password Reset</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>We received a request to reset your admin account password. Click the button below to set a new password:</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${resetLink}"
                 style="background:#1a3c5e;color:#fff;padding:13px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">
                Reset Password
              </a>
            </div>
            <p style="color:#666;font-size:13px;">This link will expire in <strong>30 minutes</strong>.</p>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Admin Invite Email
// ─────────────────────────────────────────────────────────────
export const sendAdminInviteEmail = async ({ to, name, token, roleName }) => {
  const resetLink = `${getFrontendUrl()}/admin/reset-password?token=${token}`;

  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] You've been invited to the Admin Panel`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Admin Panel Invitation</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>You have been invited to join the ${APP_NAME} Admin Panel as a <strong>${roleName}</strong>.</p>
            <p>Click the button below to set up your password and log in for the first time:</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${resetLink}"
                 style="background:#1a3c5e;color:#fff;padding:13px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">
                Set Password & Log In
              </a>
            </div>
            <p style="color:#666;font-size:13px;">This link will expire in <strong>7 days</strong>.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Constituent Forgot Password Email
// ─────────────────────────────────────────────────────────────
export const sendConstituentPasswordResetEmail = async ({ to, name, token }) => {
  const resetLink = `${getFrontendUrl()}/mla-connect/reset-password?token=${token}`;

  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Password Reset Request`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Password Reset</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>We received a request to reset your MLA Connect account password. Click the button below to set a new password:</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${resetLink}"
                 style="background:#1a3c5e;color:#fff;padding:13px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">
                Reset Password
              </a>
            </div>
            <p style="color:#666;font-size:13px;">This link will expire in <strong>30 minutes</strong>.</p>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Welcome / Account Created Email
// ─────────────────────────────────────────────────────────────
export const sendWelcomeEmail = async ({ to, name, tempPassword }) => {
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Your Admin Account Has Been Created`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Welcome, ${name}!</h2>
            <p>Your admin account has been created. Here are your temporary credentials:</p>
            <div style="background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin:20px 0;">
              <p style="margin:4px 0;"><strong>Email:</strong> ${to}</p>
              <p style="margin:4px 0;"><strong>Temporary Password:</strong> <code>${tempPassword}</code></p>
            </div>
            <p style="color:#d9534f;"><strong>⚠ Please change your password immediately after first login.</strong></p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Contact / Enquiry — User Confirmation Email
// ─────────────────────────────────────────────────────────────
export const sendEnquiryReceivedEmail = async (enquiry) => {
  const { full_name, email, category, subject, message, panchayat } = enquiry;
  const categoryLabel = category ? category.replace(/\b\w/g, l => l.toUpperCase()) : 'General';
  await transporter.sendMail({
    from: `"${APP_NAME}" <${MAIL_FROM}>`,
    to: email,
    subject: `[${APP_NAME}] We received your enquiry`,
    html: `
      <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#035194;padding:28px 32px;"><h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1></div>
          <div style="padding:32px;">
            <h2 style="color:#035194;margin-top:0;">Enquiry Received ✅</h2>
            <p>Hi <strong>${full_name}</strong>,</p>
            <p>Thank you for reaching out! We have received your enquiry and our team will get back to you shortly.</p>
            <div style="background:#f0f9ff;border-left:4px solid #035194;padding:16px;border-radius:4px;margin:20px 0;">
              <p style="margin:4px 0;"><strong>Category:</strong> ${categoryLabel}</p>
              ${subject ? `<p style="margin:4px 0;"><strong>Subject:</strong> ${subject}</p>` : ''}
              ${panchayat && panchayat !== 'N/A' ? `<p style="margin:4px 0;"><strong>Panchayat:</strong> ${panchayat}</p>` : ''}
              <p style="margin:12px 0 4px;"><strong>Your Message:</strong></p>
              <p style="margin:4px 0;color:#555;">${message}</p>
            </div>
            <p style="color:#666;font-size:13px;">We aim to respond within 1–2 working days.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body></html>`,
  });
};

// ─────────────────────────────────────────────────────────────
//  Contact / Enquiry — Admin Alert Email
// ─────────────────────────────────────────────────────────────
export const sendAdminEnquiryAlert = async (enquiry) => {
  const { id, full_name, email, mobile, panchayat, category, subject, message } = enquiry;
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || MAIL_FROM;
  const categoryLabel = category ? category.replace(/\b\w/g, l => l.toUpperCase()) : 'General';
  await transporter.sendMail({
    from: `"${APP_NAME} Alerts" <${MAIL_FROM}>`,
    to: adminEmail,
    subject: `🔔 New Enquiry #${id} — [${categoryLabel}] from ${full_name}`,
    html: `
      <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:580px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#011f3e;padding:24px 32px;">
            <h1 style="color:#fff;margin:0;font-size:18px;">${APP_NAME} — New Enquiry Alert</h1>
          </div>
          <div style="padding:32px;">
            <div style="background:#fff8e1;border:1px solid #F9D05A;border-radius:6px;padding:12px 16px;margin-bottom:24px;">
              <p style="margin:0;font-size:13px;font-weight:bold;color:#7c4f00;">🔔 Enquiry ID #${id} received</p>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr style="background:#f8f9fa;"><td style="padding:10px 14px;font-weight:bold;width:35%;border:1px solid #eee;">Name</td><td style="padding:10px 14px;border:1px solid #eee;">${full_name}</td></tr>
              <tr><td style="padding:10px 14px;font-weight:bold;border:1px solid #eee;">Email</td><td style="padding:10px 14px;border:1px solid #eee;"><a href="mailto:${email}">${email}</a></td></tr>
              <tr style="background:#f8f9fa;"><td style="padding:10px 14px;font-weight:bold;border:1px solid #eee;">Mobile</td><td style="padding:10px 14px;border:1px solid #eee;">${mobile}</td></tr>
              <tr><td style="padding:10px 14px;font-weight:bold;border:1px solid #eee;">Panchayat</td><td style="padding:10px 14px;border:1px solid #eee;">${panchayat}</td></tr>
              <tr style="background:#f8f9fa;"><td style="padding:10px 14px;font-weight:bold;border:1px solid #eee;">Category</td><td style="padding:10px 14px;border:1px solid #eee;"><span style="background:#035194;color:#fff;padding:2px 10px;border-radius:20px;font-size:12px;">${categoryLabel}</span></td></tr>
              ${subject ? `<tr><td style="padding:10px 14px;font-weight:bold;border:1px solid #eee;">Subject</td><td style="padding:10px 14px;border:1px solid #eee;">${subject}</td></tr>` : ''}
            </table>
            <div style="margin-top:20px;background:#f0f9ff;border-left:4px solid #035194;padding:16px;border-radius:4px;">
              <p style="margin:0 0 8px;font-weight:bold;font-size:13px;">Message:</p>
              <p style="margin:0;color:#444;line-height:1.6;">${message}</p>
            </div>
            <div style="margin-top:24px;text-align:center;">
              <a href="${getFrontendUrl()}/admin/dashboard/enquiries"
                 style="background:#035194;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">
                View in Admin Panel →
              </a>
            </div>
            <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. Admin notification only.</p>
          </div>
        </div>
      </body></html>`,
  });
};
// ─────────────────────────────────────────────────────────────
//  Contact / Enquiry — Admin Reply Email
// ─────────────────────────────────────────────────────────────
export const sendEnquiryReplyEmail = async ({ to, full_name, subject, replyMessage }) => {
  const displaySubject = subject && subject !== 'N/A' ? subject : 'Your Enquiry';
  await transporter.sendMail({
    from: `"${APP_NAME}" <${MAIL_FROM}>`,
    to,
    subject: `[${APP_NAME}] Re: ${displaySubject}`,
    html: `
      <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#035194;padding:28px 32px;"><h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1></div>
          <div style="padding:32px;">
            <h2 style="color:#035194;margin-top:0;">Reply to Your Enquiry</h2>
            <p>Hi <strong>${full_name}</strong>,</p>
            <p>Thank you for contacting us. Here is our response to your enquiry:</p>
            <div style="background:#f0f9ff;border-left:4px solid #035194;padding:20px;border-radius:4px;margin:20px 0;line-height:1.7;color:#333;">
              ${replyMessage.replace(/\n/g, '<br>')}
            </div>
            <p style="color:#666;font-size:13px;">If you have any further questions, feel free to reach out to us again.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body></html>`,
  });
};

// ─────────────────────────────────────────────────────────────
//  Registration OTP Email
// ─────────────────────────────────────────────────────────────
export const sendRegistrationOtpEmail = async ({ to, otp }) => {
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Your Registration OTP`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Email Verification</h2>
            <p>You requested to register for an account on MLA Connect.</p>
            <p>Please use the following OTP to verify your email address. This OTP is valid for 10 minutes.</p>
            <div style="background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin:20px 0;text-align:center;">
              <p style="margin:4px 0;font-size:24px;font-weight:bold;letter-spacing:4px;color:#1a3c5e;">${otp}</p>
            </div>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Admin Change Password OTP Email
// ─────────────────────────────────────────────────────────────
export const sendAdminChangePasswordOtpEmail = async ({ to, name, otp }) => {
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Admin Password Reset OTP`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Admin Password Reset</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>We received a request to change your admin account password.</p>
            <p>Please use the following OTP to verify your request. This OTP is valid for 10 minutes.</p>
            <div style="background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin:20px 0;text-align:center;">
              <p style="margin:4px 0;font-size:24px;font-weight:bold;letter-spacing:4px;color:#1a3c5e;">${otp}</p>
            </div>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Constituent Change Password OTP Email
// ─────────────────────────────────────────────────────────────
export const sendConstituentChangePasswordOtpEmail = async ({ to, otp }) => {
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] MLA Connect Password Reset OTP`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Password Reset</h2>
            <p>We received a request to change your MLA Connect account password.</p>
            <p>Please use the following OTP to verify your request. This OTP is valid for 10 minutes.</p>
            <div style="background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin:20px 0;text-align:center;">
              <p style="margin:4px 0;font-size:24px;font-weight:bold;letter-spacing:4px;color:#1a3c5e;">${otp}</p>
            </div>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// ─────────────────────────────────────────────────────────────
//  Forgot Password OTP Email (Admin)
// ─────────────────────────────────────────────────────────────
export const sendForgotPasswordOtpEmail = async ({ to, name, otp }) => {
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `[${APP_NAME}] Password Reset OTP`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
          <div style="background:#1a3c5e;padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#1a3c5e;margin-top:0;">Password Reset</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>We received a request to reset your admin account password.</p>
            <p>Please use the following OTP to verify your request. This OTP is valid for 10 minutes.</p>
            <div style="background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin:20px 0;text-align:center;">
              <p style="margin:4px 0;font-size:24px;font-weight:bold;letter-spacing:4px;color:#1a3c5e;">${otp}</p>
            </div>
            <p style="color:#666;font-size:13px;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};


const generateHtmlFromTemplate = (templateData, bodyContent) => {
  const t = templateData || {};
  const brandName = t.brandName || "MLA Connect";
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
        .header { background: linear-gradient(135deg, #743fd5, #5528b0); padding: 24px; text-align: center; color: #fff; }
        .header-top { margin-bottom: 10px; }
        .logo-circle { width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.2); border: 2px solid rgba(255,255,255,0.3); display: inline-block; line-height: 44px; text-align: center; font-weight: bold; font-size: 20px; color: #fff; vertical-align: middle; }
        .logo-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; vertical-align: middle; }
        .brand-name { font-size: 22px; font-weight: bold; vertical-align: middle; display: inline-block; margin-left: 10px; }
        .tagline { font-size: 13px; color: rgba(255,255,255,0.9); margin: 4px 0; }
        .constituency { font-size: 12px; color: rgba(255,255,255,0.7); margin: 0; }
        .body-content { padding: 32px; font-size: 14px; line-height: 1.6; color: #333; min-height: 160px; }
        .footer { background: #f8f9fa; border-top: 1px solid #eee; padding: 24px; text-align: center; }
        .office-name { font-size: 13px; font-weight: bold; color: #444; margin: 0 0 4px; }
        .address { font-size: 12px; color: #666; margin: 0 0 8px; }
        .contact { font-size: 12px; color: #666; margin: 0 0 12px; }
        .contact span { color: #743fd5; font-weight: bold; margin: 0 4px; }
        .divider { width: 200px; border-top: 1px solid #eee; margin: 12px auto; }
        .copyright { font-size: 11px; color: #999; margin: 4px 0 0; }
        .website { font-size: 11px; color: #999; margin: 4px 0 0; }
        .website a { color: #743fd5; text-decoration: underline; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header -->
        <div class="header">
          <div class="header-top">
            ${t.logoUrl 
              ? `<div class="logo-circle" style="background:#fff;"><img src="${t.logoUrl}" class="logo-img" alt="Logo"/></div>`
              : `<div class="logo-circle">${t.logoInitial || 'M'}</div>`
            }
            <span class="brand-name">${brandName}</span>
          </div>
          ${t.tagline ? `<p class="tagline">${t.tagline}</p>` : ''}
          ${t.constituency ? `<p class="constituency">${t.constituency}</p>` : ''}
        </div>
        
        <!-- Body -->
        <div class="body-content">
${bodyContent}
        </div>
        
        <!-- Footer -->
        <div class="footer">
          ${t.officeName ? `<p class="office-name">${t.officeName}</p>` : ''}
          ${t.address ? `<p class="address">${t.address}</p>` : ''}
          ${(t.email || t.phone) ? `<p class="contact">
            ${t.email ? `<span>${t.email}</span>` : ''}
            ${t.phone ? `<span>${t.phone}</span>` : ''}
          </p>` : ''}
          
          <div class="divider"></div>
          
          ${t.copyright ? `<p class="copyright">${t.copyright}</p>` : ''}
          ${t.website ? `<p class="website">Sent through <a href="${t.website}">${t.website}</a></p>` : ''}
        </div>
      </div>
    </body>
    </html>
  `;
};
export const sendNotificationEmail = async ({ to, subject, message }) => {
  const formattedMessage = /<[a-z][\s\S]*>/i.test(message || '') ? message : (message || '').replace(/\n/g, '<br>');
  let finalHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);"><div style="background:#035194;padding:28px 32px;"><h1 style="color:#fff;margin:0;font-size:22px;">${APP_NAME}</h1></div><div style="padding:32px;line-height:1.6;color:#333;font-size:15px;">${formattedMessage}<hr style="border:none;border-top:1px solid #eee;margin:32px 0 24px;"><p style="color:#999;font-size:12px;margin:0;">&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p></div></div></body></html>`;

  try {
    const [rows] = await pool.query('SELECT setting_value FROM site_settings WHERE setting_key = "mla_email_template"');
    if (rows.length > 0 && rows[0].setting_value) {
      const templateObj = JSON.parse(rows[0].setting_value);
      finalHtml = generateHtmlFromTemplate(templateObj, formattedMessage);
    }
  } catch (err) {
    console.error("Error fetching mla_email_template:", err);
  }

  await transporter.sendMail({
    from: `"${APP_NAME}" <${MAIL_FROM}>`,
    to,
    subject: subject || `[${APP_NAME}] New Update`,
    html: finalHtml
  });
};

