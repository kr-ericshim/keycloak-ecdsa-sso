import session from 'express-session';
import { promisify } from 'node:util';
import { createOidc } from './oidc.js';
import { apiError, requireJson } from './http.js';
import { tokenProof } from './token-proof.js';

// 두 localhost 서비스는 포트가 달라도 쿠키를 공유하므로 cookieName을 다르게 쓴다.
export class IndexedMemoryStore extends session.MemoryStore {
  constructor() {
    super();
    this.sidIndex = new Map();
    this.sessionSids = new Map();
  }

  unindex(id) {
    const sid = this.sessionSids.get(id);
    if (sid) {
      const ids = this.sidIndex.get(sid);
      ids?.delete(id);
      if (ids?.size === 0) this.sidIndex.delete(sid);
      this.sessionSids.delete(id);
    }
  }

  set(id, value, callback) {
    this.unindex(id);
    const sid = value.auth?.claims.sid;
    if (sid) {
      if (!this.sidIndex.has(sid)) this.sidIndex.set(sid, new Set());
      this.sidIndex.get(sid).add(id);
      this.sessionSids.set(id, sid);
    }
    super.set(id, value, callback);
  }

  get(id, callback) {
    super.get(id, (error, value) => {
      if (!value) this.unindex(id);
      callback(error, value);
    });
  }

  destroy(id, callback) {
    this.unindex(id);
    super.destroy(id, callback);
  }

  async destroySid(sid) {
    const ids = [...(this.sidIndex.get(sid) || [])];
    await Promise.all(ids.map(id => promisify(this.destroy).call(this, id)));
  }
}

const sessionAction = (req, method) => promisify(req.session[method]).call(req.session);

export function attachAuth(app, config, { store = new IndexedMemoryStore(), oidc = createOidc(config) } = {}) {
  // 프록시가 TLS를 끝내므로 X-Forwarded-Proto 를 믿어야 Secure 쿠키를 발급할 수 있다.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  const cookie = { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https:'), path: '/' };
  app.use(session({
    name: config.cookieName, secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, cookie: { ...cookie, maxAge: 10 * 60_000 },
  }));

  // 토큰 원문과 전체 base64url 조각은 API 응답에 싣지 않는다.
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/login', async (req, res) => {
    try {
      const { pending, url } = await oidc.begin(req.query.returnTo);
      req.session.oidc = pending;
      await sessionAction(req, 'save');
      res.redirect(url);
    } catch (error) {
      console.error(error.message);
      apiError(res, 503, 'identity_provider_unavailable', 'Keycloak에 연결할 수 없습니다. 실행 상태를 확인해 주세요.');
    }
  });

  app.get('/callback', async (req, res) => {
    const pending = req.session.oidc;
    delete req.session.oidc; // 코드 교환은 한 번만 시도한다.
    try {
      await sessionAction(req, 'save');
      const auth = await oidc.callback(req.query, pending);
      await sessionAction(req, 'regenerate'); // 로그인 전 세션 ID를 재사용하지 않는다.
      req.session.auth = auth;
      req.session.cookie.maxAge = Math.max(0, auth.claims.exp * 1000 - Date.now());
      await sessionAction(req, 'save');
      res.redirect(pending.returnTo);
    } catch (error) {
      console.warn(error.message);
      apiError(res, 400, 'bad_request', '로그인 응답을 검증하지 못했습니다. 다시 로그인해 주세요.');
    }
  });

  app.post('/logout', async (req, res) => {
    const idToken = req.session.auth?.idToken;
    await sessionAction(req, 'destroy');
    res.clearCookie(config.cookieName, cookie);
    try {
      res.redirect(await oidc.logoutUrl(idToken));
    } catch (error) {
      console.error(error.message);
      apiError(res, 503, 'identity_provider_unavailable', '로컬 세션은 종료됐지만 Keycloak에 연결할 수 없습니다.');
    }
  });

  app.post('/backchannel-logout', async (req, res) => {
    try {
      const sid = await oidc.verifyLogout(req.body?.logout_token);
      await store.destroySid(sid);
      res.status(200).end();
    } catch (error) {
      console.warn(error.message);
      apiError(res, 400, 'bad_request', '로그아웃 토큰을 검증하지 못했습니다.');
    }
  });

  function requireAuth(req, res, next) {
    if (!req.session.auth || req.session.auth.claims.exp * 1000 <= Date.now()) {
      if (req.session.auth) req.session.destroy(() => {});
      res.clearCookie(config.cookieName, cookie);
      return res.status(401).json({ error: 'unauthenticated' });
    }
    next();
  }

  app.get('/api/me', requireAuth, (req, res) => {
    const { claims, header, loginAt } = req.session.auth;
    res.json({
      service: config.service,
      user: { sub: claims.sub, username: claims.preferred_username || '', name: claims.name || '', email: claims.email || '' },
      session: { sid: claims.sid, authTime: new Date(claims.auth_time * 1000).toISOString(), loginAt,
        expiresAt: new Date(claims.exp * 1000).toISOString() },
      token: { header, claims, signatureVerified: true },
    });
  });

  function requireIdToken(req, res, next) {
    if (typeof req.session.auth.idToken !== 'string' || !req.session.auth.idToken) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    next();
  }

  async function sendTokenProof(req, res, tamper = null) {
    try {
      const proof = await tokenProof(req.session.auth.idToken, oidc, tamper);
      res.json({ service: config.service, ...proof });
    } catch {
      // 예외 메시지에도 토큰이 포함될 수 있으므로 응답하거나 기록하지 않는다.
      apiError(res, 400, 'bad_request', 'ID 토큰의 형식을 확인하지 못했습니다. 다시 로그인해 주세요.');
    }
  }

  app.get('/api/token-proof', requireAuth, requireIdToken, (req, res) => sendTokenProof(req, res));
  app.post('/api/token-proof', requireAuth, requireIdToken, requireJson, (req, res) => {
    const tamper = req.body?.tamper;
    if (!tamper || !['preferred_username', 'name', 'email', 'sub'].includes(tamper.claim)
      || typeof tamper.value !== 'string' || tamper.value.length < 1 || tamper.value.length > 200) {
      return apiError(res, 400, 'bad_request', '변경할 클레임과 1~200자의 문자열 값을 보내 주세요.');
    }
    // 원래 값과 같으면 내용이 바뀌지 않으므로 위조 시연이 성립하지 않는다.
    if (req.session.auth.claims[tamper.claim] === tamper.value) {
      return apiError(res, 400, 'unchanged', '원래 값과 같습니다. 한 글자라도 다르게 입력하세요.');
    }
    return sendTokenProof(req, res, tamper);
  });

  return { requireAuth, store };
}
