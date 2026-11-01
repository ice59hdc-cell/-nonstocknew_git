// Runs the real handler and schema against a throwaway in-memory Postgres (PGlite).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => request === '@neondatabase/serverless'
    ? { neon: () => ({ query: async (text, params = []) => (await pg.query(text, params)).rows }) } : originalLoad(request, parent, isMain);
  process.env.DATABASE_URL = 'postgresql://test:test@example.invalid/test';
  process.env.UNIT_LOGIN_PASSWORD = '9600';
  const handler = require('../api/index.js');
  Module._load = originalLoad;

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pg.exec(schema); await pg.exec(schema); // must be safe to re-run

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('password1', salt, 64).toString('hex');
  await pg.query("INSERT INTO units(unit_id, unit_name, district) VALUES('A', 'หน่วย A', 'd1'), ('B', 'หน่วย B', 'd2')");
  await pg.query("INSERT INTO transactions(txn_id, unit_id, fiscal_year, month_no, \"disbursed_A\") VALUES('2569-01-A', 'A', 2569, 1, 10), ('2569-01-B', 'B', 2569, 1, 20)");
  await pg.query("INSERT INTO insights(id, title) VALUES('KI1', 'secret insight')");
  await pg.query('INSERT INTO kpi_targets(fiscal_year, green_min) VALUES(0, 1)');
  for (const [username, role, unit] of [['ua', 'unit', 'A'], ['admin', 'admin', null], ['view', 'viewer', null]]) {
    await pg.query('INSERT INTO users(username, pass_hash, salt, role, unit_id) VALUES($1, $2, $3, $4, $5)', [username, hash, salt, role, unit]);
  }

  function call(method, url, body, cookie) {
    const headers = {};
    return new Promise((resolve) => {
      const res = {
        setHeader: (name, value) => { headers[name] = value; },
        end: (text) => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers, text, json }); }
      };
      handler({ method, url, body: body ?? {}, headers: { cookie } }, res);
    });
  }
  async function login(unitId) {
    const r = await call('POST', '/api/login', { unit_id: unitId, password: '9600' });
    assert.equal(r.status, 200, unitId);
    return r.headers['Set-Cookie'].split(';')[0];
  }
  async function sessionFor(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await pg.query("INSERT INTO sessions(token_hash, username, expires_at) VALUES($1, $2, now() + interval '1 hour')", [hash, username]);
    return `sid=${token}`;
  }
  const check = async (label, status, ...args) => { const r = await call(...args); assert.equal(r.status, status, `${label}: ${r.text}`); return r; };
  const ua = await login('A'), admin = await sessionFor('admin'), view = await sessionFor('view');

  // accepted: a unit account has full CRUD on its own unit's records
  const list = await check('own list', 200, 'GET', '/api/transactions', null, ua);
  assert.deepEqual(list.json.map((t) => t.unit_id), ['A']);
  assert.equal((await check('own read', 200, 'GET', '/api/transactions/2569-01-A', null, ua)).json.unit_id, 'A');
  const made = await check('own create', 200, 'POST', '/api/transactions', { fiscal_year: 2569, month_no: 2, disbursed_A: 5, stock_B: 10, reserve_C: 999 }, ua);
  assert.equal(made.json.txn_id, '2569-02-A');
  assert.equal(made.json.reserve_C, 2, 'reserve C is calculated from B ÷ A');
  const updated = await check('own update', 200, 'PUT', '/api/transactions/2569-02-A', { disbursed_A: 7, stock_B: 21, reserve_C: 0 }, ua);
  assert.equal(updated.json.disbursed_A, 7);
  assert.equal(updated.json.reserve_C, 3, 'manual reserve C is ignored on update');
  await check('own delete', 200, 'DELETE', '/api/transactions/2569-02-A', null, ua);
  await check('kpi read', 200, 'GET', '/api/kpi_targets', null, ua);
  assert.deepEqual((await check('own unit', 200, 'GET', '/api/units', null, ua)).json.map((u) => u.unit_id), ['A']);

  // attacks: another unit's objects look like they do not exist, and stay unchanged
  await check('read other', 404, 'GET', '/api/transactions/2569-01-B', null, ua);
  await check('update other', 404, 'PUT', '/api/transactions/2569-01-B', { disbursed_A: 999 }, ua);
  await check('delete other', 404, 'DELETE', '/api/transactions/2569-01-B', null, ua);
  await check('read other unit', 404, 'GET', '/api/units/B', null, ua);
  await check('create for other', 403, 'POST', '/api/transactions', { unit_id: 'B', fiscal_year: 2569, month_no: 3 }, ua);
  await check('object as unit_id', 403, 'POST', '/api/transactions', { unit_id: { $ne: null }, fiscal_year: 2569, month_no: 3 }, ua);
  await check('sql in id', 404, 'GET', `/api/transactions/${encodeURIComponent("' OR '1'='1")}`, null, ua);
  await check('sql in id 2', 404, 'DELETE', `/api/transactions/${encodeURIComponent('x; DROP TABLE users--')}`, null, ua);
  const moved = await check('move own to other', 200, 'PUT', '/api/transactions/2569-01-A', { unit_id: 'B', recorded_at: '2000-01-01 00:00:00' }, ua);
  assert.equal(moved.json.unit_id, 'A'); assert.equal(moved.json.recorded_at, null);
  const other = (await pg.query("SELECT \"disbursed_A\" FROM transactions WHERE txn_id = '2569-01-B'")).rows[0];
  assert.equal(other.disbursed_A, 20);

  // attacks: tables outside the unit's scope
  for (const [method, url] of [['GET', '/api/insights'], ['GET', '/api/master_prompts'], ['GET', '/api/lessons'], ['GET', '/api/users'], ['POST', '/api/units'], ['PUT', '/api/units/A'], ['DELETE', '/api/units/A'], ['POST', '/api/kpi_targets'], ['GET', '/api/export/insights.csv']]) {
    await check(`${method} ${url}`, 403, method, url, { unit_name: 'x', district: 'x', fiscal_year: 9 }, ua);
  }
  for (const name of ['constructor', '__proto__', 'toString']) await check(`table ${name}`, 404, 'GET', `/api/${name}`, null, ua);
  const exported = await check('own csv', 200, 'GET', '/api/export/transactions.csv', null, ua);
  assert.match(exported.text, /2569-01-A/); assert.doesNotMatch(exported.text, /2569-01-B/);
  await check('no session', 401, 'GET', '/api/transactions');

  // admin can manage every unit's data without a unit restriction
  assert.equal((await check('admin list', 200, 'GET', '/api/transactions', null, admin)).json.length, 2);
  const adminMade = await check('admin create other unit', 200, 'POST', '/api/transactions', { unit_id: 'B', fiscal_year: 2569, month_no: 2, disbursed_A: 4, stock_B: 12 }, admin);
  assert.equal(adminMade.json.unit_id, 'B');
  assert.equal(adminMade.json.reserve_C, 3);
  assert.equal((await check('admin update other unit', 200, 'PUT', '/api/transactions/2569-02-B', { disbursed_A: 6, stock_B: 24 }, admin)).json.reserve_C, 4);
  await check('admin delete other unit', 200, 'DELETE', '/api/transactions/2569-02-B', null, admin);
  assert.equal((await check('viewer list', 200, 'GET', '/api/transactions', null, view)).json.length, 2);
  await check('viewer write', 403, 'POST', '/api/transactions', { unit_id: 'A', fiscal_year: 2569, month_no: 4 }, view);

  // account management: a unit account must be tied to a real unit
  const user = { username: 'unitb', role: 'unit', password: 'password1' };
  assert.match((await check('no unit', 400, 'POST', '/api/users', user, admin)).json.error, /เลือกหน่วยบริการ/);
  assert.match((await check('bogus unit', 400, 'POST', '/api/users', { ...user, unit_id: 'NOPE' }, admin)).json.error, /ไม่พบหน่วยบริการ/);
  assert.match((await check('object unit', 400, 'POST', '/api/users', { ...user, unit_id: { x: 1 } }, admin)).json.error, /เลือกหน่วยบริการ/);
  assert.equal((await check('create', 200, 'POST', '/api/users', { ...user, unit_id: 'B' }, admin)).json.unit_id, 'B');
  await assert.rejects(pg.query("UPDATE users SET unit_id = NULL WHERE username = 'unitb'"), 'a unit account cannot lose its unit');
  const ub = await sessionFor('unitb');
  assert.deepEqual((await check('ub list', 200, 'GET', '/api/transactions', null, ub)).json.map((t) => t.unit_id), ['B']);
  await check('reassign', 200, 'PUT', '/api/users/unitb', { unit_id: 'A' }, admin);
  await check('reassign ends sessions', 401, 'GET', '/api/transactions', null, ub);
  assert.equal((await check('to viewer clears unit', 200, 'PUT', '/api/users/unitb', { role: 'viewer' }, admin)).json.unit_id, null);
  await pg.query("UPDATE users SET role = 'unit', unit_id = 'A' WHERE username = 'unitb'");
  await check('referenced unit stays', 409, 'DELETE', '/api/units/A', null, admin);

  console.log('unit accounts: own-unit CRUD works; other units, tables and forged fields refused');
  await pg.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
