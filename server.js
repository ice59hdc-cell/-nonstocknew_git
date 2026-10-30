// Dashboard server: static files + JSON CRUD API over SQLite (node:sqlite, no dependencies)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// Master prompt templates (placeholders like {{ประเด็นสำคัญ}} are filled by the dashboard). Seeded once, when the table is created.
const DEFAULT_PROMPT = `# บทบาท
คุณเป็นที่ปรึกษาด้านระบบยาและเวชภัณฑ์ ช่วยเขียนสรุปให้ผู้บริหารสำนักงานสาธารณสุขจังหวัด

# งานที่ต้องทำ
เขียนสรุปผู้บริหารความยาวไม่เกิน 1 หน้า A4 โดยใช้ข้อมูลด้านล่างเท่านั้น ห้ามเดาหรือเพิ่มตัวเลขที่ไม่มีในข้อมูล หากข้อมูลไม่พอให้ระบุว่า "ไม่มีข้อมูล"

# ขอบเขตข้อมูล
{{ขอบเขต}}

# เกณฑ์ KPI
{{เกณฑ์ KPI}}

# ตัวชี้วัดหลัก
{{ตัวชี้วัดหลัก}}

# ประเด็นสำคัญที่ระบบสรุปไว้
{{ประเด็นสำคัญ}}

# อันดับอำเภอ (% หน่วยที่อยู่ในเกณฑ์)
{{อันดับอำเภอ}}

# หน่วยที่ต้องติดตาม
{{หน่วยที่ต้องติดตาม}}

# หน่วยที่ยังไม่รายงาน
{{หน่วยที่ยังไม่รายงาน}}

# Key Insights ที่บันทึกไว้
{{Key Insights}}

# รูปแบบผลลัพธ์
1. หัวข้อสรุป 1–2 ประโยค (บอกสถานการณ์โดยรวมและระดับความน่าเป็นห่วง)
2. ตัวเลขสำคัญ 3–5 ตัว พร้อมเทียบช่วงก่อนหน้าถ้ามี
3. ประเด็นที่ต้องตัดสินใจหรือติดตาม 3–5 ข้อ เรียงตามความเร่งด่วน
4. ข้อเสนอแนะ แยกเป็น เร่งด่วน (ภายใน 1 เดือน) และระยะกลาง
5. ข้อจำกัดของข้อมูล เช่น อัตราการรายงาน
ใช้ภาษาไทยทางการ กระชับ ไม่ใช้อีโมจิ`;
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'master_prompts'").get()) {
  db.exec(`CREATE TABLE master_prompts(id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, purpose TEXT, prompt TEXT NOT NULL, tags TEXT, status TEXT, created_at TEXT, updated_at TEXT)`);
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO master_prompts VALUES(?,?,?,?,?,?,?,?,?)').run('MPdefault0001', 'สรุปผู้บริหาร: คลังยาและเวชภัณฑ์', 'สรุปผู้บริหาร', 'สร้างบทสรุปผู้บริหารหนึ่งหน้าจากข้อมูลบนหน้าสรุปผู้บริหาร', DEFAULT_PROMPT, 'executive,summary', 'ใช้งาน', t, t);
}

// Whitelisted tables: primary key + editable columns
const TABLES = {
  units: { pk: 'unit_id', cols: ['unit_id', 'unit_name', 'district', 'affiliation', 'active', 'note'], required: ['unit_id', 'unit_name', 'district'] },
  transactions: { pk: 'txn_id', cols: ['txn_id', 'unit_id', 'fiscal_year', 'month_no', 'calendar_year', 'month_name', 'disbursed_A', 'stock_B', 'reserve_C', 'source', 'note', 'recorded_at', 'updated_at'], required: ['unit_id', 'fiscal_year', 'month_no'], stamps: true },
  insights: { pk: 'id', cols: ['id', 'title', 'source', 'insight', 'action', 'priority', 'status', 'created_at', 'updated_at'], required: ['title'], prefix: 'KI', stamps: true },
  lessons: { pk: 'id', cols: ['id', 'unit_id', 'fiscal_year', 'month_no', 'problem', 'obstacle', 'solution', 'status', 'created_at', 'updated_at'], required: ['problem'], prefix: 'LL', stamps: true },
  master_prompts: { pk: 'id', cols: ['id', 'title', 'category', 'purpose', 'prompt', 'tags', 'status', 'created_at', 'updated_at'], required: ['title', 'prompt'], prefix: 'MP', stamps: true },
  kpi_targets: { pk: 'fiscal_year', cols: ['fiscal_year', 'green_min', 'green_max', 'warn_low', 'warn_high', 'note'], required: ['fiscal_year'] },
};
const MONTHS = ['ตุลาคม', 'พฤศจิกายน', 'ธันวาคม', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน'];
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---- auth: users table (scrypt hashes), in-memory sessions via HttpOnly cookie ----
db.exec(`CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer')`);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function setUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?,?)').run(username, hashPw(password, salt), salt, role);
}
if (!db.prepare('SELECT 1 FROM users').get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  setUser('admin', pw, 'admin');
  console.log(`สร้างผู้ใช้เริ่มต้น  username: admin  password: ${pw}  (เปลี่ยนด้วย: node adduser.js admin <รหัสผ่านใหม่> admin)`);
}
const sessions = new Map(); // token -> { username, role, exp }
const SESSION_MS = 8 * 3600e3;
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
function sessionOf(req) {
  const s = sessions.get(cookieOf(req).sid);
  if (!s || s.exp < Date.now()) return null;
  return s;
}
const attempts = new Map(); // ip -> { n, until } simple brute-force throttle
function login(req, body, res) {
  const ip = req.socket.remoteAddress, a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอสักครู่');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username || ''));
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(String(body.password || ''), u.salt), 'hex'), Buffer.from(u.pass_hash, 'hex'));
  if (!ok) { a.n++; if (a.n >= 5) { a.until = Date.now() + 60e3; a.n = 0; } attempts.set(ip, a); throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); }
  attempts.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: u.username, role: u.role, exp: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  return { username: u.username, role: u.role };
}

