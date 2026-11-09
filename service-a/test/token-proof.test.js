import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { attachAuth } from '../../shared/auth.js';
import { createOidc } from '../../shared/oidc.js';
import { tokenProof } from '../../shared/token-proof.js';

function fixture(service = 'A') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { service, publicUrl: 'https://idp.example', internalUrl: 'http://keycloak:8080',
    realm: 'crypto-sso', baseUrl: 'http://localhost:3001', clientId: `service-${service.toLowerCase()}`,
    cookieName: `sid_${service}`, sessionSecret: 'test-session-secret-at-least-32-characters' };
  const issuer = `${config.publicUrl}/realms/crypto-sso`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'keycloak-es256-key', alg: 'ES256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: config.clientId, azp: config.clientId,
    sub: 'alice-sub', sid: 'keycloak-session', iat: now, exp: now + 300, auth_time: now - 100,
    nonce: 'login-nonce', preferred_username: 'alice', name: 'Alice Kim', email: 'alice@example.com' };
  const state = { keys: [jwk], requests: [] };
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const oidc = createOidc(config, { fetcher: async input => {
    const url = String(input);
    state.requests.push(url);
    assert.ok(url.startsWith(`${config.internalUrl}/`), 'JWKS와 discovery는 내부 URL을 써야 합니다.');
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer,
      authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${config.internalUrl}/realms/crypto-sso/certs`, end_session_endpoint: `${issuer}/logout` });
    if (url.endsWith('/certs')) return json({ keys: state.keys });
    assert.fail('예상하지 못한 OIDC 요청입니다.');
  } });
  function jwt(overrides = {}, header = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: jwk.kid, ...header })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url');
    const bytes = Buffer.from(`${head}.${payload}`, 'ascii');
    const signature = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${head}.${payload}.${signature}`;
  }
  return { config, issuer, jwk, claims, state, oidc, jwt };
}

function noTokenLeak(result, ...tokens) {
  const response = JSON.stringify(result);
  for (const token of tokens) {
    assert.equal(response.includes(token), false, '응답에 토큰 원문이 포함됐습니다.');
    for (const segment of token.split('.')) {
      assert.equal(response.includes(segment), false, '응답에 전체 base64url 조각이 포함됐습니다.');
    }
  }
}

test('ID token proof: generated ES256 JWT matches the exact contract and both verifiers', async () => {
  const { oidc, jwt, claims, jwk, config } = fixture();
  const token = jwt();
  const result = await tokenProof(token, oidc);
  assert.deepEqual(Object.keys(result).sort(), ['valid', 'tampered', 'segments', 'key', 'signature',
    'hash', 'math', 'checks', 'manualValid', 'libraryValid', 'expiresInSeconds'].sort());
  assert.equal(result.valid, true);
  assert.equal(result.tampered, null);
  assert.deepEqual(result.checks.map(check => check.key), ['alg', 'key', 'onCurve', 'ecdsa', 'claims']);
  assert.ok(result.checks.every(check => check.ok === true));
  assert.equal(result.manualValid, true);
  assert.equal(result.libraryValid, true);
  assert.equal(result.math.RxModN, result.signature.r);
  for (const value of [result.signature.r, result.signature.s, result.hash.e, result.key.Q.x, result.key.Q.y,
    result.math.w, result.math.u1, result.math.u2, result.math.R.x, result.math.R.y, result.math.RxModN]) {
    assert.match(value, /^[0-9a-f]{64}$/);
  }
  const parts = token.split('.');
  for (const [index, name] of ['header', 'payload', 'signature'].entries()) {
    assert.equal(result.segments[name].head, parts[index].slice(0, 12));
    assert.equal(result.segments[name].tail, parts[index].slice(-8));
    assert.equal(result.segments[name].length, parts[index].length);
  }
  assert.equal(Object.hasOwn(result.segments.signature, 'json'), false);
  assert.deepEqual(result.segments.payload.json, claims);
  assert.deepEqual(result.segments.header.json, { alg: 'ES256', typ: 'JWT', kid: jwk.kid });
  assert.equal(result.hash.signedBytes, parts[0].length + 1 + parts[1].length);
  assert.equal(result.hash.e, createHash('sha256').update(`${parts[0]}.${parts[1]}`, 'ascii').digest('hex'));
  assert.deepEqual(result.key, { kid: jwk.kid, alg: 'ES256', crv: 'P-256',
    jwksUrl: `${config.publicUrl}/realms/crypto-sso/certs`, Q: {
      x: Buffer.from(jwk.x, 'base64url').toString('hex'), y: Buffer.from(jwk.y, 'base64url').toString('hex'),
    } });
  assert.ok(result.expiresInSeconds > 295 && result.expiresInSeconds <= 300);
  noTokenLeak(result, token);
});

test('ID token proof: tampering changes only the payload and hash, failing both ECDSA verifiers', async () => {
  const { oidc, jwt } = fixture();
  const token = jwt(), original = await tokenProof(token, oidc);
  const tamper = { claim: 'preferred_username', value: 'alicf' };
  const result = await tokenProof(token, oidc, tamper);
  assert.equal(result.valid, false);
  assert.deepEqual(result.tampered, { claim: tamper.claim, from: 'alice', to: 'alicf' });
  assert.deepEqual(result.checks.map(check => check.ok), [true, true, true, false, true]);
  assert.equal(result.manualValid, false);
  assert.equal(result.libraryValid, false);
  assert.notEqual(result.hash.e, original.hash.e);
  assert.equal(result.segments.payload.json.preferred_username, 'alicf');
  assert.deepEqual(result.signature, original.signature);
  assert.deepEqual(result.segments.header, original.segments.header);
  assert.deepEqual(result.segments.signature, original.segments.signature);
  assert.match(result.math.R.x, /^[0-9a-f]{64}$/);
  assert.notEqual(result.math.RxModN, result.signature.r);
  assert.equal(original.segments.payload.json.preferred_username, 'alice');
  const changedPayload = Buffer.from(JSON.stringify(result.segments.payload.json)).toString('base64url');
  const parts = token.split('.');
  noTokenLeak(result, token, `${parts[0]}.${changedPayload}.${parts[2]}`);
});

test('ID token proof: a correctly signed wrong audience fails only claims', async () => {
  const { oidc, jwt } = fixture();
  const result = await tokenProof(jwt({ aud: 'another-service' }), oidc);
  assert.equal(result.valid, false);
  assert.deepEqual(result.checks.map(check => check.ok), [true, true, true, true, false]);
  assert.equal(result.manualValid, true);
  assert.equal(result.libraryValid, true);
});

test('ID token proof: accepts audience arrays; expiry is reported without affecting valid', async () => {
  const { oidc, jwt, config } = fixture();
  const result = await tokenProof(jwt({ aud: ['another-service', config.clientId], exp: 1 }), oidc);
  assert.equal(result.valid, true);
  assert.ok(result.expiresInSeconds < 0);
  const wrongIssuer = await tokenProof(jwt({ iss: 'https://wrong.example' }), oidc);
  assert.deepEqual(wrongIssuer.checks.map(check => check.ok), [true, true, true, true, false]);
});

test('OIDC proof key lookup shares a short cache and refetches once for rotated/unknown kid', async t => {
  const { oidc, jwk, state } = fixture();
  const requests = () => state.requests.filter(url => url.endsWith('/certs')).length;
  assert.deepEqual((await oidc.getJwk(jwk.kid)).jwk, jwk);
  await oidc.getJwk(jwk.kid);
  assert.equal(requests(), 1);
  state.keys = [{ ...jwk, kid: 'rotated-key' }];
  assert.equal((await oidc.getJwk('rotated-key')).jwk.kid, 'rotated-key');
  assert.equal(requests(), 2);
  assert.equal((await oidc.getJwk('unknown-key')).jwk, null);
  assert.equal(requests(), 3);
  const later = Date.now() + 60_001;
  t.mock.method(Date, 'now', () => later);
  await oidc.getJwk('rotated-key');
  assert.equal(requests(), 4);
});

test('ID token proof: algorithm, key type/curve, and on-curve checks gate validity', async () => {
  const { oidc, jwt, jwk, config } = fixture();
  const wrongAlg = await tokenProof(jwt({}, { alg: 'RS256' }), oidc);
  assert.equal(wrongAlg.valid, false);
  assert.equal(wrongAlg.checks[0].ok, false);
  const token = jwt();
  for (const key of [{ ...jwk, kty: 'RSA' }, { ...jwk, crv: 'P-384' }, null]) {
    const result = await tokenProof(token, { ...oidc, getJwk: async () => ({ jwk: key, jwksUrl: config.publicUrl }) });
    assert.equal(result.valid, false);
    assert.equal(result.checks[1].ok, false);
    assert.equal(result.checks[2].ok, null);
    assert.equal(result.checks[3].ok, null);
  }
  const offCurve = { ...jwk, x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') };
  const result = await tokenProof(token, { ...oidc, getJwk: async () => ({ jwk: offCurve }) });
  assert.equal(result.checks[1].ok, true);
  assert.equal(result.checks[2].ok, false);
  assert.equal(result.valid, false);
});

test('ID token proof: malformed and out-of-range signatures fail without leaking input', async () => {
  const { oidc, jwt } = fixture();
  const [head, payload] = jwt().split('.');
  for (const signature of ['!', Buffer.alloc(63).toString('base64url'), Buffer.alloc(64).toString('base64url')]) {
    const result = await tokenProof(`${head}.${payload}.${signature}`, oidc);
    assert.equal(result.valid, false);
    assert.equal(result.checks[3].ok, false);
    assert.equal(result.math.w, null);
  }
  for (const token of ['not-a-jwt', 'eyJhbGciOiJFUzI1NiJ9.bm90LWpzb24.signature']) {
    await assert.rejects(tokenProof(token, oidc), error => !error.message.includes(token));
  }
});

function routeFixture(service) {
  const f = fixture(service), routes = new Map();
  const app = { use() {}, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); } };
  attachAuth(app, f.config, { oidc: f.oidc });
  const auth = { idToken: f.jwt(), claims: f.claims };
  async function call(method, { sessionAuth = auth, body, contentType = 'application/json' } = {}) {
    const req = { body, session: { auth: sessionAuth, destroy() {} }, is: type => type === contentType };
    const res = { code: 200, clearCookie() {}, status(code) { this.code = code; return this; },
      json(value) { this.body = value; return this; } };
    for (const handler of routes.get(`${method} /api/token-proof`)) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  }
  return { ...f, auth, call };
}

