import pool from './configs/db.js';

async function describeTable() {
    try {
        const [rows] = await pool.query('DESCRIBE enquiry_communications');
        console.log('Schema for enquiry_communications:');
        console.table(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}
describeTable();
