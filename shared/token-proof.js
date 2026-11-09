import { createHash, verify } from 'node:crypto';
import { hex, pointHex, isOnCurve, manualVerify, mod, n } from './ecc-p256.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function decode(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('ID 토큰 조각의 형식이 올바르지 않습니다.');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('ID 토큰 인코딩이 올바르지 않습니다.');
  return bytes;
}

function decodeJson(segment) {
  try {
    const json = JSON.parse(decode(segment).toString('utf8'));
    if (object(json)) return json;
  } catch {
    // JSON 파서의 오류에는 토큰 조각이 들어갈 수 있으므로 외부로 전달하지 않는다.
  }
  throw new Error('ID 토큰의 JSON 형식이 올바르지 않습니다.');
}

function preview(segment, json) {
  // 비정상적으로 짧은 조각도 원문 전체가 head/tail에 실리지 않게 한다.
  const available = Math.max(0, segment.length - 1);
  const result = { head: segment.slice(0, Math.min(12, available)),
    tail: available ? segment.slice(-Math.min(8, available)) : '', length: segment.length };
  if (json !== undefined) result.json = json;
  return result;
}

function keyPoint(jwk) {
  const point = {};
  for (const name of ['x', 'y']) {
    const bytes = decode(jwk[name]);
    if (bytes.length !== 32) throw new Error('공개키 좌표는 32바이트여야 합니다.');
    point[name] = BigInt(`0x${bytes.toString('hex')}`);
  }
  return point;
}

export async function tokenProof(idToken, oidc, tamper = null) {
  if (typeof idToken !== 'string') throw new Error('ID 토큰이 없습니다.');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID 토큰은 세 조각이어야 합니다.');
  const [headerSegment, originalPayload, signatureSegment] = parts;
  const header = decodeJson(headerSegment), payload = decodeJson(originalPayload);
  let payloadSegment = originalPayload, tampered = null;
  if (tamper) {
    tampered = { claim: tamper.claim, from: payload[tamper.claim] ?? null, to: tamper.value };
    payload[tamper.claim] = tamper.value;
    payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  }
  const bytes = Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii');
  const e = createHash('sha256').update(bytes).digest('hex');
  const checks = [
    { key: 'alg', label: '서명 방식이 ES256인가', ok: header.alg === 'ES256',
      detail: header.alg === 'ES256' ? '헤더 alg = ES256' : '헤더 alg가 ES256이 아닙니다.' },
    { key: 'key', label: 'Keycloak 공개키 찾기', ok: false, detail: 'JWKS에서 일치하는 EC / P-256 공개키를 찾지 못했습니다.' },
    { key: 'onCurve', label: '공개키가 P-256 곡선 위의 점인가', ok: null, detail: '공개키를 얻지 못했습니다.' },
    { key: 'ecdsa', label: '서명 대조 (R.x = r)', ok: null, detail: '서명 대조에 필요한 값을 얻지 못했습니다.' },
    { key: 'claims', label: '발급자·대상 확인', ok: null, detail: '' },
  ];
  const result = {
    valid: false, tampered,
    segments: { header: preview(headerSegment, header), payload: preview(payloadSegment, payload),
      signature: preview(signatureSegment) },
    key: { kid: typeof header.kid === 'string' ? header.kid : null, alg: null, crv: null, jwksUrl: null, Q: null },
    signature: { r: null, s: null }, hash: { signedBytes: bytes.length, e },
    math: { w: null, u1: null, u2: null, R: null, RxModN: null }, checks,
    manualValid: null, libraryValid: null,
    expiresInSeconds: Number.isFinite(payload.exp) ? payload.exp - Math.floor(Date.now() / 1000) : null,
  };

  let jwk, Q, signature;
  try {
    const found = await oidc.getJwk(header.kid);
    result.key.jwksUrl = found.jwksUrl;
    jwk = found.jwk;
    checks[1].ok = !!jwk && typeof header.kid === 'string' && !!header.kid
      && jwk.kid === header.kid && jwk.kty === 'EC' && jwk.crv === 'P-256';
    if (checks[1].ok) {
      result.key.alg = jwk.alg ?? header.alg;
      result.key.crv = jwk.crv;
      checks[1].detail = 'JWKS에서 kid 일치';
    }
  } catch {
    checks[1].detail = 'Keycloak 공개키를 조회하지 못했습니다.';
  }
  if (checks[1].ok) {
    try {
      Q = keyPoint(jwk);
      result.key.Q = pointHex(Q);
      checks[2].ok = isOnCurve(Q);
    } catch {
      checks[2].ok = false;
    }
    checks[2].detail = 'y² ≡ x³ − 3x + b (mod p)';
  }
  try {
    signature = decode(signatureSegment);
    if (signature.length !== 64) throw new Error('서명 길이 오류');
    result.signature.r = signature.subarray(0, 32).toString('hex');
    result.signature.s = signature.subarray(32).toString('hex');
  } catch {
    signature = null;
    checks[3].ok = false;
    checks[3].detail = 'ES256 서명은 64바이트 r‖s여야 합니다.';
  }
  if (checks[2].ok === true && signature) {
    const r = BigInt(`0x${result.signature.r}`), s = BigInt(`0x${result.signature.s}`);
    const manual = manualVerify(BigInt(`0x${e}`), r, s, Q);
    result.math = { w: manual.w === null ? null : hex(manual.w),
      u1: manual.u1 === null ? null : hex(manual.u1), u2: manual.u2 === null ? null : hex(manual.u2),
      R: pointHex(manual.R), RxModN: manual.R === null ? null : hex(mod(manual.R.x, n)) };
    result.manualValid = manual.valid;
    try {
      result.libraryValid = verify('sha256', bytes,
        { key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      result.libraryValid = false;
    }
    checks[3].ok = result.manualValid && result.libraryValid;
    checks[3].detail = checks[3].ok ? '직접 구현과 Node crypto 모두 일치'
      : '직접 구현 또는 Node crypto의 서명 대조에 실패했습니다.';
  }
  checks[4].ok = payload.iss === oidc.issuer && (payload.aud === oidc.clientId
    || (Array.isArray(payload.aud) && payload.aud.includes(oidc.clientId)));
  checks[4].detail = checks[4].ok ? 'iss, aud 일치' : 'iss 또는 aud가 일치하지 않습니다.';
  result.valid = checks.every(check => check.ok === true);
  return result;
}
