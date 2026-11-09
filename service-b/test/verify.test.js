import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIssuer, issueCertificate } from '../../service-a/src/crypto.js';
import { verifyCertificate } from '../src/verify.js';
import { createIssuerKeySource } from '../src/issuer-key.js';
import { G, p, n, add, multiply, isOnCurve, manualVerify } from '../../shared/ecc-p256.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-sso-b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issuer = loadIssuer(dir);
  const { certificate } = issueCertificate({ type: '수료증', title: '암호 과제', recipientName: '홍길동', description: '원본' },
    { sub: 'alice-id', username: 'alice' }, issuer);
  return { issuer, certificate };
}

test('A signs -> B verifies with all six steps and manual/library agreement', async t => {
  const { issuer, certificate } = fixture(t);
  const result = await verifyCertificate(certificate, async () => issuer.publicInfo);
  assert.equal(result.valid, true);
  assert.deepEqual(result.steps.map(step => step.key), ['format', 'issuerKey', 'onCurve', 'range', 'hash', 'ecdsa']);
  assert.ok(result.steps.every(step => step.ok === true));
  assert.equal(result.math.manualValid, true);
  assert.equal(result.math.libraryValid, true);
  assert.deepEqual(result.payload, certificate.payload);
});

test('one-character payload tamper fails hash AND ECDSA while preserving all math', async t => {
  const { issuer, certificate } = fixture(t);
  certificate.payload.description = '원복';
  const result = await verifyCertificate(certificate, async () => issuer.publicInfo);
  assert.equal(result.valid, false);
  assert.equal(result.steps[4].ok, false);
  assert.equal(result.steps[5].ok, false);
  assert.equal(result.math.manualValid, false);
  assert.equal(result.math.libraryValid, false);
  for (const field of ['e', 'r', 's', 'w', 'u1', 'u2']) assert.match(result.math[field], /^[0-9a-f]{64}$/);
  assert.match(result.math.R.x, /^[0-9a-f]{64}$/);
  assert.match(result.math.R.y, /^[0-9a-f]{64}$/);
});

test('manual ECC matches crypto.verify on 20 random keys/signatures and changed messages', () => {
  for (let i = 0; i < 20; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const Q = { x: BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex')),
      y: BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex')) };
    const bytes = randomBytes(64);
    const signature = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = BigInt('0x' + signature.subarray(0, 32).toString('hex'));
    const s = BigInt('0x' + signature.subarray(32).toString('hex'));
    for (const changed of [false, true]) {
      const message = Buffer.from(bytes);
      if (changed) message[0] ^= 1;
      const e = BigInt('0x' + createHash('sha256').update(message).digest('hex'));
      const manual = manualVerify(e, r, s, Q).valid;
      const library = verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
      assert.equal(manual, library);
      assert.equal(manual, !changed);
    }
  }
});

test('on-curve rejects changed coordinates and field overflow; group edge cases work', () => {
  assert.equal(isOnCurve(G), true);
  assert.equal(isOnCurve({ x: G.x, y: G.y + 1n }), false);
  assert.equal(isOnCurve({ x: G.x + p, y: G.y }), false);
  assert.equal(isOnCurve(null), false);
  assert.equal(multiply(n, G), null);
  assert.deepEqual(multiply(2n, G), add(G, G));
  assert.equal(add(G, { x: G.x, y: p - G.y }), null);
});

test('broken format, key outage, and out-of-range signatures give partial results', async t => {
  const { issuer, certificate } = fixture(t);
  for (const broken of [null, {}, [], { ...certificate, version: 2 }]) {
    const result = await verifyCertificate(broken, () => { throw new Error('must not fetch'); });
    assert.equal(result.valid, false);
    assert.equal(result.payload, null);
    assert.deepEqual(result.steps.map(step => step.ok), [false, null, null, null, null, null]);
  }
  const badHex = structuredClone(certificate);
  badHex.signature.r = [badHex.signature.r];
  assert.equal((await verifyCertificate(badHex, async () => issuer.publicInfo)).steps[0].ok, false);
  const outage = await verifyCertificate(certificate, async () => { throw new Error('발급소 연결 실패'); });
  assert.deepEqual(outage.steps.map(step => step.ok), [true, false, null, true, true, null]);
  const badRange = structuredClone(certificate);
  badRange.signature.r = '0'.repeat(64);
  const result = await verifyCertificate(badRange, async () => issuer.publicInfo);
  assert.equal(result.steps[3].ok, false);
  assert.equal(result.steps[5].ok, null);
  assert.equal(result.math.w, null);
});

test('issuer key cache refreshes once on a changed or unknown kid', async t => {
  let kid = 'old-key', requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://issuer.test/api/issuer-key');
    requests++;
    return new Response(JSON.stringify({ kid }));
  });
  const getKey = createIssuerKeySource('http://issuer.test/api/issuer-key');
  assert.equal((await getKey('old-key')).kid, 'old-key');
  await getKey('old-key');
  assert.equal(requests, 1);
  kid = 'new-key';
  assert.equal((await getKey('new-key')).kid, 'new-key');
  assert.equal(requests, 2);
  await assert.rejects(getKey('unknown-key'));
  assert.equal(requests, 3);
});
