const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required for Neon
});

(async () => {
  try {
    const res = await pool.query('SELECT version();');
    console.log('✅ Connected! PostgreSQL version:', res.rows[0].version);
  } catch (err) {
    console.error('❌ DB connection failed:', err);
  } finally {
    await pool.end();
  }
})();
