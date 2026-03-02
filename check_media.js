import db from './configs/db.js';

async function checkData() {
    try {
        const [rows] = await db.query('SELECT id, media_type, file_url, thumbnail_url, youtube_url FROM event_media WHERE media_type = "video" LIMIT 10');
        console.log('Video data in event_media:');
        console.table(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}
checkData();
