import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalize } from '../../shared/canonical.js';
import { validateFields } from '../../shared/certificate-fields.js';
import { curveInfo, hex, pointHex, isOnCurve, manualVerify, n } from './ecc-p256.js';

const hex32 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;

function validFormat(certificate) {
  if (!object(certificate) || certificate.version !== 1 || !object(certificate.payload)
    || !object(certificate.signature)) return false;
  const { payload: p, signature: s } = certificate;
  return !validateFields(p) && typeof p.description === 'string'
    && text(p.id) && object(p.subject) && text(p.subject.sub) && text(p.subject.username)
    && object(p.issuer) && p.issuer.service === 'A' && text(p.issuer.name) && text(p.issuer.kid)
    && typeof p.issuedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.issuedAt)
    && Number.isFinite(Date.parse(p.issuedAt)) && new Date(p.issuedAt).toISOString() === p.issuedAt
    && s.alg === 'ES256' && s.curve === 'P-256' && s.kid === p.issuer.kid
    && [s.hash, s.r, s.s].every(value => typeof value === 'string' && hex32.test(value));
}

function keyPoint(key) {
  if (key.alg !== 'ES256' || key.curve !== 'P-256' || key.jwk?.kty !== 'EC' || key.jwk.crv !== 'P-256') {
    throw new Error('발급자 키는 ES256 / P-256 공개키여야 합니다.');
  }
  const coordinates = {};
  for (const name of ['x', 'y']) {
    const value = key.jwk[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('공개키 좌표 형식이 올바르지 않습니다.');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== value
      || key.point?.[name] !== bytes.toString('hex')) throw new Error('공개키 좌표 표현이 서로 다릅니다.');
    coordinates[name] = BigInt(`0x${bytes.toString('hex')}`);
  }
  return coordinates;
}

export async function verifyCertificate(certificate, getIssuerKey) {
  const steps = [
    { key: 'format', label: '형식 검사', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
    { key: 'issuerKey', label: '발급자 공개키 조회', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
    { key: 'onCurve', label: '공개키가 P-256 곡선 위의 점인지', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
    { key: 'range', label: 'r, s 범위 (1 ≤ r, s < n)', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
    { key: 'hash', label: 'SHA-256 해시 재계산', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
    { key: 'ecdsa', label: 'ECDSA 서명 검증', ok: null, detail: '앞 단계에서 계산에 필요한 값을 얻지 못했습니다.' },
  ];
  const math = { curve: curveInfo, Q: null, e: null, r: null, s: null,
    w: null, u1: null, u2: null, R: null, manualValid: null, libraryValid: null };
  const result = { valid: false, summary: '증명서 형식이 올바르지 않습니다.', steps, payload: null, math };
  const mark = (index, ok, detail) => Object.assign(steps[index], { ok, detail });

  let canonicalPayload;
  try {
    if (validFormat(certificate)) canonicalPayload = canonicalize(certificate.payload);
  } catch {
    // JSON이라도 지나치게 깊거나 정규화할 수 없는 구조는 형식 오류로 반환한다.
  }
  if (canonicalPayload === undefined) {
    mark(0, false, 'version, payload, ES256/P-256 서명 및 64자리 소문자 hex 값을 확인해 주세요.');
    return result;
  }
  mark(0, true, '증명서와 서명 필드의 형식이 올바릅니다.');
  result.payload = certificate.payload;
  const { signature } = certificate;
  math.r = signature.r; math.s = signature.s;

  let key, Q;
  try {
    key = await getIssuerKey(signature.kid);
    if (key.kid !== signature.kid) throw new Error('발급자 공개키의 kid가 일치하지 않습니다.');
    Q = keyPoint(key);
    math.Q = pointHex(Q);
    mark(1, true, 'kid 일치');
  } catch (error) {
    mark(1, false, error.message);
  }

  if (Q) mark(2, isOnCurve(Q), 'y² ≡ x³ − 3x + b (mod p)');
  const r = BigInt(`0x${signature.r}`), s = BigInt(`0x${signature.s}`);
  mark(3, r >= 1n && r < n && s >= 1n && s < n, '1 ≤ r, s < n 범위를 검사했습니다.');
  const bytes = Buffer.from(canonicalPayload, 'utf8');
  math.e = createHash('sha256').update(bytes).digest('hex');
  mark(4, math.e === signature.hash, math.e === signature.hash ? '기록된 해시와 일치' : '기록된 해시와 다릅니다. 내용이 변경됐습니다.');

  // 해시가 달라도 중단하지 않는다. 변경된 payload의 해시로 모든 수학 값을 계산한다.
  if (steps[2].ok === true && steps[3].ok === true) {
    const manual = manualVerify(BigInt(`0x${math.e}`), r, s, Q);
    math.w = hex(manual.w); math.u1 = hex(manual.u1); math.u2 = hex(manual.u2); math.R = pointHex(manual.R);
    math.manualValid = manual.valid;
    math.libraryValid = verify('sha256', bytes,
      { key: createPublicKey({ key: key.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(`${signature.r}${signature.s}`, 'hex'));
    const agrees = math.manualValid === math.libraryValid;
    if (!agrees) console.warn('경고: 직접 구현한 ECDSA와 crypto.verify의 결과가 다릅니다.');
    mark(5, agrees && math.manualValid && math.libraryValid,
      !agrees ? '직접 구현과 라이브러리의 결과가 다릅니다.'
        : manual.valid ? 'R.x mod n = r' : 'R이 무한원점이거나 R.x mod n ≠ r입니다.');
  }
  result.valid = steps.every(step => step.ok === true);
  result.summary = result.valid ? '서명이 유효합니다. 발급 이후 내용이 바뀌지 않았습니다.'
    : '서명이 유효하지 않습니다. 검증 단계에서 실패한 항목을 확인해 주세요.';
  return result;
}
