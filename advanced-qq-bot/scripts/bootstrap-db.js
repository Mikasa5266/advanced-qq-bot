const db = require('../db');

async function ensureIndex(tableName, indexName, createSql) {
    const [rows] = await db.query(
        `
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND index_name = ?
        LIMIT 1
        `,
        [tableName, indexName]
    );

    if (rows.length > 0) {
        console.log(`[DB] Index exists: ${tableName}.${indexName}`);
        return;
    }

    await db.query(createSql);
    console.log(`[DB] Index created: ${tableName}.${indexName}`);
}

async function main() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_memory (
            user_id VARCHAR(64) NOT NULL PRIMARY KEY,
            summary MEDIUMTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS chat_history (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(64) NOT NULL,
            role VARCHAR(16) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await ensureIndex(
        'chat_history',
        'idx_chat_user_id_id',
        'CREATE INDEX idx_chat_user_id_id ON chat_history (user_id, id)'
    );

    await ensureIndex(
        'chat_history',
        'idx_chat_user_created_at',
        'CREATE INDEX idx_chat_user_created_at ON chat_history (user_id, created_at)'
    );

    await ensureIndex(
        'user_memory',
        'idx_user_memory_updated_at',
        'CREATE INDEX idx_user_memory_updated_at ON user_memory (updated_at)'
    );

    console.log('[DB] Bootstrap complete.');
}

main()
    .catch((error) => {
        console.error('[DB] Bootstrap failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await db.end();
    });
