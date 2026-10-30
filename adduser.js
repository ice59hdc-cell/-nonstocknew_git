// Usage: node adduser.js <username> <password> [admin|viewer]   (creates or replaces the user)
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [, , username, password, role = 'viewer'] = process.argv;
if (!username || !password || !['admin', 'viewer'].includes(role)) {
  console.error('usage: node adduser.js <username> <password> [admin|viewer]');
  process.exit(1);
}
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer')`);
const salt = crypto.randomBytes(16).toString('hex');
db.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?,?)').run(username, crypto.scryptSync(password, salt, 64).toString('hex'), salt, role);
console.log(`saved ${username} (${role})`);
