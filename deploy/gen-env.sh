#!/usr/bin/env bash
# 사용법: deploy/gen-env.sh <기본도메인> <ACME 이메일>
#   예) deploy/gen-env.sh ericshim.me you@example.com   → idp/sign/verify.ericshim.me, HTTPS
#       deploy/gen-env.sh localhost                     → idp/sign/verify.localhost, HTTP (로컬 리허설)
# 이미 production.env 가 있으면 덮어쓰지 않는다.
set -euo pipefail
cd "$(dirname "$0")"
domain="${1:?기본 도메인을 넣으세요 (예: ericshim.me)}"
email="${2:-admin@example.invalid}"
out="production.env"
[ -e "$out" ] && { echo "$out 이 이미 있습니다. 지우고 다시 실행하세요."; exit 1; }

secret() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"${1:-40}"; }

if [ "$domain" = "localhost" ]; then scheme="http"; site_prefix="http://"; else scheme="https"; site_prefix=""; fi

umask 077
cat > "$out" <<ENV
IDP_SITE=${site_prefix}idp.${domain}
SIGN_SITE=${site_prefix}sign.${domain}
VERIFY_SITE=${site_prefix}verify.${domain}
ACME_EMAIL=${email}
KEYCLOAK_PUBLIC_URL=${scheme}://idp.${domain}
SERVICE_A_BASE_URL=${scheme}://sign.${domain}
SERVICE_B_BASE_URL=${scheme}://verify.${domain}
POSTGRES_PASSWORD=$(secret)
KC_ADMIN_USERNAME=admin
KC_ADMIN_PASSWORD=$(secret 24)
SERVICE_A_CLIENT_SECRET=$(secret)
SERVICE_B_CLIENT_SECRET=$(secret)
SERVICE_A_SESSION_SECRET=$(secret 64)
SERVICE_B_SESSION_SECRET=$(secret 64)
DEMO_ALICE_PASSWORD=$(secret 12)
DEMO_BOB_PASSWORD=$(secret 12)
KC_HEAP_OPTS=-XX:MaxRAMPercentage=50
ENV
echo "$out 을 만들었습니다 (권한 600). 시연 계정 비밀번호는 이 파일의 DEMO_* 값입니다."
