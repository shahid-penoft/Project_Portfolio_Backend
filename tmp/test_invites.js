import db from '../configs/db.js';
import { sendEventInvitations } from '../controllers/eventController.js';

async function testInvitations() {
    console.log('--- Starting Event Invitations Test ---');

    // 1. Mock req, res
    const req = {
        params: { id: 1 },
        body: {
            channel: 'whatsapp', // Using whatsapp to avoid actual SMTP sending in test
            target_ids: [],
            filters: { local_body_id: 'all', ward_id: 'all' },
            message_template: 'Test [Name] - [EventName]'
        }
    };

    const res = {
        status: function (code) {
            this.statusCode = code;
            return this;
        },
        json: function (data) {
            this.data = data;
            console.log('--- Response Start ---');
            console.log('Status Code:', this.statusCode);
            console.log('JSON Data:', JSON.stringify(data, null, 2));
            console.log('--- Response End ---');
            return this;
        },
        statusCode: 200,
        data: null
    };

    try {
        console.log('Triggering sendEventInvitations...');
        await sendEventInvitations(req, res);
    } catch (err) {
        console.error('CRITICAL ERROR in controller:', err);
    } finally {
        console.log('Closing database connection...');
        await db.end();
        console.log('Test complete.');
        process.exit();
    }
}

testInvitations();
