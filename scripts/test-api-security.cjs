const assert = require('node:assert/strict');
const Module = require('node:module');
const queries = [];
const fakeNeon = () => ({
  query: async (text, params) => {
    queries.push({ text, params });
    if (text.includes('FROM sessions s JOIN users')) return [{ username: 'admin', role: 'admin' }];
    if (text === 'SELECT * FROM units') return [{ unit_id: 'U1', unit_name: 'Valid', district: 'D' }];
    return [];
  }
});
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === '@neondatabase/serverless'
  ? { neon: fakeNeon } : originalLoad(request, parent, isMain);
process.env.DATABASE_URL = 'postgresql://test:test@example.invalid/test';
const handler = require('../api/[...path].js');
Module._load = originalLoad;

function request(url) {
  const headers = {};
  return new Promise((resolve) => {
    const res = {
      setHeader: (name, value) => { headers[name] = value; },
      end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) })
    };
    handler({ method: 'GET', url, body: {}, headers: { cookie: `sid=${'a'.repeat(64)}` } }, res);
  });
}

(async () => {
  const attack = await request('/api/units%3BDROP%20TABLE%20users--');
  assert.equal(attack.status, 404);
  assert.equal(queries.length, 1, 'unallowlisted route must never form a table query');
  assert.match(queries[0].text, /sessions/);
  queries.length = 0;
  const valid = await request('/api/units');
  assert.equal(valid.status, 200);
  assert.equal(valid.body[0].unit_id, 'U1');
  assert.equal(queries.at(-1).text, 'SELECT * FROM units');
  console.log('SQL route attack rejected; allowlisted units request accepted');
})().catch((error) => { console.error(error); process.exitCode = 1; });
