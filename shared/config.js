import { resolve } from 'node:path';
import dotenv from 'dotenv';

export function loadConfig(service, directory) {
  // 실행한 디렉터리와 무관하게 각 서비스의 .env를 읽는다. 실제 env가 우선한다.
  dotenv.config({ path: resolve(directory, '.env'), quiet: true });
  const port = Number(process.env.PORT || (service === 'A' ? 3001 : 3002));
  const publicUrl = (process.env.KEYCLOAK_PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
  const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  return {
    service, port, baseUrl,
    publicDir: resolve(directory, 'public'),
    dataDir: resolve(directory, process.env.DATA_DIR || 'data'),
    publicUrl,
    internalUrl: (process.env.KEYCLOAK_INTERNAL_URL || publicUrl).replace(/\/$/, ''),
    realm: process.env.KEYCLOAK_REALM || 'crypto-sso',
    clientId: process.env.CLIENT_ID || `service-${service.toLowerCase()}`,
    clientSecret: process.env.CLIENT_SECRET || `service-${service.toLowerCase()}-dev-secret`,
    sessionSecret: process.env.SESSION_SECRET || `local-only-service-${service.toLowerCase()}-replace-this-session-secret`,
    cookieName: service === 'A' ? 'sid_a' : 'sid_b',
    issuerKeyUrl: process.env.ISSUER_KEY_URL || 'http://localhost:3001/api/issuer-key',
    // 리버스 프록시(Caddy) 뒤에서 X-Forwarded-* 를 믿을 홉 수. 로컬 개발은 비워 둔다.
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
    // 프론트엔드의 "상대 서비스로 이동" 링크. /config.js 로 내려준다.
    peerUrl: (process.env.PEER_URL || (service === 'A' ? 'http://localhost:3002' : 'http://localhost:3001')).replace(/\/$/, ''),
    peerName: process.env.PEER_NAME || (service === 'A' ? '서명 검증소' : '서명 발급소'),
  };
}
