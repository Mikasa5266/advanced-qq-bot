// db.js
const mysql = require('mysql2/promise');

// 创建数据库连接池，比单次连接更高效、稳定
const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'qq_bot_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'qq_bot_db',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4'
});

// 测试连接是否成功
pool.getConnection()
    .then(conn => {
        console.log('✅ 数据库连接成功！');
        conn.release();
    })
    .catch(err => {
        console.error('❌ 数据库连接失败:', err.message);
    });

if (!process.env.DB_PASSWORD) {
    console.warn('提示: 未设置 DB_PASSWORD，数据库连接可能失败。');
}

module.exports = pool;