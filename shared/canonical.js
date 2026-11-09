// 숫자처럼 보이는 키도 JSON.stringify의 재정렬 없이 사전순으로 출력한다.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new TypeError('JSON 값만 정규화할 수 있습니다.');
  }
  return json;
}
