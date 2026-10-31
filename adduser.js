// Usage: DATABASE_URL=... node adduser.js <username> <password> [admin|viewer]
const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');
const [, , username, password, role = 'viewer'] = process.argv;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username || '') || typeof password !== 'string' || password.length < 8 || !['admin', 'viewer'].includes(role)) {
  console.error('usage: DATABASE_URL=... node adduser.js <username> <password (8+ chars)> [admin|viewer]');
  process.exit(1);
}

(async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const sql = neon(process.env.DATABASE_URL);
  await sql.query('INSERT INTO users(username, pass_hash, salt, role) VALUES($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET pass_hash = EXCLUDED.pass_hash, salt = EXCLUDED.salt, role = EXCLUDED.role', [username, hash, salt, role]);
  await sql.query('DELETE FROM sessions WHERE username = $1', [username]);
  console.log(`saved ${username} (${role})`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
