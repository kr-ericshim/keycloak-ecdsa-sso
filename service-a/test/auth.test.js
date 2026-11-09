import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { attachAuth, IndexedMemoryStore } from '../../shared/auth.js';
import { createOidc, LOGOUT_EVENT, safeReturnTo } from '../../shared/oidc.js';

// 네트워크 연결은 대체하고, 실제 ES256 서명 및 jose의 JWKS 검증은 그대로 실행한다.
function fixture(service) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { service, publicUrl: 'http://localhost:8080', internalUrl: 'http://keycloak:8080',
    realm: 'crypto-sso', baseUrl: `http://localhost:${service === 'A' ? 3001 : 3002}`,
    clientId: `service-${service.toLowerCase()}`, clientSecret: 'test-secret',
    sessionSecret: 'test-session-secret-at-least-32-characters', cookieName: `sid_${service.toLowerCase()}` };
  const issuer = `${config.publicUrl}/realms/crypto-sso`;
  const authTime = Math.floor(Date.now() / 1000) - 120;
  const state = { claims: {}, header: {}, requests: [], lastExchange: null };
  function jwt(claims, header = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT', ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${head}.${body}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  async function fetcher(input, options = {}) {
    const url = String(input);
    state.requests.push(url);
    assert.ok(url.startsWith(`${config.internalUrl}/`), '서버 통신은 내부 URL을 써야 한다.');
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer,
      authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/certs`, end_session_endpoint: `${issuer}/logout` });
    if (url.endsWith('/certs')) return json({ keys: [
      { ...publicKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'test-key', use: 'sig' },
    ] });
    if (url.endsWith('/token')) {
      state.lastExchange = options.body;
      const now = Math.floor(Date.now() / 1000);
      return json({ id_token: jwt({ iss: issuer, aud: config.clientId, azp: config.clientId,
        sub: 'alice-sub', sid: 'shared-keycloak-sid', iat: now, exp: now + 300,
        auth_time: authTime, nonce: state.nonce, preferred_username: 'alice',
        name: 'Alice Kim', email: 'alice@example.com', ...state.claims }, state.header) });
    }
    throw new Error(`알 수 없는 테스트 URL: ${url}`);
  }
  const oidc = createOidc(config, { fetcher });
  async function login(returnTo = '/') {
    const { pending, url } = await oidc.begin(returnTo);
    state.nonce = pending.nonce;
    const auth = await oidc.callback({ code: 'test-code', state: pending.state }, pending);
    return { auth, pending, url: new URL(url) };
  }
  return { config, state, oidc, login, authTime, jwt, issuer };
}

test('returnTo only accepts a local path', () => {
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/\r\nevil', ['/', '/bad']]) {
    assert.equal(safeReturnTo(bad), '/');
  }
  assert.equal(safeReturnTo('/?certificate=1'), '/?certificate=1');
});

for (const service of ['A', 'B']) {
  test(`${service}: discovery URL split, PKCE, verified ID token, auth_time, and RP logout`, async () => {
    const { config, state, oidc, login, authTime } = fixture(service);
    const { auth, pending, url } = await login('/?from=test');
    assert.equal(url.origin, config.publicUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    assert.equal(pending.returnTo, '/?from=test');
    assert.equal(state.lastExchange.get('client_secret'), config.clientSecret);
    assert.equal(state.lastExchange.get('redirect_uri'), `${config.baseUrl}/callback`);
    assert.equal(createHash('sha256').update(state.lastExchange.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(auth.claims.auth_time, authTime);
    assert.equal(auth.claims.sid, 'shared-keycloak-sid');
    assert.equal(auth.header.alg, 'ES256');
    const endSession = new URL(await oidc.logoutUrl(auth.idToken));
    assert.equal(endSession.origin, config.publicUrl);
    assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), `${config.baseUrl}/?loggedOut=1`);
    assert.equal(endSession.searchParams.get('id_token_hint'), auth.idToken);
    assert.equal(state.requests.filter(url => url.endsWith('/.well-known/openid-configuration')).length, 1);
  });

  test(`${service}: rejects state, nonce, audience, issuer, expiry, missing claims, and non-ES256`, async () => {
    const { state, oidc, login } = fixture(service);
    const { pending } = await oidc.begin('/');
    await assert.rejects(oidc.callback({ state: 'wrong', code: 'code' }, pending));
    await assert.rejects(oidc.callback({ state: pending.state, code: 'code' }, { ...pending, createdAt: Date.now() - 11 * 60_000 }));
    for (const claims of [{ nonce: 'wrong' }, { aud: 'other-client' }, { iss: 'http://wrong-issuer' },
      { exp: 1 }, { sid: null }, { auth_time: null }, { azp: 'other-client' }]) {
      state.claims = claims;
      await assert.rejects(login());
    }
    state.claims = {};
    state.header = { alg: 'RS256' };
    await assert.rejects(login());
  });

  test(`${service}: logout_token validates ES256, issuer, audience, events, sid, and no nonce`, async () => {
    const { oidc, jwt, issuer, config } = fixture(service);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: config.clientId, iat: now, jti: randomUUID(),
      sid: 'shared-keycloak-sid', events: { [LOGOUT_EVENT]: {} } };
    for (const invalid of [{ nonce: 'forbidden' }, { sid: undefined }, { events: {} },
      { aud: 'other-client' }, { iss: 'http://wrong' }, { iat: now - 600 }]) {
      await assert.rejects(oidc.verifyLogout(jwt({ ...claims, ...invalid })));
    }
    await assert.rejects(oidc.verifyLogout(jwt(claims, { alg: 'RS256' })));
    assert.equal(await oidc.verifyLogout(jwt(claims)), 'shared-keycloak-sid');
  });
}

test('MemoryStore removes every session with the same Keycloak sid and preserves other sids', async () => {
  const store = new IndexedMemoryStore();
  const set = promisify(store.set).bind(store), get = promisify(store.get).bind(store);
  for (const [id, sid] of [['a1', 'sso-1'], ['a2', 'sso-1'], ['a3', 'sso-2']]) {
    await set(id, { cookie: { expires: new Date(Date.now() + 60_000) }, auth: { claims: { sid } } });
  }
  assert.equal(store.sidIndex.get('sso-1').size, 2);
  await store.destroySid('sso-1');
  assert.equal(await get('a1'), undefined);
  assert.equal(await get('a2'), undefined);
  assert.ok(await get('a3'));
  assert.equal(store.sidIndex.has('sso-1'), false);
  await store.destroySid('sso-1');
});

test('/api/me returns the exact public shape and never includes the raw ID token', async () => {
  const { config, login, authTime } = fixture('A');
  const { auth } = await login();
  const routes = new Map();
  const app = { use() {}, get(path, ...handlers) { routes.set(path, handlers); }, post() {} };
  const { requireAuth } = attachAuth(app, config);
  const res = { clearCookie() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  requireAuth({ session: {} }, res, () => assert.fail('미인증 요청이 통과했습니다.'));
  assert.equal(res.code, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
  routes.get('/api/me').at(-1)({ session: { auth } }, res);
  assert.deepEqual(Object.keys(res.body).sort(), ['service', 'session', 'token', 'user']);
  assert.deepEqual(res.body.user, { sub: 'alice-sub', username: 'alice', name: 'Alice Kim', email: 'alice@example.com' });
  assert.equal(res.body.session.authTime, new Date(authTime * 1000).toISOString());
  assert.deepEqual(Object.keys(res.body.token).sort(), ['claims', 'header', 'signatureVerified']);
  assert.equal(res.body.token.signatureVerified, true);
  assert.equal(JSON.stringify(res.body).includes(auth.idToken), false);
});
