import session from 'express-session';
import { promisify } from 'node:util';
import { createOidc } from './oidc.js';
import { apiError } from './http.js';

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
  const cookie = { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https:'), path: '/' };
  app.use(session({
    name: config.cookieName, secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, cookie: { ...cookie, maxAge: 10 * 60_000 },
  }));

  // API 응답에는 토큰 원문 및 서명을 절대 싣지 않는다.
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

  return { requireAuth, store };
}
