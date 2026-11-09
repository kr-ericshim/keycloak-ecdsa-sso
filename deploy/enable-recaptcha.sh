#!/usr/bin/env bash
# 회원가입 흐름의 reCAPTCHA 단계를 켜고 키를 넣는다. realm 을 import 한 뒤 한 번 실행한다(다시 실행해도 된다).
# 사용법: deploy/enable-recaptcha.sh <compose 파일> <env 파일>
#   운영: deploy/enable-recaptcha.sh deploy/compose.npm.yml deploy/production.env
#   로컬: deploy/enable-recaptcha.sh docker-compose.yml .env
# env 파일에 RECAPTCHA_SITE_KEY, RECAPTCHA_SECRET 이 있어야 한다. 관리자 계정은
# KC_ADMIN_USERNAME/KC_ADMIN_PASSWORD(운영) 또는 KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD(로컬)에서 읽는다.
# 비밀 키는 git 에 넣지 않는다. Keycloak DB 에만 저장된다.
set -euo pipefail
compose_file="${1:?compose 파일을 넣으세요}"
env_file="${2:?env 파일을 넣으세요}"
set -a; . "$env_file"; set +a
: "${RECAPTCHA_SITE_KEY:?$env_file 에 RECAPTCHA_SITE_KEY 가 필요합니다}"
: "${RECAPTCHA_SECRET:?$env_file 에 RECAPTCHA_SECRET 이 필요합니다}"
admin_user="${KC_ADMIN_USERNAME:-${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}}"
admin_pass="${KC_ADMIN_PASSWORD:-${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin-dev-password}}"

kc() {
  docker compose -f "$compose_file" --env-file "$env_file" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/kcadm.cfg
}
cleanup() { docker compose -f "$compose_file" --env-file "$env_file" exec -T keycloak rm -f /tmp/kcadm.cfg >/dev/null 2>&1 || true; }
trap cleanup EXIT

kc config credentials --server http://localhost:8080 --realm master \
  --user "$admin_user" --password "$admin_pass" >/dev/null

# 기본 가입 흐름(registration)에서 reCAPTCHA 단계 찾기
read -r exec_id config_id < <(kc get authentication/flows/registration/executions -r crypto-sso | python3 -c '
import json, sys
for e in json.load(sys.stdin):
    if e.get("providerId") == "registration-recaptcha-action":
        print(e["id"], e.get("authenticationConfig", "-"))
        break
')
[ -n "${exec_id:-}" ] || { echo "registration 흐름에서 reCAPTCHA 단계를 찾지 못했습니다."; exit 1; }

# 1) 단계 켜기
kc update authentication/flows/registration/executions -r crypto-sso \
  -b "{\"id\":\"$exec_id\",\"requirement\":\"REQUIRED\"}"

# 2) 키 설정 (있으면 갱신, 없으면 생성)
config_body=$(python3 -c '
import json, os
print(json.dumps({"alias": "recaptcha", "config": {
    "site.key": os.environ["RECAPTCHA_SITE_KEY"], "secret.key": os.environ["RECAPTCHA_SECRET"],
    "action": "register", "useRecaptchaNet": "false", "recaptcha.v3": "false"}}))')
if [ "$config_id" != "-" ]; then
  kc update "authentication/config/$config_id" -r crypto-sso -b "$config_body"
else
  kc create "authentication/executions/$exec_id/config" -r crypto-sso -b "$config_body" >/dev/null
fi
echo "완료: 회원가입에 reCAPTCHA(v2 체크박스)를 켰습니다."
