const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const SESSION_SECONDS = 8 * 60 * 60;
const MONTHS = ['ตุลาคม', 'พฤศจิกายน', 'ธันวาคม', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน'];
const TABLES = Object.freeze({
  units: { pk: 'unit_id', cols: ['unit_id', 'unit_name', 'district', 'affiliation', 'active', 'note'], required: ['unit_id', 'unit_name', 'district'] },
  transactions: { pk: 'txn_id', cols: ['txn_id', 'unit_id', 'fiscal_year', 'month_no', 'calendar_year', 'month_name', 'disbursed_A', 'stock_B', 'reserve_C', 'source', 'note', 'recorded_at', 'updated_at'], required: ['unit_id', 'fiscal_year', 'month_no'], stamps: true },
  insights: { pk: 'id', cols: ['id', 'title', 'source', 'insight', 'action', 'priority', 'status', 'created_at', 'updated_at'], required: ['title'], prefix: 'KI', stamps: true },
  lessons: { pk: 'id', cols: ['id', 'unit_id', 'fiscal_year', 'month_no', 'problem', 'obstacle', 'solution', 'status', 'created_at', 'updated_at'], required: ['problem'], prefix: 'LL', stamps: true },
  master_prompts: { pk: 'id', cols: ['id', 'title', 'category', 'purpose', 'prompt', 'tags', 'status', 'created_at', 'updated_at'], required: ['title', 'prompt'], prefix: 'MP', stamps: true },
  kpi_targets: { pk: 'fiscal_year', cols: ['fiscal_year', 'green_min', 'green_max', 'warn_low', 'warn_high', 'note'], required: ['fiscal_year'] }
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(process.env.DATABASE_URL);
}
function query(sql, params = []) { return database().query(sql, params); }
function identifier(name) { return `"${name}"`; } // Called only with TABLES allowlist entries.
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function safeEqual(a, b) {
  const left = Buffer.from(a, 'hex'); const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((part) => {
    const at = part.indexOf('='); return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
  }));
}
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.statusCode = status; res.setHeader('Content-Type', type);
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function parseBody(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { throw new HttpError(400, 'JSON ไม่ถูกต้อง'); }
  }
  if (!plainObject(req.body)) throw new HttpError(400, 'JSON ต้องเป็น object');
  return req.body;
}
function pick(table, body) {
  const result = {};
  for (const column of table.cols) if (body[column] !== undefined) result[column] = body[column] === '' ? null : body[column];
  return result;
}
function prepare(name, row, isNew) {
  const table = TABLES[name];
  for (const required of table.required) if (row[required] == null || row[required] === '') throw new HttpError(400, `ต้องระบุ ${required}`);
  if (name === 'transactions') {
    row.fiscal_year = Number(row.fiscal_year); row.month_no = Number(row.month_no);
    if (!Number.isInteger(row.fiscal_year) || !Number.isInteger(row.month_no) || row.month_no < 1 || row.month_no > 12) throw new HttpError(400, 'fiscal_year และ month_no ต้องถูกต้อง (month_no 1-12)');
    for (const key of ['disbursed_A', 'stock_B', 'reserve_C']) if (row[key] != null) {
      row[key] = Number(row[key]); if (!Number.isFinite(row[key]) || row[key] < 0) throw new HttpError(400, `${key} ต้องเป็นตัวเลขไม่ติดลบ`);
    }
    row.calendar_year = row.month_no <= 3 ? row.fiscal_year - 1 : row.fiscal_year;
    row.month_name = MONTHS[row.month_no - 1];
    if (isNew) row.txn_id = `${row.fiscal_year}-${String(row.month_no).padStart(2, '0')}-${row.unit_id}`;
    row.source = row.source || 'web';
  }
  if (name === 'kpi_targets') { row.fiscal_year = Number(row.fiscal_year); if (!Number.isInteger(row.fiscal_year)) throw new HttpError(400, 'fiscal_year ต้องเป็นจำนวนเต็ม'); }
  if (table.stamps) { if (isNew) row[name === 'transactions' ? 'recorded_at' : 'created_at'] = now(); row.updated_at = now(); }
  return row;
}
function csv(rows) {
  if (!rows.length) return '\ufeff';
  const columns = Object.keys(rows[0]);
  const cell = (value) => { const text = value == null ? '' : String(value); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  return '\ufeff' + [columns.join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\r\n');
}
async function session(req) {
  const sid = cookies(req).sid; if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const rows = await query('SELECT u.username, u.role FROM sessions s JOIN users u ON u.username = s.username WHERE s.token_hash = $1 AND s.expires_at > now()', [tokenHash(sid)]);
  return rows[0] || null;
}
async function getOne(name, id) {
  const table = TABLES[name];
  return (await query(`SELECT * FROM ${name} WHERE ${table.pk} = $1`, [id]))[0] || null;
}
async function requireAdmin(sess) { if (!sess || sess.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ'); }
async function users(req, parts, body, sess) {
  await requireAdmin(sess);
  const username = parts[1] || null;
  const publicUser = async (name) => (await query('SELECT username, role FROM users WHERE username = $1', [name]))[0] || null;
  const validRole = (role) => { if (!['admin', 'viewer'].includes(role)) throw new HttpError(400, 'role ต้องเป็น admin หรือ viewer'); };
  const validPassword = (password) => { if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); };
  if (req.method === 'GET' && !username) return query('SELECT username, role FROM users ORDER BY username');
  if (req.method === 'POST' && !username) {
    const name = typeof body.username === 'string' ? body.username.trim() : '';
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) throw new HttpError(400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 _ . - ความยาว 3–32 ตัว');
    validRole(body.role); validPassword(body.password); if (await publicUser(name)) throw new HttpError(409, `มีผู้ใช้ ${name} อยู่แล้ว`);
    const salt = crypto.randomBytes(16).toString('hex');
    await query('INSERT INTO users(username, pass_hash, salt, role) VALUES($1, $2, $3, $4)', [name, passwordHash(body.password, salt), salt, body.role]);
    return publicUser(name);
  }
  if (req.method === 'PUT' && username) {
    const current = await publicUser(username); if (!current) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const role = body.role ?? current.role; validRole(role);
    const adminCount = Number((await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"))[0].count);
    if (current.role === 'admin' && role !== 'admin' && adminCount <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
    if (body.password !== undefined) {
      validPassword(body.password); const salt = crypto.randomBytes(16).toString('hex');
      await query('UPDATE users SET pass_hash = $1, salt = $2, role = $3 WHERE username = $4', [passwordHash(body.password, salt), salt, role, username]);
    } else await query('UPDATE users SET role = $1 WHERE username = $2', [role, username]);
    if (body.password !== undefined || role !== current.role) await query('DELETE FROM sessions WHERE username = $1', [username]);
    return publicUser(username);
  }
  if (req.method === 'DELETE' && username) {
    const current = await publicUser(username); if (!current) throw new HttpError(404, 'ไม่พบผู้ใช้');
    if (username === sess.username) throw new HttpError(400, 'ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้');
    const adminCount = Number((await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'"))[0].count);
    if (current.role === 'admin' && adminCount <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
    await query('DELETE FROM users WHERE username = $1', [username]); return { deleted: username };
  }
  throw new HttpError(405, 'method ไม่รองรับ');
}
async function tableApi(req, name, id, body) {
  const table = TABLES[name];
  if (req.method === 'GET' && id == null) return query(`SELECT * FROM ${name}`);
  if (req.method === 'GET') { const row = await getOne(name, id); if (!row) throw new HttpError(404, 'ไม่พบข้อมูล'); return row; }
  if (req.method === 'POST' && id == null) {
    const row = pick(table, body); if (table.prefix && !row[table.pk]) row[table.pk] = table.prefix + crypto.randomBytes(6).toString('hex');
    prepare(name, row, true); if (row[table.pk] == null || row[table.pk] === '') throw new HttpError(400, `ต้องระบุ ${table.pk}`);
    if (await getOne(name, row[table.pk])) throw new HttpError(409, `มี ${row[table.pk]} อยู่แล้ว`);
    const columns = Object.keys(row); const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    try { await query(`INSERT INTO ${name}(${columns.map(identifier).join(', ')}) VALUES(${placeholders})`, columns.map((column) => row[column])); }
    catch (error) { if (error.code === '23505') throw new HttpError(409, `มี ${row[table.pk]} อยู่แล้ว`); if (error.code === '23503') throw new HttpError(409, 'ข้อมูลถูกอ้างอิงอยู่ หรืออ้างอิงรหัสที่ไม่มีอยู่'); throw error; }
    return getOne(name, row[table.pk]);
  }
  if (req.method === 'PUT' && id != null) {
    const current = await getOne(name, id); if (!current) throw new HttpError(404, 'ไม่พบข้อมูล');
    const row = { ...current, ...pick(table, body) }; row[table.pk] = current[table.pk];
    if (name === 'transactions') { row.unit_id = current.unit_id; row.fiscal_year = current.fiscal_year; row.month_no = current.month_no; }
    prepare(name, row, false); const columns = table.cols.filter((column) => column !== table.pk);
    try { await query(`UPDATE ${name} SET ${columns.map((column, index) => `${identifier(column)} = $${index + 1}`).join(', ')} WHERE ${table.pk} = $${columns.length + 1}`, [...columns.map((column) => row[column] ?? null), id]); }
    catch (error) { if (error.code === '23503') throw new HttpError(409, 'ข้อมูลถูกอ้างอิงอยู่ หรืออ้างอิงรหัสที่ไม่มีอยู่'); throw error; }
    return getOne(name, id);
  }
  if (req.method === 'DELETE' && id != null) {
    const result = await query(`DELETE FROM ${name} WHERE ${table.pk} = $1 RETURNING ${table.pk}`, [id]);
    if (!result.length) throw new HttpError(404, 'ไม่พบข้อมูล'); return { deleted: id };
  }
  throw new HttpError(405, 'method ไม่รองรับ');
}
async function login(body, res) {
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = (await query('SELECT username, pass_hash, salt, role FROM users WHERE username = $1', [username]))[0];
  if (!user || !safeEqual(passwordHash(password, user.salt), user.pass_hash)) throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  const token = crypto.randomBytes(32).toString('hex');
  await query('DELETE FROM sessions WHERE expires_at <= now()');
  await query('INSERT INTO sessions(token_hash, username, expires_at) VALUES($1, $2, now() + ($3 * interval \'1 second\'))', [tokenHash(token), user.username, SESSION_SECONDS]);
  setCookie(res, token, SESSION_SECONDS); return { username: user.username, role: user.role };
}
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://localhost');
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const route = parts.join('/'); const body = parseBody(req);
    if (route === 'login' && req.method === 'POST') return send(res, 200, await login(body, res));
    if (route === 'logout' && req.method === 'POST') {
      const sid = cookies(req).sid; if (sid && /^[a-f0-9]{64}$/.test(sid)) await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(sid)]);
      setCookie(res, '', 0); return send(res, 200, { ok: true });
    }
    const sess = await session(req);
    if (route === 'me') return sess ? send(res, 200, sess) : send(res, 401, { error: 'ยังไม่ได้เข้าสู่ระบบ' });
    if (!sess) throw new HttpError(401, 'ยังไม่ได้เข้าสู่ระบบ');
    if (parts[0] === 'users') return send(res, 200, await users(req, parts, body, sess));
    if (req.method !== 'GET' && sess.role !== 'admin') throw new HttpError(403, 'บัญชีนี้ดูข้อมูลได้อย่างเดียว');
    if (parts[0] === 'export' && parts.length === 2 && parts[1].endsWith('.csv')) {
      const name = parts[1].slice(0, -4); if (!TABLES[name]) throw new HttpError(404, 'ไม่พบตาราง');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      return send(res, 200, csv(await query(`SELECT * FROM ${name}`)), 'text/csv; charset=utf-8');
    }
    const name = parts[0]; if (!TABLES[name] || parts.length > 2) throw new HttpError(404, 'ไม่พบตาราง');
    return send(res, 200, await tableApi(req, name, parts[1] || null, body));
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    console.error('API failure', error instanceof Error ? error.message : 'unknown error');
    return send(res, 500, { error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
  }
};
