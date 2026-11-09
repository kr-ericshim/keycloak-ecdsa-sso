export function validateFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '증명서 입력은 객체여야 합니다.';
  for (const field of ['type', 'title', 'recipientName']) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 200) {
      return 'type, title, recipientName은 비어 있지 않은 200자 이하 문자열이어야 합니다.';
    }
  }
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) {
    return 'description은 2000자 이하 문자열이어야 합니다.';
  }
  return null;
}
