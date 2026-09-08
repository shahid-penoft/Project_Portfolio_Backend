import pool from '../configs/db.js';

/**
 * Migration 019: Convert Intake Module ENUMs to VARCHAR(100) & Backfill Corrupted Records
 * 
 * Tables:
 * - suggestions (status, priority)
 * - complaints (status, priority)
 * - ideas (status, priority)
 * - issues (status, priority)
 * - cm_fund_requests (priority)
 */

export async function runMigration() {
    const connection = await pool.getConnection();
    try {
        console.log('🚀 Starting Migration 019: Converting intake ENUMs to VARCHAR(100)...');
        await connection.beginTransaction();

        // 1. Convert suggestions
        console.log('Converting suggestions columns...');
        await connection.query(`
            ALTER TABLE \`suggestions\`
              MODIFY COLUMN \`status\` VARCHAR(100) NOT NULL DEFAULT 'Pending',
              MODIFY COLUMN \`priority\` VARCHAR(100) NOT NULL DEFAULT 'Medium'
        `);
        console.log('✓ suggestions columns modified to VARCHAR(100).');

        // 2. Convert complaints
        console.log('Converting complaints columns...');
        await connection.query(`
            ALTER TABLE \`complaints\`
              MODIFY COLUMN \`status\` VARCHAR(100) NOT NULL DEFAULT 'Pending',
              MODIFY COLUMN \`priority\` VARCHAR(100) NOT NULL DEFAULT 'Medium'
        `);
        console.log('✓ complaints columns modified to VARCHAR(100).');

        // 3. Convert ideas
        console.log('Converting ideas columns...');
        await connection.query(`
            ALTER TABLE \`ideas\`
              MODIFY COLUMN \`status\` VARCHAR(100) NOT NULL DEFAULT 'Pending',
              MODIFY COLUMN \`priority\` VARCHAR(100) NOT NULL DEFAULT 'Medium'
        `);
        console.log('✓ ideas columns modified to VARCHAR(100).');

        // 4. Convert issues
        console.log('Converting issues columns...');
        await connection.query(`
            ALTER TABLE \`issues\`
              MODIFY COLUMN \`status\` VARCHAR(100) NOT NULL DEFAULT 'Pending',
              MODIFY COLUMN \`priority\` VARCHAR(100) NOT NULL DEFAULT 'Medium'
        `);
        console.log('✓ issues columns modified to VARCHAR(100).');

        // 5. Convert cm_fund_requests
        console.log('Converting cm_fund_requests priority...');
        await connection.query(`
            ALTER TABLE \`cm_fund_requests\`
              MODIFY COLUMN \`priority\` VARCHAR(100) NOT NULL DEFAULT 'Normal'
        `);
        console.log('✓ cm_fund_requests priority modified to VARCHAR(100).');

        // 6. Backfill suggestions with empty status
        const [resSugTest] = await connection.query(`
            UPDATE \`suggestions\`
              SET \`status\` = 'test'
              WHERE \`id\` IN (8, 21) AND (\`status\` = '' OR \`status\` IS NULL)
        `);
        const [resSugPending] = await connection.query(`
            UPDATE \`suggestions\`
              SET \`status\` = 'Pending'
              WHERE \`status\` = '' OR \`status\` IS NULL
        `);
        console.log(`✓ suggestions backfilled: ${resSugTest.affectedRows} restored to 'test', ${resSugPending.affectedRows} set to 'Pending'.`);

        // 7. Backfill complaints with empty status
        const [resComp] = await connection.query(`
            UPDATE \`complaints\`
              SET \`status\` = 'Under Review'
              WHERE (\`status\` = '' OR \`status\` IS NULL) AND \`is_deleted\` = 0
        `);
        console.log(`✓ complaints backfilled: ${resComp.affectedRows} restored to 'Under Review'.`);

        // 8. Safeguard ideas & issues
        const [resIdeas] = await connection.query(`
            UPDATE \`ideas\`
              SET \`status\` = 'Pending'
              WHERE (\`status\` = '' OR \`status\` IS NULL) AND \`is_deleted\` = 0
        `);
        const [resIssues] = await connection.query(`
            UPDATE \`issues\`
              SET \`status\` = 'Under Process'
              WHERE (\`status\` = '' OR \`status\` IS NULL) AND \`is_deleted\` = 0
        `);
        console.log(`✓ ideas (${resIdeas.affectedRows}) and issues (${resIssues.affectedRows}) empty status records cleaned.`);

        await connection.commit();
        console.log('\n✅ Migration 019 completed successfully!');
    } catch (error) {
        await connection.rollback();
        console.error('❌ Migration 019 failed! Transaction rolled back.', error);
        throw error;
    } finally {
        connection.release();
    }
}

// Allow direct execution: `node migrations/019_convert_intake_enums_to_varchar.js`
if (process.argv[1]?.endsWith('019_convert_intake_enums_to_varchar.js')) {
    runMigration()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}
