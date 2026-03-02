import 'dotenv/config';
import axios from 'axios';

/**
 * WhatsApp Business API Service Configuration
 * Uses official WhatsApp Business API (Cloud API) for sending messages
 */

const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BA_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`;

if (!WHATSAPP_API_KEY || !WHATSAPP_PHONE_ID) {
    console.warn('⚠️  WhatsApp API keys not configured. WhatsApp service will not work.');
}

/**
 * Send WhatsApp Message via Official API
 * @param {string} phoneNumber - Recipient phone number (with country code, e.g., 91XXXXXXXXXX)
 * @param {string} message - Message content
 * @returns {Promise<Object>} Response from WhatsApp API
 */
export const sendWhatsAppMessage = async (phoneNumber, message) => {
    if (!WHATSAPP_API_KEY || !WHATSAPP_PHONE_ID) {
        throw new Error('WhatsApp API credentials are not configured.');
    }

    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'text',
                text: {
                    preview_url: false,
                    body: message,
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        console.log(`✅ WhatsApp message sent to ${phoneNumber}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ WhatsApp API Error:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
    }
};

/**
 * Send WhatsApp Template Message
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} templateName - Template name
 * @param {Array} parameters - Template parameters/placeholders
 * @returns {Promise<Object>} Response from WhatsApp API
 */
export const sendWhatsAppTemplate = async (phoneNumber, templateName, parameters = []) => {
    if (!WHATSAPP_API_KEY || !WHATSAPP_PHONE_ID) {
        throw new Error('WhatsApp API credentials are not configured.');
    }

    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: {
                    name: templateName,
                    language: {
                        code: 'en_US',
                    },
                    ...(parameters.length > 0 && {
                        components: [
                            // Header component for media
                            ...(parameters.find(p => p.type === 'header') ? [{
                                type: 'header',
                                parameters: [parameters.find(p => p.type === 'header').payload]
                            }] : []),
                            // Body component for text placeholders
                            {
                                type: 'body',
                                parameters: parameters.filter(p => !p.type || p.type === 'text').map(p => ({
                                    type: 'text',
                                    text: typeof p === 'string' ? p : p.payload
                                })),
                            },
                        ],
                    }),
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        console.log(`✅ WhatsApp template sent to ${phoneNumber}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ WhatsApp Template Error:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp template');
    }
};

/**
 * Send WhatsApp Interactive Message (with buttons and media)
 * Use this for session messages (within 24h window) - does not require pre-approval.
 */
export const sendWhatsAppInteractive = async (phoneNumber, header, body, buttons = []) => {
    if (!WHATSAPP_API_KEY || !WHATSAPP_PHONE_ID) {
        throw new Error('WhatsApp API credentials are not configured.');
    }

    const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: body },
            action: {
                buttons: buttons.slice(0, 3).map((btn, idx) => ({
                    type: 'reply',
                    reply: {
                        id: `btn_${idx}`,
                        title: btn.text.substring(0, 20)
                    }
                }))
            }
        }
    };

    if (header && header.type !== 'none') {
        if (header.type === 'text') {
            payload.interactive.header = { type: 'text', text: header.content };
        } else {
            payload.interactive.header = {
                type: header.type,
                [header.type]: { url: header.url }
            };
        }
    }

    try {
        const response = await axios.post(WHATSAPP_API_URL, payload, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ WhatsApp Interactive Error:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp interactive message');
    }
};

export default { sendWhatsAppMessage, sendWhatsAppTemplate, sendWhatsAppInteractive };
