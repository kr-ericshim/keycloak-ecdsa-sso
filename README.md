# Keycloak 기반 두 웹 서비스 SSO 실습 프로젝트

이 프로젝트는 아래 과제의 요구사항을 충족하는 것을 목표로 한다. 과제 원문 캡처는 [docs/assignment.png](docs/assignment.png)에 있다.

## 1. 과제 목표

Keycloak을 이용하여 두 개의 웹 서비스에 SSO(Single Sign-On)를 적용하고, 실제 동작을 확인한다.

## 2. 필수 수행 내용

### 웹 서비스 구현

- 웹 서비스 A와 B를 각각 구현한다.
- 생성형 AI를 활용하여 개발해도 무방하지만, 각 서비스의 기능을 충분히 설명할 수 있어야 한다.
- Keycloak을 이용하여 두 서비스의 인증 기능을 구현한다.

### SSO 동작 검증

- 서비스 A에 로그인한 후 서비스 B에 접근했을 때 추가 로그인 없이 접속되는지 확인한다.
- 로그아웃하거나 새로운 브라우저 세션에서 접근했을 때 인증이 필요한지 확인한다.
- 각 동작 검증의 실제 실행 화면을 캡처하고, 테스트 결과와 함께 정리한다.

### 동작 원리 정리

- Keycloak을 이용하여 SSO가 동작하는 원리를 간단히 설명한다.

## 3. 제출 요건

- **제출 형식:** PPT 10~20장 내외
- **평가 반영:** 과제점수 10점
- **화면 증빙:** 각 동작 검증에 실행 화면 캡처 포함
- **소스코드 공유:** 마지막 슬라이드에 소스코드 GitHub 주소 또는 프로젝트 공유 링크 기재

### 최소 PPT 구성 권장

1. 시스템 구성도: Keycloak, 서비스 A, 서비스 B
2. 구현 환경 및 Keycloak 설정
3. 웹 서비스 A, B 구현 화면
4. 서비스 A 로그인 동작 확인
5. 서비스 B SSO 동작 확인
6. 로그아웃 또는 재접속 테스트 결과
7. SSO 동작 원리 및 실습 소감

위 항목은 발표자료에 포함할 내용이며, 전체 분량은 10~20장 내외로 구성한다.

## 4. 선택 가점 사항

- **가점 #1:** 발표영상을 제작하고 YouTube 링크를 발표자료에 포함한다.
- **가점 #2:** 암호학 기술이 적용된 서비스를 개발한다.

두 가점 모두 수행한다. 가점 #2는 아래 "6. 설계 결정"의 타원곡선 암호(ECC) 적용으로 충족한다.

## 5. 완료 확인 목록

- [x] 웹 서비스 A 구현 및 기능 설명 정리
- [x] 웹 서비스 B 구현 및 기능 설명 정리
- [x] Keycloak을 이용한 두 서비스 인증 구현
- [ ] 서비스 A 로그인 동작 검증 및 화면 캡처
- [ ] 서비스 B 추가 로그인 없는 SSO 접속 검증 및 화면 캡처
- [ ] 로그아웃 또는 새로운 브라우저 세션에서 인증 필요 여부 검증 및 화면 캡처
- [ ] 시스템 구성도 작성
- [x] 구현 환경 및 Keycloak 설정 정리
- [ ] SSO 동작 원리 및 실습 소감 정리
- [ ] PPT 10~20장 내외 작성
- [ ] 마지막 슬라이드에 GitHub 주소 또는 프로젝트 공유 링크 기재

## 6. 설계 결정

### 서비스 주제

| 서비스 | 이름 | 기능 | 적용 암호 기술 |
|---|---|---|---|
| A (:3001) | 서명 발급소 | 로그인한 사용자가 증명서를 만들면 서버의 ECDSA P-256 개인키로 서명해 발급 | SHA-256, ECDSA 서명 |
| B (:3002) | 서명 검증소 | 증명서를 올리면 A의 공개키로 서명을 검증하고, 타원곡선 연산 과정(u1, u2, R)을 단계별로 공개. 위변조 탐지 | 공개키 곡선 위 검사, ECDSA 검증(직접 구현과 라이브러리 교차 확인) |
| Keycloak (:8080) | IdP | realm `crypto-sso`, OIDC Authorization Code + PKCE(S256) | ID/Access 토큰 ES256(ECDSA P-256) 서명 |

