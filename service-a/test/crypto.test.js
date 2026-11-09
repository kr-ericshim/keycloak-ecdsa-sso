import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '../../shared/canonical.js';
import { validateFields } from '../../shared/certificate-fields.js';
import { loadIssuer, issueCertificate } from '../src/crypto.js';

test('canonicalization recursively sorts keys, preserves arrays and Unicode', () => {
  const one = { z: [{ b: 2, a: '한글' }], a: { z: true, a: null }, '2': 2, '10': 10 };
  const two = { '10': 10, '2': 2, a: { a: null, z: true }, z: [{ a: '한글', b: 2 }] };
  assert.equal(canonicalize(one), canonicalize(two));
  assert.equal(canonicalize(one), '{"10":10,"2":2,"a":{"a":null,"z":true},"z":[{"a":"한글","b":2}]}');
});

test('issuer key persists, thumbprint is RFC 7638, signature is 32-byte r || s', t => {
  const directory = mkdtempSync(join(tmpdir(), 'crypto-sso-a-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issuer = loadIssuer(directory), reloaded = loadIssuer(directory);
  assert.deepEqual(reloaded.publicInfo, issuer.publicInfo);
  assert.equal(statSync(join(directory, 'issuer-key.pem')).mode & 0o777, 0o600);
  assert.equal(issuer.publicInfo.kid, createHash('sha256').update(canonicalize(issuer.publicInfo.jwk)).digest('base64url').slice(0, 16));
  const result = issueCertificate({ type: '수료증', title: '암호 과제', recipientName: '홍길동' },
    { sub: 'alice-id', username: 'alice' }, issuer);
  const { signature } = result.certificate;
  assert.match(signature.r, /^[0-9a-f]{64}$/);
  assert.match(signature.s, /^[0-9a-f]{64}$/);
  assert.equal(result.debug.hash, signature.hash);
  assert.equal(verify('sha256', Buffer.from(result.debug.canonicalPayload),
    { key: createPublicKey(issuer.privateKey), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature.r + signature.s, 'hex')), true);
});

test('certificate inputs reject missing, oversized, and non-string fields', () => {
  const valid = { type: '수료증', title: '제목', recipientName: '이름' };
  assert.equal(validateFields(valid), null);
  for (const change of [{ title: '' }, { title: 'a'.repeat(201) }, { type: [] },
    { recipientName: ' ' }, { description: 'a'.repeat(2001) }, { description: null }]) {
    assert.equal(typeof validateFields({ ...valid, ...change }), 'string');
  }
  assert.ok(validateFields(null));
  assert.ok(validateFields([]));
});
