// ─────────────────────────────────────────────────────────────────────────────
// SMS Template Builders — Office of Kothamangalam MLA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template 1 — Submission Confirmation
 * Sent immediately after a constituent submits a Complaint / Issue / Suggestion / Idea / Application.
 *
 * @param {object} opts
 * @param {string} opts.name          - Complainant / submitter name
 * @param {string} opts.dateFiled     - Date the record was filed
 * @param {string} opts.referenceNo   - e.g. C-001, P-002, S-003, I-004
 */
export const submissionConfirmationSMS = ({ name, dateFiled, referenceNo, statusDetails, moduleLabel }) => {
    const d = new Date(dateFiled);
    const dateStr = !isNaN(d) ? d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : dateFiled;
    const reviewMsg = statusDetails?.trim() || "We are reviewing your submission.";
    const label = moduleLabel || "Submission";
    return `Hi ${name},\n\n${label} received: ${dateStr}\n${reviewMsg}\nTracking ID: ${referenceNo}\n\nOffice of Kothamangalam MLA`;
};

/**
 * Template 2 — Follow-up / Status Update
 * Sent when an admin adds an update and enables "Notify Complainant via SMS".
 *
 * @param {object} opts
 * @param {string} opts.name          - Complainant / submitter name
 * @param {string} opts.referenceNo   - e.g. C-001, P-002, S-003, I-004
 * @param {string} opts.statusTitle   - The title field of the follow-up update (e.g. "Letter submitted to Health Minister")
 * @param {string} opts.moduleLabel   - Human-readable module label: "Complaint", "Application", "Idea", "Suggestion", "Public Issue"
 * @param {Date|string} opts.updateDate - Date of this update (defaults to now)
 * @param {Date|string} opts.dateFiled  - Date the original record was filed
 */
export const followUpUpdateSMS = ({ name, referenceNo, statusTitle, moduleLabel, updateDate, dateFiled }) => {
    const dFiled = dateFiled ? new Date(dateFiled) : null;
    const filedDateStr = (dFiled && !isNaN(dFiled)) ? dFiled.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : (dateFiled || 'N/A');
    
    const status = (statusTitle || '').trim() || 'We are reviewing your submission.';
    return `Hi ${name},\n\nApplication Received: ${filedDateStr}\nTracking ID: ${referenceNo}\nStatus : ${status}\n\nOffice of Kothamangalam MLA`;
};

/**
 * Template 3 — WhatsApp Follow-up / Status Update
 */
export const followUpUpdateWhatsApp = ({ name, referenceNo, statusTitle, moduleLabel, updateDate, dateFiled }) => {
    const dFiled = dateFiled ? new Date(dateFiled) : null;
    const filedDateStr = (dFiled && !isNaN(dFiled)) ? dFiled.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : (dateFiled || 'N/A');
    
    const status = (statusTitle || '').trim() || 'We are reviewing your submission.';
    return `*Hi ${name},*\n\nApplication Received: ${filedDateStr}\nTracking ID: *${referenceNo}*\nStatus : ${status}\n\n_Office of Kothamangalam MLA_`;
};

/**
 * Template 4 — Email Follow-up / Status Update
 * Returns an object with { subject, body }
 */
export const followUpUpdateEmail = ({ name, referenceNo, statusTitle, moduleLabel, updateDate }) => {
    const d = new Date(updateDate || Date.now());
    const dateStr = !isNaN(d) ? d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : String(updateDate || '');
    const label = moduleLabel || 'Application';
    const status = (statusTitle || '').trim() || 'We are reviewing your submission.';

    return {
        subject: `Update on your ${label} [${referenceNo}]`,
        body: `Dear ${name},\n\nThis is an update regarding your ${label.toLowerCase()} on ${dateStr}.\n\nStatus Details:\n${status}\n\nBest Regards,\nOffice of Kothamangalam MLA`
    };
};
