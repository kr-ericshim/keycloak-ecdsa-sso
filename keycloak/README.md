# 개발용 Keycloak 실행

저장소 루트에서 다음 순서로 실행한다. Node 서비스는 각자 다른 터미널에서 실행한다.

```sh
cp .env.example .env
cp service-a/.env.example service-a/.env
cp service-b/.env.example service-b/.env
npm install
docker compose up -d --wait keycloak
npm test
npm run dev:a
# 다른 터미널: npm run dev:b
```

테스트 사용자는 `alice`, `bob`이다. 테스트 비밀번호와 개발용 클라이언트 시크릿은 루트 `.env.example`에 기록되어 있다. 관리자 계정은 루트 `.env`의 `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD`로 설정한다.

Keycloak 이미지는 공식 배포 페이지에서 확인한 `quay.io/keycloak/keycloak:26.8.2`로 고정했다. realm JSON은 Keycloak의 환경변수 치환 기능으로 클라이언트 주소·시크릿·back-channel 주소를 받는다. 파일은 요청한 이름인 `realm-crypto-sso.json`으로 보관하고, 컨테이너에는 import 파일명 규칙에 맞는 `crypto-sso-realm.json`으로 마운트한다.

Keycloak은 처음 시작할 때 realm을 import한다. 이미 같은 realm이 있으면 건너뛰므로, 이후 JSON이나 클라이언트 주소를 변경하면 관리자 콘솔에서 기존 realm 설정에도 반영해야 한다. 저장 볼륨을 지우는 작업은 사용자 및 세션도 삭제하므로 자동으로 수행하지 않는다.

## 전체 컨테이너 실행

```sh
docker compose --profile full up -d --build --wait
```

호스트 Node 서비스와 같은 포트를 사용하므로 먼저 호스트 서비스를 종료한다. 기본 back-channel URL은 요청대로 `host.docker.internal:3001/3002`다. 클라우드 VM의 컨테이너 내부로 직접 연결하려면 루트 `.env`에서 다음 값을 설정하고 Keycloak 클라이언트 설정에도 반영한다.

```dotenv
SERVICE_A_BACKCHANNEL_LOGOUT_URL=http://service-a:3001/backchannel-logout
SERVICE_B_BACKCHANNEL_LOGOUT_URL=http://service-b:3002/backchannel-logout
```

`KEYCLOAK_PUBLIC_URL`은 브라우저 URL이자 토큰 issuer다. `KEYCLOAK_INTERNAL_URL`은 서버의 discovery·코드 교환·JWKS 연결만 바꾼다. full profile은 기본적으로 `http://keycloak:8080`을 쓰며, B의 `ISSUER_KEY_URL`은 `http://service-a:3001/api/issuer-key`를 쓴다. 브라우저에 보내는 URL에는 Docker 서비스 이름을 사용하지 않는다.

## 코드와 저장 데이터

루트 npm workspaces가 공통 의존성을 설치하므로 루트 또는 각 서비스 디렉터리에서 `npm install`, `npm test`를 실행할 수 있다. `shared/`는 OIDC·세션·정규화·JSON 저장을 공유해 A와 B의 동작 차이를 줄인다. 서비스별 서명/검증 코드는 각 `src/`에 있다. 각 서비스의 `public/`는 정적으로 제공하며 `/`는 그 폴더의 `index.html`을 제공한다.

발급 개인키와 증명서는 A의 `data/`, 검증 기록은 B의 `data/`에 저장한다. 모두 gitignore 대상이다. JSON 저장과 MemoryStore 세션은 과제용 단일 프로세스를 전제로 한다. Node 프로세스를 재시작하면 로컬 로그인 세션은 사라지고 발급 키와 기록은 남는다. 로그인 세션은 ID 토큰 `exp`까지만 유효하며 자동 갱신은 하지 않는다.

## 실행 확인

```sh
curl -fsS http://localhost:8080/realms/crypto-sso/.well-known/openid-configuration
curl -fsS http://localhost:8080/realms/crypto-sso/protocol/openid-connect/certs
curl -i http://localhost:3001/api/me
curl -i http://localhost:3002/api/me
curl -I http://localhost:3001/login
curl -I http://localhost:3002/login
curl -fsS http://localhost:3001/api/issuer-key
```

미인증 `/api/me`는 401 JSON, `/login`은 S256 PKCE 매개변수를 포함한 302여야 한다. 실제 브라우저에서 A 로그인 → B 로그인 시 `session.authTime`이 같고 `loginAt`은 다름을 확인한다. 로그아웃 후 양쪽 `/api/me`가 401인지도 확인한다.

참고: [Keycloak 배포](https://www.keycloak.org/downloads), [realm import](https://www.keycloak.org/server/importExport), [컨테이너 healthcheck](https://www.keycloak.org/observability/health).
