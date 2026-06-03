const { createClient } = require('@libsql/client');
const path = require('path');
const db = createClient({ url: `file:/app/data/local.db` });

db.execute(`SELECT group_title, COUNT(*) as count FROM channels GROUP BY group_title`).then(res => {
    console.log(JSON.stringify(res.rows, null, 2));
}).catch(console.error);
