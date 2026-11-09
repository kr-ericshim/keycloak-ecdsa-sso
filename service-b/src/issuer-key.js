// 공개키는 설정된 A의 URL에서만 읽는다. 업로드된 증명서의 URL은 신뢰하지 않는다.
export function createIssuerKeySource(url) {
  let cached, fetchedAt = 0;
  async function refresh() {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('발급소 공개키를 조회하지 못했습니다.');
    cached = await response.json();
    fetchedAt = Date.now();
  }
  return async kid => {
    if (!cached || Date.now() - fetchedAt > 5 * 60_000) await refresh();
    if (cached.kid !== kid) await refresh(); // 키 회전 가능성: kid 불일치 시 한 번 재조회.
    if (cached.kid !== kid) throw new Error('발급자 공개키의 kid가 일치하지 않습니다.');
    return cached;
  };
}
