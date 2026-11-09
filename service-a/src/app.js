import express from 'express';
import { attachAuth } from '../../shared/auth.js';
import { finishApp } from '../../shared/http.js';
import { loadIssuer } from './crypto.js';
import { attachRoutes } from './routes.js';

export function createApp(config, authOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb', strict: false }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  const { requireAuth } = attachAuth(app, config, authOptions);
  attachRoutes(app, config, requireAuth, loadIssuer(config.dataDir));
  return finishApp(app, config);
}
