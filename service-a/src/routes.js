import { join } from 'node:path';
import { JsonStore } from '../../shared/json-store.js';
import { apiError, requireJson } from '../../shared/http.js';
import { issueCertificate } from './crypto.js';
import { validateFields } from '../../shared/certificate-fields.js';

export function attachRoutes(app, config, requireAuth, issuer) {
  const store = new JsonStore(join(config.dataDir, 'certificates.json'));
  app.get('/api/issuer-key', (req, res) => res.json(issuer.publicInfo));
  app.use('/api/certificates', requireAuth);

  app.post('/api/certificates', requireJson, (req, res) => {
    const error = validateFields(req.body);
    if (error) return apiError(res, 400, 'bad_request', error);
    const claims = req.session.auth.claims;
    const result = issueCertificate(req.body, { sub: claims.sub, username: claims.preferred_username || '' }, issuer);
    store.prepend(result.certificate);
    res.status(201).json(result);
  });

  app.get('/api/certificates', (req, res) => {
    res.json({ items: store.read().filter(item => item.payload.subject.sub === req.session.auth.claims.sub) });
  });

  app.get('/api/certificates/:id', (req, res) => {
    const certificate = store.read().find(item => item.payload.id === req.params.id
      && item.payload.subject.sub === req.session.auth.claims.sub);
    if (!certificate) return apiError(res, 404, 'not_found', '증명서를 찾을 수 없습니다.');
    res.json({ certificate });
  });
}
