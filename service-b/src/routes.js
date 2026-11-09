import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from '../../shared/json-store.js';
import { requireJson } from '../../shared/http.js';
import { createIssuerKeySource } from './issuer-key.js';
import { verifyCertificate } from './verify.js';

export function attachRoutes(app, config, requireAuth) {
  const store = new JsonStore(join(config.dataDir, 'verifications.json'));
  const getIssuerKey = createIssuerKeySource(config.issuerKeyUrl);
  app.use(['/api/verify', '/api/verifications'], requireAuth);

  app.post('/api/verify', requireJson, async (req, res) => {
    const result = await verifyCertificate(req.body?.certificate, getIssuerKey);
    const sub = req.session.auth.claims.sub;
    const entry = {
      id: randomUUID(), verifiedAt: new Date().toISOString(), valid: result.valid,
      title: result.payload?.title ?? '', recipientName: result.payload?.recipientName ?? '',
      certificateId: result.payload?.id ?? null,
    };
    store.prepend({ sub, ...entry }, items => {
      const counts = new Map();
      return items.filter(item => {
        const count = (counts.get(item.sub) || 0) + 1;
        counts.set(item.sub, count);
        return count <= 20;
      });
    });
    res.json(result);
  });

  app.get('/api/verifications', (req, res) => {
    const items = store.read().filter(item => item.sub === req.session.auth.claims.sub)
      .slice(0, 20).map(({ sub, ...entry }) => entry);
    res.json({ items });
  });
}
