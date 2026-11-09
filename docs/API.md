# API 계약 (백엔드 ↔ 프론트엔드)

서비스 A(증명서 발급)와 서비스 B(증명서 검증)는 각각 독립된 Express 서버이며, 자기 `public/` 폴더의 정적 프론트엔드를 같은 origin에서 제공한다. 프론트엔드는 아래 JSON API만 사용한다.

| 구성 요소 | 로컬 주소 | 역할 |
|---|---|---|
| Keycloak | http://localhost:8080 | IdP, realm `crypto-sso`, 토큰 서명 ES256 |
| 서비스 A | http://localhost:3001 | 로그인 사용자의 증명서를 ECDSA P-256으로 서명해 발급 |
| 서비스 B | http://localhost:3002 | 증명서를 업로드받아 서명을 검증, 타원곡선 연산 과정 공개 |

모든 값의 바이너리 표현은 소문자 hex 문자열이다. 시각은 ISO 8601 UTC 문자열이다.

## 1. 공통 인증 엔드포인트 (A, B 동일)

| 메서드·경로 | 설명 |
|---|---|
| `GET /login?returnTo=/path` | OIDC Authorization Code + PKCE(S256) 시작. `returnTo`는 `/`로 시작하는 상대 경로만 허용, 기본값 `/` |
| `GET /callback` | 코드 교환, ID 토큰 ES256 서명 검증 후 세션 생성, `returnTo`로 리다이렉트 |
| `POST /logout` | 로컬 세션 삭제 후 Keycloak RP-initiated logout으로 리다이렉트. 돌아오는 주소는 `{BASE_URL}/?loggedOut=1` |
| `POST /backchannel-logout` | Keycloak이 보내는 `logout_token`을 검증하고 같은 `sid`의 세션을 모두 삭제 |
| `GET /api/me` | 로그인 상태면 200, 아니면 401 `{ "error": "unauthenticated" }` |

`GET /api/me` 200 응답:

```json
{
  "service": "A",
  "user": { "sub": "uuid", "username": "alice", "name": "Alice Kim", "email": "alice@example.com" },
  "session": {
    "sid": "Keycloak SSO 세션 id",
    "authTime": "2026-11-09T06:30:00.000Z",
    "loginAt": "2026-11-09T06:30:02.000Z",
    "expiresAt": "2026-11-09T06:35:02.000Z"
  },
  "token": {
    "header": { "alg": "ES256", "kid": "...", "typ": "JWT" },
    "claims": { "iss": "...", "aud": "service-a", "azp": "service-a", "sub": "...", "sid": "...", "iat": 0, "exp": 0, "auth_time": 0, "preferred_username": "alice" },
    "signatureVerified": true
  }
}
```

- `session.authTime`은 ID 토큰의 `auth_time`이다. A에서 로그인하고 B로 넘어가면 B의 `authTime`이 A와 같다. 즉 B에서는 새 인증이 없었다는 SSO 증거로 화면에 강조한다.
- `session.loginAt`은 이 서비스에 세션이 생긴 시각이다(A와 B가 서로 다르다).
- `token`에는 서명 부분과 원문 토큰을 넣지 않는다(헤더와 클레임만).

## 2. 증명서 형식

```json
{
  "version": 1,
  "payload": {
    "id": "uuid",
    "type": "수료증",
    "title": "암호와 인증 프로젝트 수료",
    "recipientName": "홍길동",
    "description": "자유 서술",
    "subject": { "sub": "uuid", "username": "alice" },
    "issuer": { "service": "A", "name": "서명 발급소", "kid": "issuer-key-id" },
    "issuedAt": "2026-11-09T06:31:00.000Z"
  },
  "signature": {
    "alg": "ES256",
    "curve": "P-256",
    "kid": "issuer-key-id",
    "hash": "sha256(canonical(payload)) hex, 64자",
    "r": "hex, 64자",
    "s": "hex, 64자"
  }
}
```

