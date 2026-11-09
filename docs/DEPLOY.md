# VPS 배포 (Vultr + Cloudflare + Caddy)

운영 구성은 `deploy/compose.prod.yml` 하나로 띄운다.

```
인터넷 ──443──▶ Caddy ─┬─▶ idp.ericshim.me     → Keycloak (운영 모드, Postgres)
                      ├─▶ sign.ericshim.me    → 서비스 A (서명 발급소)
                      └─▶ verify.ericshim.me  → 서비스 B (서명 검증소)

Keycloak ──(docker 내부망)──▶ service-a/b:/backchannel-logout
서비스 B ──(docker 내부망)──▶ service-a:/api/issuer-key
관리 콘솔: 인터넷에서는 404. SSH 터널로 127.0.0.1:8080 에만 열림
```

## 1. 준비물

- Vultr 인스턴스: Ubuntu 24.04, RAM 2GB 이상 권장(1GB면 swap 2GB 추가)
- Cloudflare DNS의 A 레코드 3개, 모두 VPS 공인 IP로. **프록시는 끈다(회색 구름, DNS only).**
  Caddy가 Let's Encrypt 인증서를 직접 받아야 하기 때문이다.

  | 이름 | 값 |
  |---|---|
  | `idp` | VPS IP |
  | `sign` | VPS IP |
  | `verify` | VPS IP |

- 방화벽(Vultr Firewall 또는 ufw): 22, 80, 443/tcp, 443/udp만 연다.

## 2. 서버 초기 설정 (한 번만)

```bash
# Docker 설치 (공식 스크립트)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 다시 로그인해야 적용

# 방화벽
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable

# 1GB 서버라면 swap
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. 배포

```bash
git clone https://github.com/kr-ericshim/keycloak-ecdsa-sso.git
cd keycloak-ecdsa-sso
deploy/gen-env.sh ericshim.me 내이메일@example.com   # deploy/production.env 생성 (비밀값 무작위)
docker compose -f deploy/compose.prod.yml --env-file deploy/production.env up -d --build --wait
```

그다음 관리 콘솔이 SSH 터널에서만 로그인되도록 master realm 주소를 고정한다(한 번만).

```bash
deploy/admin-console-setup.sh
```

첫 기동은 Keycloak 빌드와 realm import 때문에 2~3분 걸린다. 인증서는 첫 HTTPS 요청 때 Caddy가 발급받는다.

시연 계정 비밀번호는 `deploy/production.env`의 `DEMO_ALICE_PASSWORD`, `DEMO_BOB_PASSWORD`이다. 발표 자료에 적어 교수님께 공유한다.

## 4. 확인

```bash
curl -I https://sign.ericshim.me            # 200
curl -I https://idp.ericshim.me/admin/      # 404 (관리 콘솔 차단)
curl -s https://idp.ericshim.me/realms/crypto-sso/protocol/openid-connect/certs   # EC P-256 키
```

브라우저: sign.ericshim.me 로그인 → "검증소에서 확인" → verify.ericshim.me 에 비밀번호 없이 진입 → 로그아웃 후 sign 재접속 시 로그인 요구.

## 5. 관리 콘솔 (SSH 터널)

```bash
ssh -L 8080:localhost:8080 <vps>
# 로컬 브라우저에서 http://localhost:8080/admin  (계정: production.env 의 KC_ADMIN_*)
# admin-console-setup.sh 를 실행하지 않았다면 로그인 단계에서 공개 도메인으로 넘어가 404가 난다.
```

Termius를 쓰면 Port Forwarding에서 Local 8080 → localhost:8080 규칙을 만들면 된다.

## 6. 업데이트와 백업

```bash
git pull
docker compose -f deploy/compose.prod.yml --env-file deploy/production.env up -d --build --wait
```

- realm JSON은 **처음 기동할 때만** import된다. 이후 realm 설정을 바꾸려면 관리 콘솔에서 고치거나, 데이터를 지우고 다시 import한다(`down -v`는 사용자와 발급 키를 모두 지우니 주의).
- 지켜야 할 데이터: `postgres-data`(Keycloak), `service-a-data`(발급소 개인키와 증명서), `deploy/production.env`.

## 7. 로컬 리허설

같은 구성을 `*.localhost` 도메인과 HTTP로 미리 돌려 볼 수 있다.

```bash
docker compose stop keycloak                 # 개발용 Keycloak과 포트(8080)가 겹침
deploy/gen-env.sh localhost
docker compose -f deploy/compose.prod.yml --env-file deploy/production.env up -d --build --wait
# http://sign.localhost , http://verify.localhost , http://idp.localhost
```

실제 배포 전에 `deploy/production.env`를 지우고 도메인으로 다시 만든다.

## 8. 기존 Nginx Proxy Manager가 있는 서버 (현재 Vultr VPS)

이 VPS는 80·443을 Nginx Proxy Manager(NPM)가 쓰고 있어서 Caddy 대신 NPM을 앞단으로 쓴다. 구성 파일은 `deploy/compose.npm.yml`이다.

```bash
deploy/gen-env.sh ericshim.me 내이메일@example.com
docker compose -f deploy/compose.npm.yml --env-file deploy/production.env up -d --build --wait
deploy/admin-console-setup.sh compose.npm.yml
```

- Keycloak 힙은 320MB로 고정했다(`KC_HEAP_OPTS_NPM`). 1코어·1GB 서버라 첫 기동에 몇 분 걸린다.
- 관리 콘솔은 `ssh -L 18080:localhost:18080 vultr-sso` 후 http://localhost:18080/admin

NPM 관리 화면(81번 포트, 외부 차단)은 `ssh -L 8181:localhost:81 vultr-sso` 후 http://localhost:8181 에서 연다. 프록시 호스트 3개를 만든다.

| Domain | Forward Hostname / Port | 옵션 |
|---|---|---|
| idp.ericshim.me | `sso-keycloak` / `8080` | SSL: Let's Encrypt 새 인증서, Force SSL, HTTP/2 |
| sign.ericshim.me | `sso-sign` / `3001` | 위와 같음 |
| verify.ericshim.me | `sso-verify` / `3002` | 위와 같음 |

idp 호스트의 Advanced 탭에는 관리 경로 차단을 넣는다.

```nginx
location ~ ^/(admin|realms/master)(/|$) { return 404; }
```
