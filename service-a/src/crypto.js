import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../../shared/canonical.js';
import { validateFields } from '../../shared/certificate-fields.js';

export function loadIssuer(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'issuer-key.pem');
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  const publicKey = createPublicKey(privateKey);
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  if (kty !== 'EC' || crv !== 'P-256') throw new Error('발급 키는 P-256이어야 합니다.');
  const jwk = { kty, crv, x, y };
  // RFC 7638: 공개 JWK의 필수 멤버만 사전순 정규화한 SHA-256 지문.
  const kid = createHash('sha256').update(canonicalize(jwk)).digest('base64url').slice(0, 16);
  const publicInfo = {
    kid, alg: 'ES256', curve: 'P-256', jwk,
    point: { x: Buffer.from(x, 'base64url').toString('hex'), y: Buffer.from(y, 'base64url').toString('hex') },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    createdAt: statSync(path).mtime.toISOString(),
  };
  return { privateKey, publicInfo };
}

export function issueCertificate(fields, user, issuer) {
  const error = validateFields(fields);
  if (error) throw new TypeError(error);
  const payload = {
    id: randomUUID(), type: fields.type, title: fields.title, recipientName: fields.recipientName,
    description: fields.description ?? '',
    subject: { sub: user.sub, username: user.username },
    issuer: { service: 'A', name: '서명 발급소', kid: issuer.publicInfo.kid },
    issuedAt: new Date().toISOString(),
  };
  const canonicalPayload = canonicalize(payload);
  const bytes = Buffer.from(canonicalPayload, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const signature = sign('sha256', bytes, { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    certificate: { version: 1, payload, signature: {
      alg: 'ES256', curve: 'P-256', kid: issuer.publicInfo.kid, hash,
      r: signature.subarray(0, 32).toString('hex'), s: signature.subarray(32).toString('hex'),
    } },
    debug: { canonicalPayload, hash },
  };
}
