import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachRoutes } from '../src/routes.js';
import { loadIssuer } from '../src/crypto.js';

test('certificate routes persist, isolate users, return newest first, and validate input', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'crypto-sso-routes-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const routes = new Map();
  const app = { use() {}, get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); } };
  attachRoutes(app, { dataDir }, () => {}, loadIssuer(dataDir));
  function call(route, sub, body, params = {}) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    routes.get(route)({ body, params, session: { auth: { claims: { sub, preferred_username: sub } } } }, res);
    return res;
  }
  const fields = { type: '수료증', title: '첫 번째', recipientName: '홍길동' };
  const first = call('POST /api/certificates', 'alice', fields);
  assert.equal(first.code, 201);
  const id = first.body.certificate.payload.id;
  const second = call('POST /api/certificates', 'alice', { ...fields, title: '두 번째' });
  call('POST /api/certificates', 'bob', fields);
  assert.deepEqual(call('GET /api/certificates', 'alice').body.items.map(c => c.payload.id), [second.body.certificate.payload.id, id]);
  assert.equal(call('GET /api/certificates', 'bob').body.items.length, 1);
  assert.equal(call('GET /api/certificates/:id', 'bob', undefined, { id }).code, 404);
  assert.equal(call('GET /api/certificates/:id', 'alice', undefined, { id }).body.certificate.payload.id, id);
  assert.equal(call('POST /api/certificates', 'alice', { ...fields, title: [] }).code, 400);
});