for (const service of ['A', 'B']) {
  test(`${service}: authenticated GET/POST token-proof returns service, math, and safe segments`, async () => {
    const { call, auth } = routeFixture(service);
    const get = await call('GET');
    assert.equal(get.code, 200);
    assert.equal(get.body.service, service);
    assert.equal(get.body.valid, true);
    noTokenLeak(get.body, auth.idToken);
    for (const claim of ['preferred_username', 'name', 'email', 'sub']) {
      const post = await call('POST', { body: { tamper: { claim, value: '다른 값' } } });
      assert.equal(post.code, 200);
      assert.equal(post.body.service, service);
      assert.equal(post.body.valid, false);
      assert.equal(post.body.checks[3].ok, false);
      assert.equal(post.body.segments.payload.json[claim], '다른 값');
      noTokenLeak(post.body, auth.idToken);
    }
    for (const value of ['x', 'x'.repeat(200)]) {
      assert.equal((await call('POST', { body: { tamper: { claim: 'name', value } } })).code, 200);
    }
    assert.equal(auth.claims.preferred_username, 'alice');
  });

  test(`${service}: token-proof requires login/raw ID token and validates JSON tampering`, async () => {
    const { call, auth, state } = routeFixture(service);
    for (const method of ['GET', 'POST']) {
      for (const sessionAuth of [null, { ...auth, idToken: undefined }, { ...auth, idToken: '' },
        { ...auth, claims: { ...auth.claims, exp: 1 } }]) {
        const result = await call(method, { sessionAuth });
        assert.equal(result.code, 401);
        assert.deepEqual(result.body, { error: 'unauthenticated' });
      }
    }
    for (const body of [undefined, null, [], {}, { tamper: null }, { tamper: {} },
      ...['iss', 'aud', 'exp', '__proto__'].map(claim => ({ tamper: { claim, value: 'x' } })),
      ...['', 'x'.repeat(201), 1, null, [], {}].map(value => ({ tamper: { claim: 'name', value } }))]) {
      const result = await call('POST', { body });
      assert.equal(result.code, 400);
      assert.equal(result.body.error, 'bad_request');
    }
    assert.equal((await call('POST', { body: { tamper: { claim: 'name', value: 'x' } },
      contentType: 'application/x-www-form-urlencoded' })).code, 400);
    assert.equal(state.requests.length, 0);
  });
}
