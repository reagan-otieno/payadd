const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'adpay',
  user:     process.env.DB_USER     || 'adpay_user',
  password: process.env.DB_PASSWORD,
  max:      20,       // max connections in pool
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Check your .env DB_* settings');
  } else {
    console.log('✅ PostgreSQL connected');
    release();
  }
});

module.exports = pool;
