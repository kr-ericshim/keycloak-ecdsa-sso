import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as appA } from '../src/app.js';
import { createApp as appB } from '../../service-b/src/app.js';
import { IndexedMemoryStore } from '../../shared/auth.js';
import { LOGOUT_EVENT, safeReturnTo } from '../../shared/oidc.js';

const listen = appOrServer => new Promise(resolve => {
  const server = appOrServer.listen(0, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => server.close(resolve));
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

async function setup(t, service, makeApp) {
  const directory = mkdtempSync(join(tmpdir(), 'crypto-sso-http-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicUrl = 'http://keycloak.test.invalid';
  const issuer = `${publicUrl}/realms/crypto-sso`;
  const authTime = Math.floor(Date.now() / 1000) - 120;
  const state = { claims: {}, header: {}, lastExchange: null };
  function jwt(claims, header = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT', ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${head}.${body}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  const idp = await listen(createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/.well-known/openid-configuration')) {
      return res.end(JSON.stringify({ issuer,
        authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/certs`, end_session_endpoint: `${issuer}/logout` }));
    }
    if (req.url.endsWith('/certs')) return res.end(JSON.stringify({ keys: [
      { ...publicKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'test-key', use: 'sig' },
    ] }));
    if (req.url.endsWith('/token')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      state.lastExchange = new URLSearchParams(body);
      const now = Math.floor(Date.now() / 1000);
      return res.end(JSON.stringify({ id_token: jwt({ iss: issuer, aud: `service-${service.toLowerCase()}`,
        azp: `service-${service.toLowerCase()}`, sub: 'alice-sub', sid: 'shared-keycloak-sid',
        iat: now, exp: now + 300, auth_time: authTime, nonce: state.nonce,
        preferred_username: 'alice', name: 'Alice Kim', email: 'alice@example.com', ...state.claims }, state.header) }));
    }
    res.statusCode = 404;
    res.end('{}');
  }));
  const config = { service, publicUrl, internalUrl: `http://127.0.0.1:${idp.address().port}`, realm: 'crypto-sso',
    baseUrl: 'http://localhost:3001', clientId: `service-${service.toLowerCase()}`, clientSecret: 'test-secret',
    sessionSecret: 'test-session-secret-at-least-32-characters', cookieName: `sid_${service.toLowerCase()}`,
    dataDir: directory, publicDir: join(directory, 'public'), issuerKeyUrl: 'http://127.0.0.1:1/api/issuer-key' };
  const store = new IndexedMemoryStore();
  const server = await listen(makeApp(config, { store }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await close(server); await close(idp); rmSync(directory, { recursive: true, force: true }); });
  async function login(returnTo = '/') {
    const start = await fetch(`${base}/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('location'));
    assert.equal(url.origin, publicUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    state.nonce = url.searchParams.get('nonce');
    const response = await fetch(`${base}/callback?${new URLSearchParams({
      code: 'test-code', state: url.searchParams.get('state'),
    })}`, { redirect: 'manual', headers: { cookie: cookieOf(start) } });
    return { response, cookie: cookieOf(response), start, url };
  }
  return { base, store, config, state, login, authTime, jwt, issuer };
}

test('returnTo only accepts a local path', () => {
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/\r\nevil', ['/', '/bad']]) {
    assert.equal(safeReturnTo(bad), '/');
  }
  assert.equal(safeReturnTo('/?certificate=1'), '/?certificate=1');
});

for (const [service, makeApp] of [['A', appA], ['B', appB]]) {
  test(`${service}: discovery URL split, PKCE, verified session, and RP logout`, async t => {
    const { base, config, state, login, authTime } = await setup(t, service, makeApp);
    const anonymous = await fetch(`${base}/api/me`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: 'unauthenticated' });
    const { response, cookie, start, url } = await login('/?from=test');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?from=test');
    assert.notEqual(cookie, cookieOf(start));
    assert.ok(cookie.startsWith(`${config.cookieName}=`));
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal(state.lastExchange.get('client_secret'), 'test-secret');
    assert.equal(state.lastExchange.get('redirect_uri'), `${config.baseUrl}/callback`);
    assert.equal(createHash('sha256').update(state.lastExchange.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    const meResponse = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.service, service);
    assert.deepEqual(me.user, { sub: 'alice-sub', username: 'alice', name: 'Alice Kim', email: 'alice@example.com' });
    assert.equal(me.session.authTime, new Date(authTime * 1000).toISOString());
    assert.equal(me.token.header.alg, 'ES256');
    assert.equal(me.token.signatureVerified, true);
    assert.deepEqual(Object.keys(me.token).sort(), ['claims', 'header', 'signatureVerified']);
    const logout = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.equal(logout.status, 302);
    const endSession = new URL(logout.headers.get('location'));
    assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), `${config.baseUrl}/?loggedOut=1`);
    assert.ok(endSession.searchParams.get('id_token_hint'));
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
  });

  test(`${service}: reject bad state/nonce/audience/algorithm and accept no unverified session`, async t => {
    const { base, state, login } = await setup(t, service, makeApp);
    const badState = await fetch(`${base}/callback?state=wrong&code=code`, { redirect: 'manual' });
    assert.equal(badState.status, 400);
    for (const claims of [{ nonce: 'wrong' }, { aud: 'other-client' }, { iss: 'http://wrong-issuer' },
      { exp: 1 }, { sid: null }, { auth_time: null }]) {
      state.claims = claims;
      const { response } = await login();
      assert.equal(response.status, 400);
    }
    state.claims = {};
    state.header = { alg: 'RS256' };
    assert.equal((await login()).response.status, 400);
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
  });

  test(`${service}: valid backchannel token destroys ALL same-sid sessions, rejects invalid tokens`, async t => {
    const { base, store, login, jwt, issuer, config } = await setup(t, service, makeApp);
    const first = await login(), second = await login();
    assert.equal(store.sidIndex.get('shared-keycloak-sid').size, 2);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: config.clientId, iat: now, jti: randomUUID(),
      sid: 'shared-keycloak-sid', events: { [LOGOUT_EVENT]: {} } };
    async function send(token) {
      return fetch(`${base}/backchannel-logout`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }) });
    }
    for (const invalid of [{ nonce: 'forbidden' }, { sid: undefined }, { events: {} },
      { aud: 'other-client' }, { iss: 'http://wrong' }, { iat: now - 600 }]) {
      assert.equal((await send(jwt({ ...claims, ...invalid }))).status, 400);
    }
    assert.equal((await send(jwt(claims, { alg: 'RS256' }))).status, 400);
    assert.equal(store.sidIndex.get('shared-keycloak-sid').size, 2);
    assert.equal((await send(jwt(claims))).status, 200);
    assert.equal(store.sidIndex.has('shared-keycloak-sid'), false);
    for (const session of [first, second]) assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: session.cookie } })).status, 401);
    // 같은 logout_token 재전송도 성공으로 응답한다. 세션 삭제는 멱등적이다.
    assert.equal((await send(jwt(claims))).status, 200);
  });
}
