#!/usr/bin/env node
// Usage: DATABASE_URL=... node scripts/migrate-sqlite-to-neon.mjs [path/to/data.db]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { neon } from '@neondatabase/serverless';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.argv[2] || path.join(root, 'data.db'));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be set. It is never read from a file.');
if (!fs.existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`);

const TABLES = Object.freeze({
  units: { pk: 'unit_id', columns: ['unit_id', 'unit_name', 'district', 'affiliation', 'active', 'note'] },
  transactions: { pk: 'txn_id', columns: ['txn_id', 'unit_id', 'fiscal_year', 'month_no', 'calendar_year', 'month_name', 'disbursed_A', 'stock_B', 'reserve_C', 'source', 'note', 'recorded_at', 'updated_at'] },
  insights: { pk: 'id', columns: ['id', 'title', 'source', 'insight', 'action', 'priority', 'status', 'created_at', 'updated_at'] },
  lessons: { pk: 'id', columns: ['id', 'unit_id', 'fiscal_year', 'month_no', 'problem', 'obstacle', 'solution', 'status', 'created_at', 'updated_at'] },
  master_prompts: { pk: 'id', columns: ['id', 'title', 'category', 'purpose', 'prompt', 'tags', 'status', 'created_at', 'updated_at'] },
  kpi_targets: { pk: 'fiscal_year', columns: ['fiscal_year', 'green_min', 'green_max', 'warn_low', 'warn_high', 'note'] },
  users: { pk: 'username', columns: ['username', 'pass_hash', 'salt', 'role'] }
});
const sql = neon(connectionString);
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const exists = (name) => Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const normalize = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
const identifier = (name) => `"${name}"`; // Called only with the TABLES allowlist.

async function applySchema() {
  const statements = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
    .split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) await sql.query(statement);
}
async function copyTable(name, spec) {
  if (!exists(name)) { console.log(`${name}: absent in SQLite; skipped`); return 0; }
  const rows = sqlite.prepare(`SELECT * FROM ${name}`).all().map(normalize);
  if (!rows.length) { console.log(`${name}: 0`); return 0; }
  const placeholders = spec.columns.map((_, index) => `$${index + 1}`).join(', ');
  const updates = spec.columns.filter((column) => column !== spec.pk).map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`).join(', ');
  const statement = `INSERT INTO ${name} (${spec.columns.map(identifier).join(', ')}) VALUES (${placeholders}) ON CONFLICT (${identifier(spec.pk)}) DO UPDATE SET ${updates}`;
  for (const row of rows) await sql.query(statement, spec.columns.map((column) => row[column.toLowerCase()] ?? null));
  console.log(`${name}: ${rows.length}`); return rows.length;
}

try {
  await applySchema();
  let copied = 0;
  for (const [name, spec] of Object.entries(TABLES)) copied += await copyTable(name, spec);
  const userCount = Number((await sql.query('SELECT COUNT(*)::int AS count FROM users'))[0].count);
  if (!userCount) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 8) throw new Error('SQLite has no users; set ADMIN_PASSWORD to a password of at least 8 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    await sql.query("INSERT INTO users(username, pass_hash, salt, role) VALUES('admin', $1, $2, 'admin')", [hash, salt]);
    console.log('users: created admin from ADMIN_PASSWORD');
  }
  console.log(`Migration complete: ${copied} SQLite rows copied. Sessions are intentionally not migrated.`);
} finally {
  sqlite.close();
}
