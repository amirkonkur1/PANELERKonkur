const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const fallbackState = { userId: 1, state: {} };

const mysqlUrl = process.env.MYSQL_URL || '';
const mysqlHostFromUrl = mysqlUrl.match(/@([^:/]+)/);
const mysqlUserFromUrl = mysqlUrl.match(/mysql:\/\/([^:]+)/);
const mysqlPasswordFromUrl = mysqlUrl.match(/mysql:\/\/[^:]+:([^@]+)/);
const mysqlDbFromUrl = mysqlUrl.match(/\/([^/?]+)(?:\?|$)/);

const dbConfig = {
  host: process.env.MYSQLHOST || process.env.MYSQL_HOST || (mysqlHostFromUrl ? mysqlHostFromUrl[1] : '127.0.0.1'),
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER || (mysqlUserFromUrl ? mysqlUserFromUrl[1] : 'root'),
  password: process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD || (mysqlPasswordFromUrl ? decodeURIComponent(mysqlPasswordFromUrl[1]) : ''),
  database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || (mysqlDbFromUrl ? mysqlDbFromUrl[1] : 'railway'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

let pool = null;
const isPlaceholderHost = !dbConfig.host || dbConfig.host.includes('RAILWAY_PRIVATE_DOMAIN') || dbConfig.host.includes('${{') || dbConfig.host.includes('YOUR_');

async function initDatabase() {
  if (isPlaceholderHost) {
    console.log('⚠️ MySQL host is not configured yet. Running in single-user fallback mode.');
    return;
  }

  try {
    pool = mysql.createPool(dbConfig);
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        state JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ MySQL connected successfully.');
  } catch (error) {
    pool = null;
    console.log('⚠️ MySQL unavailable. Running in single-user fallback mode.');
    console.log(error.message);
  }
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    database: dbConfig.database,
    user: dbConfig.user,
    host: dbConfig.host,
    port: dbConfig.port,
    mode: pool ? 'mysql' : 'fallback-single-user'
  });
});

app.get('/api/state', async (req, res) => {
  try {
    if (!pool) {
      return res.json({ userId: 1, state: fallbackState.state });
    }

    const [rows] = await pool.execute(
      'SELECT state FROM app_state WHERE user_id = 1 LIMIT 1'
    );

    const state = rows[0] && rows[0].state ? rows[0].state : {};
    return res.json({ userId: 1, state });
  } catch (error) {
    console.error('GET /api/state failed:', error.message);
    return res.status(500).json({ error: 'Failed to load state' });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const incomingState = req.body && typeof req.body === 'object' ? req.body : {};

    if (!pool) {
      fallbackState.state = incomingState;
      return res.json({ ok: true, userId: 1, mode: 'fallback-single-user' });
    }

    await pool.execute(
      'INSERT INTO app_state (user_id, state) VALUES (?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP',
      [1, JSON.stringify(incomingState)]
    );

    return res.json({ ok: true, userId: 1, mode: 'mysql' });
  } catch (error) {
    console.error('POST /api/state failed:', error.message);
    return res.status(500).json({ error: 'Failed to save state' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