// ---- CSV export (UTF-8 with BOM so Excel reads Thai correctly) ----
function toCsv(rows) {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const cell = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function pick(t, body) {
  const out = {};
  for (const c of t.cols) if (body[c] !== undefined) out[c] = body[c] === '' ? null : body[c];
  return out;
}

function prepare(name, row, isNew) {
  const t = TABLES[name];
  for (const r of t.required) if (row[r] == null || row[r] === '') throw new HttpError(400, `ต้องระบุ ${r}`);
  if (name === 'transactions') {
    row.fiscal_year = +row.fiscal_year; row.month_no = +row.month_no;
    if (!(row.month_no >= 1 && row.month_no <= 12)) throw new HttpError(400, 'month_no ต้องอยู่ระหว่าง 1-12');
    for (const k of ['disbursed_A', 'stock_B', 'reserve_C']) if (row[k] != null) {
      row[k] = +row[k];
      if (!Number.isFinite(row[k]) || row[k] < 0) throw new HttpError(400, `${k} ต้องเป็นตัวเลขไม่ติดลบ`);
    }
    // fiscal year starts in October of (fiscal_year - 1); months 1-3 fall in the previous calendar year
    row.calendar_year = row.month_no <= 3 ? row.fiscal_year - 1 : row.fiscal_year;
    row.month_name = MONTHS[row.month_no - 1];
    if (isNew) row.txn_id = `${row.fiscal_year}-${String(row.month_no).padStart(2, '0')}-${row.unit_id}`;
    row.source = row.source || 'web';
  }
  if (t.stamps) {
    if (isNew) row[name === 'transactions' ? 'recorded_at' : 'created_at'] = now();
    row.updated_at = now();
  }
  return row;
}

// ---- user management (admin only). Password hashes never leave the server. ----
function handleUsers(req, url, body, sess) {
  if (sess.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ');
  const raw = url.pathname.split('/')[3];
  const name = raw ? decodeURIComponent(raw) : null;
  const adminCount = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  const dropSessions = u => { for (const [t, s] of sessions) if (s.username === u) sessions.delete(t); };
  const pub = u => db.prepare('SELECT username, role FROM users WHERE username = ?').get(u);
  const checkRole = r => { if (!['admin', 'viewer'].includes(r)) throw new HttpError(400, 'role ต้องเป็น admin หรือ viewer'); };
  const checkPw = p => { if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); };

  if (req.method === 'GET' && !name) return db.prepare('SELECT username, role FROM users ORDER BY username').all();
  if (req.method === 'POST' && !name) {
    const u = String(body.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u)) throw new HttpError(400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 _ . - ความยาว 3–32 ตัว');
    checkRole(body.role); checkPw(body.password);
    if (pub(u)) throw new HttpError(409, `มีผู้ใช้ ${u} อยู่แล้ว`);
    setUser(u, body.password, body.role);
    return pub(u);
  }
  if (req.method === 'PUT' && name) {
    const cur = pub(name);
    if (!cur) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const role = body.role ?? cur.role;
    checkRole(role);
    if (cur.role === 'admin' && role !== 'admin' && adminCount() <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
    if (body.password) {
      checkPw(body.password);
      setUser(name, body.password, role);
    } else {
      db.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, name);
    }
    if (body.password || role !== cur.role) dropSessions(name); // force re-login with the new credentials/role
    return pub(name);
  }
  if (req.method === 'DELETE' && name) {
    const cur = pub(name);
    if (!cur) throw new HttpError(404, 'ไม่พบผู้ใช้');
    if (name === sess.username) throw new HttpError(400, 'ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้');
    if (cur.role === 'admin' && adminCount() <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
    db.prepare('DELETE FROM users WHERE username = ?').run(name);
    dropSessions(name);
    return { deleted: name };
  }
  throw new HttpError(405, 'method ไม่รองรับ');
}

const getOne = (name, id) => db.prepare(`SELECT * FROM ${name} WHERE ${TABLES[name].pk} = ?`).get(id);

function handleApi(req, url, body) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const name = parts[0];
  const t = TABLES[name];
  if (!t) throw new HttpError(404, 'ไม่พบตาราง');
  const id = parts[1] != null ? decodeURIComponent(parts[1]) : null;

  if (req.method === 'GET' && id == null) return db.prepare(`SELECT * FROM ${name}`).all();
  if (req.method === 'GET') {
    const r = getOne(name, id);
    if (!r) throw new HttpError(404, 'ไม่พบข้อมูล');
    return r;
  }
  if (req.method === 'POST' && id == null) {
    const row = pick(t, body);
    if (t.prefix && !row[t.pk]) row[t.pk] = t.prefix + crypto.randomBytes(6).toString('hex');
    prepare(name, row, true);
    if (row[t.pk] == null || row[t.pk] === '') throw new HttpError(400, `ต้องระบุ ${t.pk}`);
    if (getOne(name, row[t.pk])) throw new HttpError(409, `มี ${row[t.pk]} อยู่แล้ว`);
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${name}(${cols}) VALUES(${cols.map(() => '?')})`).run(...cols.map(c => row[c]));
    return getOne(name, row[t.pk]);
  }
  if (req.method === 'PUT' && id != null) {
    const cur = getOne(name, id);
    if (!cur) throw new HttpError(404, 'ไม่พบข้อมูล');
    const row = { ...cur, ...pick(t, body) };
    row[t.pk] = cur[t.pk]; // primary key is immutable
    if (name === 'transactions') { row.unit_id = cur.unit_id; row.fiscal_year = cur.fiscal_year; row.month_no = cur.month_no; }
    prepare(name, row, false);
    const cols = t.cols.filter(c => c !== t.pk);
    db.prepare(`UPDATE ${name} SET ${cols.map(c => c + ' = ?')} WHERE ${t.pk} = ?`).run(...cols.map(c => row[c] ?? null), id);
    return getOne(name, id);
  }
  if (req.method === 'DELETE' && id != null) {
    const r = db.prepare(`DELETE FROM ${name} WHERE ${t.pk} = ?`).run(id);
    if (!r.changes) throw new HttpError(404, 'ไม่พบข้อมูล');
    return { deleted: id };
  }
  throw new HttpError(405, 'method ไม่รองรับ');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, 'public');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, data, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const route = url.pathname;
        if (route === '/api/login' && req.method === 'POST') return send(200, login(req, body, res));
        if (route === '/api/logout' && req.method === 'POST') {
          sessions.delete(cookieOf(req).sid);
          res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(200, { ok: true });
        }
        const sess = sessionOf(req);
        if (route === '/api/me') return sess ? send(200, { username: sess.username, role: sess.role }) : send(401, { error: 'ยังไม่ได้เข้าสู่ระบบ' });
        if (!sess) return send(401, { error: 'ยังไม่ได้เข้าสู่ระบบ' });
        if (route === '/api/users' || route.startsWith('/api/users/')) return send(200, handleUsers(req, url, body, sess));
        if (req.method !== 'GET' && sess.role !== 'admin') return send(403, { error: 'บัญชีนี้ดูข้อมูลได้อย่างเดียว' });
        const ex = route.match(/^\/api\/export\/(\w+)\.csv$/);
        if (ex) {
          if (!TABLES[ex[1]]) throw new HttpError(404, 'ไม่พบตาราง');
          res.setHeader('Content-Disposition', `attachment; filename="${ex[1]}.csv"`);
          return send(200, toCsv(db.prepare(`SELECT * FROM ${ex[1]}`).all()), 'text/csv; charset=utf-8');
        }
        send(200, handleApi(req, url, body));
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        if (/FOREIGN KEY/.test(e.message)) return send(409, { error: 'ข้อมูลถูกอ้างอิงอยู่ หรืออ้างอิงรหัสที่ไม่มีอยู่' });
        if (e instanceof SyntaxError) return send(400, { error: 'JSON ไม่ถูกต้อง' });
        console.error(e);
        send(500, { error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
      }
    });
    return;
  }
  const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'Not found', 'text/plain');
  send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`Dashboard: http://localhost:${PORT}`));
