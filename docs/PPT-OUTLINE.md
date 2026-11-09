# 발표 자료 구성안 (19장)

과제 권장 구성 7개 항목은 ★로 표시했다. 캡처는 `docs/screenshots/`의 파일 이름이다.
가점 #2(암호학 기술 적용)는 14~16장, 보안 설계는 17장에서 다룬다.

| # | 제목 | 핵심 메시지 (한 문장) | 캡처 |
|---|---|---|---|
| 1 | 표지 | Keycloak SSO로 묶은 서명 발급소와 서명 검증소 | 03-certificate (일부) |
| 2 | 한눈에 보기 | 로그인은 Keycloak 한 곳에서, 서비스 둘은 비밀번호 없이 오간다. 실서버 3개 주소 | 02, 06 축소 |
| 3 | ★ 시스템 구성도 | 브라우저 · Keycloak(idp) · 발급소(sign) · 검증소(verify)와 그 사이의 흐름 | 그림 (아래 "구성도") |
| 4 | ★ 구현 환경 | Node.js·Express, Keycloak 26 + Postgres, Docker Compose, Nginx Proxy Manager + Let's Encrypt, Vultr VPS | 표 |
| 5 | ★ Keycloak 설정 ① realm·클라이언트 | realm `crypto-sso`, 클라이언트 2개, Redirect URI, PKCE S256, back-channel logout URL | 20, 24, 28 |
| 6 | ★ Keycloak 설정 ② 토큰 서명·로그인 정책 | 토큰 서명 키를 ES256(타원곡선) 하나로, 회원가입·비밀번호 정책·로그인 실패 잠금 | 21, 29, 22 |
| 7 | ★ 서비스 A 화면: 서명 발급소 | 로그인한 사용자가 증명서를 만들면 발급소 개인키로 ECDSA 서명 | 02, 03 |
| 8 | ★ 서비스 B 화면: 서명 검증소 | 증명서를 넣으면 발급소 공개키로 6단계 검증 | 06, 07 |
| 9 | ★ 서비스 A 로그인 확인 | sign 접속 → idp 로그인 화면(발급소가 요청) → 로그인 → 발급소 | 01 → 02 |
| 10 | ★ 서비스 B SSO 확인 | verify로 이동하면 비밀번호 없이 들어간다. 인증 시각(auth_time)이 A와 같다 | 06, 05와 09 비교, 25 |
| 11 | ★ 로그아웃·재접속 테스트 | B에서 로그아웃하면 A도 끊긴다(back-channel). 새 브라우저는 다시 로그인 | 30, 31, 32 |
| 12 | 테스트 결과 정리 | 시나리오 6개 모두 통과 (표) | 표 |
| 13 | ★ SSO 동작 원리 | Keycloak 세션 쿠키 + Authorization Code + PKCE, 토큰은 ES256 서명 | 시퀀스 그림 (아래 "원리") |
| 14 | 암호 기술 ① 증명서 서명 | 내용 → 정규화 → SHA-256 → ECDSA(P-256) 서명 (r, s) | 03 |
| 15 | 암호 기술 ② 검증과 위조 탐지 | 한 글자만 바꿔도 해시가 달라져 R.x ≠ r | 08, 10, 11 |
| 16 | 암호 기술 ③ 로그인 토큰도 같은 서명 | ID 토큰을 직접 해부해 Keycloak 서명을 대조, 바꾸면 "위조" | 12, 14, 15 |
| 17 | 보안 설계 | PKCE·state·nonce, HttpOnly·Secure 쿠키, back-channel logout, 관리 콘솔 차단, reCAPTCHA, 로그인 실패 잠금, 비밀값 분리 | 41 |
| 18 | ★ 실습 소감 | (직접 작성) | - |
| 19 | 마무리 | GitHub 주소, 실서버 주소, (발표영상 링크) | - |

## 구성도 (3장)

```
                 ┌──────────────────────────────┐
  브라우저 ──────▶│ Nginx Proxy Manager (HTTPS)  │
                 └──┬───────────┬───────────┬───┘
                    ▼           ▼           ▼
          idp.ericshim.me  sign.ericshim.me  verify.ericshim.me
           Keycloak 26      서비스 A          서비스 B
           + Postgres       서명 발급소        서명 검증소
              │  ▲              │                │
              │  └── 코드 교환·토큰(ES256) ──────┘
              └──── back-channel logout ─▶ A, B
                         서비스 B ──(발급소 공개키 조회)──▶ 서비스 A
```

## 원리 (13장) — 화살표 순서

1. 사용자가 sign 접속 → 세션 없음 → idp 로그인 화면으로 이동 (`code_challenge` = SHA-256(verifier), PKCE)
2. 아이디·비밀번호 입력 → **Keycloak이 SSO 세션 쿠키를 idp 도메인에 저장** → sign으로 인가 코드 전달
3. sign 서버가 코드 + verifier로 토큰 교환 → ID 토큰의 ES256 서명을 Keycloak 공개키로 검증 → sign 세션 생성
4. 사용자가 verify 접속 → idp로 이동 → **idp 쿠키가 이미 있어 로그인 화면 없이** 바로 코드 발급 → verify 세션 생성
5. 로그아웃: verify → idp에 로그아웃 요청 → Keycloak이 sign·verify 서버에 back-channel logout 토큰 전송 → 두 서비스 세션 모두 삭제

## 테스트 결과 표 (12장)

| 시나리오 | 기대 결과 | 결과 | 증거 |
|---|---|---|---|
| sign 첫 접속 | idp 로그인 화면으로 이동 | 통과 | 01 |
| 로그인 후 sign | 발급소 화면, 사용자 이름 표시 | 통과 | 02 |
| sign → verify 이동 | 비밀번호 없이 진입, auth_time 동일 | 통과 | 06, 09, 25 |
| verify에서 로그아웃 | 로그아웃 화면 | 통과 | 30 |
| 로그아웃 후 sign 접속 | 다시 로그인 요구 | 통과 | 31 |
| 새 브라우저 세션으로 verify 접속 | 로그인 요구 | 통과 | 32 |

## 메모

- 캡처는 로컬 운영 구성 리허설(`*.localhost`)과 실서버(`*.ericshim.me`, 40번대)에서 찍었다. 실서버 시연은 발표영상에서 보여 준다.
- 관리 콘솔 캡처 상단의 노란 띠는 Keycloak의 "임시 관리자 계정" 안내다.
