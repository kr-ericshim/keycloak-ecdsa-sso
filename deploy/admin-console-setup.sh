#!/usr/bin/env bash
# 관리 콘솔을 SSH 터널(http://localhost:8080)에서만 쓰도록 master realm 의 프론트엔드 주소를 고정한다.
# 공개 도메인의 /admin, /realms/master 는 Caddy 가 404 로 막으므로, 이 설정이 없으면 콘솔 로그인이 끝나지 않는다.
# 첫 배포 후 한 번 실행한다:  deploy/admin-console-setup.sh
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./production.env; set +a
dc() { docker compose -f compose.prod.yml --env-file production.env "$@"; }
dc exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --config /tmp/kcadm.config --server http://localhost:8080 --realm master \
  --user "${KC_ADMIN_USERNAME:-admin}" --password "$KC_ADMIN_PASSWORD"
dc exec -T keycloak /opt/keycloak/bin/kcadm.sh update realms/master \
  --config /tmp/kcadm.config -s 'attributes.frontendUrl=http://localhost:8080'
dc exec -T keycloak rm -f /tmp/kcadm.config
echo "완료: SSH 터널을 연 뒤 http://localhost:8080/admin 으로 접속하세요."