Keycloak 로그인 화면은 커스텀 테마 `keycloak/themes/crypto-sso`로 바꿨다. A나 B의 화면이 아니라 두 서비스가 함께 쓰는 "통합 인증" 창구라서 중립색을 쓰고, 어느 서비스가 로그인을 요청했는지(client)만 그 서비스 색으로 표시한다.

시연 흐름: A에서 로그인 → 증명서 발급 → "검증소에서 확인"으로 B 이동(추가 로그인 없음) → 검증 성공 → 내용을 한 글자 바꿔 다시 검증 → 위조 탐지 → 로그아웃 후 A·B 모두 인증 요구.

### 구현 환경

- Keycloak: Docker Compose (`start-dev`, realm JSON 자동 import)
- 서비스 A, B: Node.js + Express, 각자 `public/`의 정적 프론트엔드(HTML/CSS/JS)를 같은 origin에서 제공
- 로그아웃: RP-initiated logout + back-channel logout으로 A·B 세션을 함께 정리
- 배포: 로컬 Docker로 먼저 완성한 뒤 클라우드로 이전. 주소는 모두 환경변수로 분리
- 소스코드: GitHub 저장소로 공유

API 계약은 [docs/API.md](docs/API.md)에 정리했다.

### 아직 정하지 않은 것

- (없음)

제출 마감일과 가점 배점은 제공된 과제 안내에 명시되어 있지 않다.

## 7. 실행 방법 (로컬)

필요한 것: Docker Desktop, Node.js 22 이상.

```bash
npm install
docker compose up -d keycloak     # Keycloak :8080, realm 자동 import (첫 기동 1분 정도)
npm run dev:a                     # 서명 발급소 http://localhost:3001
npm run dev:b                     # 서명 검증소 http://localhost:3002 (다른 터미널)
npm test                          # 서명·검증·ECC 단위 테스트
```

- 시연 계정은 `alice`, `bob`이다. 비밀번호는 [.env.example](.env.example) 맨 아래 주석에 있다(개발용 테스트 값).
- Keycloak 관리 콘솔: http://localhost:8080/admin (계정은 `.env.example`의 `KC_BOOTSTRAP_ADMIN_*`)
- 서비스 컨테이너까지 한 번에 띄우려면 `docker compose --profile full up -d --build`를 쓴다.
- realm 설정을 바꾼 뒤에는 `docker compose down -v`로 Keycloak 데이터를 지워야 다시 import된다.

## 8. 검증 결과 (2026-11-09, 로컬)

| 시나리오 | 결과 |
|---|---|
| A 접속 → Keycloak 로그인 → A 진입 | 통과 |
| A에서 "검증소에서 확인" → B 진입 | 비밀번호 입력 없이 진입. B의 auth_time이 A 로그인 시각과 같음 |
| 발급한 증명서 검증 | 6단계 통과, 직접 구현과 Node crypto 모두 통과 |
| 받는 사람 한 글자 변경 후 검증 | 해시 재계산, ECDSA 검증 단계에서 실패 → 위조 판정 |
| B에서 로그아웃 → A 접속 | back-channel logout으로 A 세션도 삭제, Keycloak 로그인 화면 표시 |

## 9. 배포 (2026-11-09)

| 구성 요소 | 주소 |
|---|---|
| 통합 인증 (Keycloak) | https://idp.ericshim.me |
| 서명 발급소 (서비스 A) | https://sign.ericshim.me |
| 서명 검증소 (서비스 B) | https://verify.ericshim.me |

- Vultr VPS(Ubuntu 24.04, 1코어·1GB) 위의 기존 Nginx Proxy Manager 뒤에 `deploy/compose.npm.yml`로 올렸다. HTTPS는 Let's Encrypt.
- 실제 도메인에서 로그인, 도메인 간 SSO, 증명서 검증, back-channel logout을 확인했다. 토큰 서명은 ES256.
- 관리 콘솔과 master realm은 외부에서 404이고, SSH 터널로만 접근한다. 절차는 [docs/DEPLOY.md](docs/DEPLOY.md).
- 시연 계정 비밀번호는 서버의 `deploy/production.env`에만 있다(저장소에 없음).
- 회원가입: 로그인 화면의 "가입하기"에서 누구나 계정을 만들 수 있다(Google reCAPTCHA v2, 비밀번호 8자 이상, 로그인 5회 실패 시 점진적 잠금). 가입한 계정 하나로 발급소와 검증소를 모두 쓴다.

