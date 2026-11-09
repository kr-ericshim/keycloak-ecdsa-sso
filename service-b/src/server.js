import { config } from './config.js';
import { createApp } from './app.js';

const server = createApp(config).listen(config.port, '0.0.0.0', () => {
  console.log(`서명 검증소: ${config.baseUrl}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
