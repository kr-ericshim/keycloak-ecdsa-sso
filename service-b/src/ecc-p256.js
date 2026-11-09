// P-256의 유한체 소수 p, 곡선 y² = x³ + ax + b, 생성점 G와 차수 n.
export const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const a = p - 3n;
export const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const G = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

export const mod = (value, modulus = p) => ((value % modulus) + modulus) % modulus;
export const hex = value => value.toString(16).padStart(64, '0');
export const pointHex = point => point === null ? null : { x: hex(point.x), y: hex(point.y) };
export const curveInfo = { name: 'P-256', p: hex(p), a: hex(a), b: hex(b), n: hex(n), G: pointHex(G) };

// 확장 유클리드 알고리즘: value * inverse ≡ 1 (mod modulus).
export function inverse(value, modulus = p) {
  let oldR = modulus, r = mod(value, modulus), oldT = 0n, t = 1n;
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldT, t] = [t, oldT - quotient * t];
  }
  if (oldR !== 1n) throw new RangeError('모듈러 역원이 없습니다.');
  return mod(oldT, modulus);
}

export function isOnCurve(point) {
  return point !== null && typeof point?.x === 'bigint' && typeof point?.y === 'bigint'
    && point.x >= 0n && point.x < p && point.y >= 0n && point.y < p
    && mod(point.y * point.y) === mod(point.x ** 3n + a * point.x + b);
}

// null은 무한원점 O. 접선(두 배) 또는 두 점을 잇는 직선의 기울기를 쓴다.
export function add(P, Q) {
  if (P === null) return Q;
  if (Q === null) return P;
  if (P.x === Q.x && mod(P.y + Q.y) === 0n) return null;
  const slope = P.x === Q.x
    ? mod((3n * P.x * P.x + a) * inverse(2n * P.y))
    : mod((Q.y - P.y) * inverse(Q.x - P.x));
  const x = mod(slope * slope - P.x - Q.x);
  return { x, y: mod(slope * (P.x - x) - P.y) };
}

// 이진 전개를 이용한 double-and-add. 비밀키 연산에는 쓰지 않는 교육용 구현.
export function multiply(scalar, point = G) {
  if (scalar < 0n) throw new RangeError('스칼라는 음수가 될 수 없습니다.');
  let result = null, current = point;
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, current);
    current = add(current, current);
    scalar >>= 1n;
  }
  return result;
}

export function manualVerify(e, r, s, Q) {
  if (!isOnCurve(Q) || r < 1n || r >= n || s < 1n || s >= n) {
    return { valid: false, w: null, u1: null, u2: null, R: null };
  }
  // w=s⁻¹, u1=e*w, u2=r*w를 구해 R=u1*G+u2*Q의 x좌표를 r과 비교한다.
  const w = inverse(s, n), u1 = mod(e * w, n), u2 = mod(r * w, n);
  const R = add(multiply(u1, G), multiply(u2, Q));
  return { valid: R !== null && mod(R.x, n) === r, w, u1, u2, R };
}
