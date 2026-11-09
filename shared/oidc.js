import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\x00-\x20\x7f]/.test(value) ? value : '/';
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createOidc(config, { fetcher = globalThis.fetch } = {}) {
  const issuer = `${config.publicUrl}/realms/${encodeURIComponent(config.realm)}`;
  const redirectUri = `${config.baseUrl}/callback`;
  // 1코어 서버에서 Keycloak 이 첫 요청을 처리할 때 5초를 넘길 수 있어 기본 15초로 둔다.
  const timeoutMs = config.oidcTimeoutMs || 15_000;
  let discoveryPromise;
  let jwks;

  // issuer는 공개 주소로 고정한다. HTTP 연결만 Docker 내부 주소로 바꾼다.
  function serverUrl(endpoint) {
    if (endpoint.startsWith(`${config.publicUrl}/`)) {
      return `${config.internalUrl}${endpoint.slice(config.publicUrl.length)}`;
    }
    if (endpoint.startsWith(`${config.internalUrl}/`)) return endpoint;
    throw new Error('발견 문서의 서버 주소가 Keycloak 주소와 다릅니다.');
  }

  function browserUrl(endpoint) {
    if (endpoint.startsWith(`${config.internalUrl}/`)) {
      return `${config.publicUrl}${endpoint.slice(config.internalUrl.length)}`;
    }
    if (endpoint.startsWith(`${config.publicUrl}/`)) return endpoint;
    throw new Error('발견 문서의 브라우저 주소가 Keycloak 주소와 다릅니다.');
  }

  async function discover() {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        const response = await fetcher(serverUrl(`${issuer}/.well-known/openid-configuration`), {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('Keycloak discovery에 실패했습니다.');
        const metadata = await response.json();
        if (metadata.issuer !== issuer) throw new Error('Keycloak issuer가 일치하지 않습니다.');
        for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint']) {
          if (typeof metadata[name] !== 'string') throw new Error(`발견 문서에 ${name}가 없습니다.`);
        }
        jwks = createRemoteJWKSet(new URL(serverUrl(metadata.jwks_uri)), {
          timeoutDuration: timeoutMs, cacheMaxAge: 60_000, [customFetch]: fetcher,
        });
        return metadata;
      })().catch(error => { discoveryPromise = undefined; throw error; });
    }
    return discoveryPromise;
  }

  // 로그인 검증과 같은 JWKS 캐시를 쓴다. 키 교체 시 모르는 kid는 한 번만 재조회한다.
  async function getJwk(kid) {
    const metadata = await discover();
    const jwksUrl = browserUrl(metadata.jwks_uri);
    if (typeof kid !== 'string' || !kid) return { jwk: null, jwksUrl };
    if (!jwks.fresh) await jwks.reload();
    let jwk = jwks.jwks().keys.find(key => key.kid === kid);
    if (!jwk) {
      await jwks.reload();
      jwk = jwks.jwks().keys.find(key => key.kid === kid);
    }
    return { jwk: jwk ?? null, jwksUrl };
  }

  async function begin(returnTo) {
    const metadata = await discover();
    const pending = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      returnTo: safeReturnTo(returnTo),
      createdAt: Date.now(),
    };
    const url = new URL(browserUrl(metadata.authorization_endpoint));
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid profile email', state: pending.state, nonce: pending.nonce,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { pending, url: url.toString() };
  }

  async function callback(query, pending) {
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000
      || !equalSecret(query.state, pending.state) || typeof query.code !== 'string' || query.error
      || (query.iss !== undefined && query.iss !== issuer)) {
      throw new Error('로그인 요청의 state 또는 유효 시간이 올바르지 않습니다.');
    }
    const metadata = await discover();
    const response = await fetcher(serverUrl(metadata.token_endpoint), {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code,
        client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: redirectUri, code_verifier: pending.verifier }),
    });
    if (!response.ok) throw new Error('인증 코드를 교환하지 못했습니다.');
    const tokens = await response.json();
    if (typeof tokens.id_token !== 'string') throw new Error('ID 토큰이 없습니다.');
    const { payload: claims, protectedHeader: header } = await jwtVerify(tokens.id_token, jwks, {
      issuer, audience: config.clientId, algorithms: ['ES256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'sid', 'auth_time'],
    });
    if (!equalSecret(claims.nonce, pending.nonce)
      || (claims.azp !== undefined && claims.azp !== config.clientId)
      || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId)
      || typeof claims.sid !== 'string' || !claims.sid || typeof claims.sub !== 'string' || !claims.sub
      || !Number.isFinite(claims.auth_time) || claims.auth_time < 0
      || claims.auth_time > Date.now() / 1000 + 5
      || !Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 5) {
      throw new Error('ID 토큰의 nonce 또는 사용자/세션 클레임이 올바르지 않습니다.');
    }
    return { idToken: tokens.id_token, claims, header, loginAt: new Date().toISOString() };
  }

  async function logoutUrl(idToken) {
    const metadata = await discover();
    const url = new URL(browserUrl(metadata.end_session_endpoint));
    url.searchParams.set('client_id', config.clientId);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('post_logout_redirect_uri', `${config.baseUrl}/?loggedOut=1`);
    return url.toString();
  }

  async function verifyLogout(token) {
    if (typeof token !== 'string') throw new Error('logout_token이 필요합니다.');
    await discover();
    const { payload } = await jwtVerify(token, jwks, {
      issuer, audience: config.clientId, algorithms: ['ES256'], maxTokenAge: '5m',
      requiredClaims: ['iat', 'jti', 'sid', 'events'],
    });
    const event = payload.events?.[LOGOUT_EVENT];
    if (typeof payload.sid !== 'string' || !payload.sid || typeof payload.jti !== 'string' || !payload.jti
      || Object.hasOwn(payload, 'nonce') || !event || typeof event !== 'object'
      || Array.isArray(event) || Object.keys(event).length !== 0) {
      throw new Error('로그아웃 토큰의 events, sid 또는 nonce가 올바르지 않습니다.');
    }
    return payload.sid;
  }

  return { issuer, clientId: config.clientId, getJwk, begin, callback, logoutUrl, verifyLogout };
}
