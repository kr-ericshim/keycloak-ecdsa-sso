import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../shared/config.js';

export const config = loadConfig('B', fileURLToPath(new URL('../', import.meta.url)));
