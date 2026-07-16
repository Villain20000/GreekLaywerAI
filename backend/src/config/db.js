const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'nomos_admin',
  password: process.env.DB_PASSWORD || 'nomos_password',
  database: process.env.DB_NAME || 'nomos_db'
});

module.exports = pool;