- **정규화(canonical):** payload를 객체 키 사전순으로 재귀 정렬하고, 공백 없이 JSON 직렬화한 UTF-8 바이트를 쓴다.
- **서명:** ECDSA P-256 + SHA-256으로 정규화 바이트에 서명한다. `r`과 `s`는 각각 32바이트 big-endian hex이다(IEEE P1363의 r‖s를 둘로 나눈 값).
- `signature.hash`는 사람이 보기 위한 값이다. 검증자는 해시를 반드시 다시 계산해서 비교한다.

## 3. 서비스 A 전용 API (로그인 필요, 단 issuer-key는 공개)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/issuer-key` (공개) | - | `{ "kid", "alg": "ES256", "curve": "P-256", "jwk": { "kty": "EC", "crv": "P-256", "x": "base64url", "y": "base64url" }, "point": { "x": "hex", "y": "hex" }, "publicKeyPem", "createdAt" }` |
| `POST /api/certificates` | `{ "type", "title", "recipientName", "description" }` (type·title·recipientName 필수, 각 200자 이하, description 2000자 이하) | 201 `{ "certificate": <증명서>, "debug": { "canonicalPayload": "문자열", "hash": "hex" } }` |
| `GET /api/certificates` | - | `{ "items": [<증명서>, ...] }` 로그인 사용자가 발급한 것만, 최신순 |
| `GET /api/certificates/:id` | - | `{ "certificate": <증명서> }` 본인 것이 아니면 404 |

## 4. 서비스 B 전용 API (로그인 필요)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /api/verify` | `{ "certificate": <증명서 객체> }` | 아래 검증 결과 (형식이 깨져도 200으로 `valid:false` 반환, 본문이 JSON이 아니면 400) |
| `GET /api/verifications` | - | `{ "items": [{ "id", "verifiedAt", "valid", "title", "recipientName", "certificateId" }] }` 로그인 사용자 기록, 최신순 최대 20개 |

검증 결과:

```json
{
  "valid": true,
  "summary": "서명이 유효합니다. 발급 이후 내용이 바뀌지 않았습니다.",
  "steps": [
    { "key": "format",    "label": "형식 검사",                 "ok": true, "detail": "..." },
    { "key": "issuerKey", "label": "발급자 공개키 조회",        "ok": true, "detail": "kid 일치" },
    { "key": "onCurve",   "label": "공개키가 P-256 곡선 위의 점인지", "ok": true, "detail": "y² ≡ x³ − 3x + b (mod p)" },
    { "key": "range",     "label": "r, s 범위 (1 ≤ r, s < n)",  "ok": true, "detail": "..." },
    { "key": "hash",      "label": "SHA-256 해시 재계산",        "ok": true, "detail": "기록된 해시와 일치" },
    { "key": "ecdsa",     "label": "ECDSA 서명 검증",            "ok": true, "detail": "R.x mod n = r" }
  ],
  "payload": { "...": "증명서 payload 그대로 (형식 오류면 null)" },
  "math": {
    "curve": { "name": "P-256", "p": "hex", "a": "hex", "b": "hex", "n": "hex", "G": { "x": "hex", "y": "hex" } },
    "Q": { "x": "hex", "y": "hex" },
    "e": "hex  (해시를 정수로 본 값)",
    "r": "hex", "s": "hex",
    "w": "hex  (s⁻¹ mod n)",
    "u1": "hex (e·w mod n)",
    "u2": "hex (r·w mod n)",
    "R": { "x": "hex", "y": "hex" },
    "manualValid": true,
    "libraryValid": true
  }
}
```

- 어떤 단계가 실패하면 그 단계는 `ok:false`가 되고, 그 뒤 단계는 계산할 수 없으면 `ok:null`(건너뜀)이 된다. 해시가 달라도 ECDSA 단계는 계산해서 보여준다(위변조 시연용).
- `math`는 계산 가능한 만큼만 채우고, 불가능한 필드는 `null`로 둔다.
- `manualValid`는 BigInt로 직접 구현한 P-256 연산 결과이고, `libraryValid`는 Node `crypto.verify` 결과이다. 둘이 다르면 `valid:false`로 처리하고 서버 로그에 경고를 남긴다.

## 5. 오류 형식

JSON API 오류는 `{ "error": "code", "message": "한국어 설명" }` 형식이다. 401은 `unauthenticated`, 400은 `bad_request`, 404는 `not_found`를 쓴다.
