import express from 'express';
import { join } from 'node:path';

export function apiError(res, status, error, message) {
  return res.status(status).json({ error, message });
}

export function finishApp(app, config) {
  app.use(express.static(config.publicDir));
  app.get('/', (req, res, next) => res.sendFile(join(config.publicDir, 'index.html'), error => {
    if (error) next(error);
  }));
  app.use((req, res) => apiError(res, 404, 'not_found', '요청한 항목을 찾을 수 없습니다.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large' || error.status === 400) {
      return apiError(res, 400, 'bad_request', '올바른 JSON 요청을 보내 주세요.');
    }
    if (error.status === 404 || error.code === 'ENOENT') {
      return apiError(res, 404, 'not_found', '요청한 항목을 찾을 수 없습니다.');
    }
    console.error(error.message);
    return apiError(res, 500, 'internal_error', '요청 처리 중 오류가 발생했습니다.');
  });
  return app;
}

export function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return apiError(res, 400, 'bad_request', 'Content-Type을 application/json으로 보내 주세요.');
  }
  next();
}
