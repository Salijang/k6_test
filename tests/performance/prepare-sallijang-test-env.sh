#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${K6_BASE_URL:-https://api.sallijang.shop}"
RUN_PREFIX="${K6_RUN_PREFIX:-$(date +%Y%m%d%H%M%S)}"
PASSWORD="${K6_TEST_PASSWORD:-Loadtest123!}"

SELLER_EMAIL="${K6_TEST_SELLER_EMAIL:-k6-seller-${RUN_PREFIX}@sallijang.shop}"
BUYER_EMAIL="${K6_TEST_BUYER_EMAIL:-k6-buyer-${RUN_PREFIX}@sallijang.shop}"
SELLER_NAME="${K6_TEST_SELLER_NAME:-k6 seller ${RUN_PREFIX}}"
BUYER_NAME="${K6_TEST_BUYER_NAME:-k6 buyer ${RUN_PREFIX}}"
STORE_NAME="${K6_STORE_NAME:-K6 Test Store ${RUN_PREFIX}}"

WORK_DIR="${K6_PREPARE_WORK_DIR:-tests/performance/results/prepare-${RUN_PREFIX}}"
mkdir -p "${WORK_DIR}"

seller_cookie="${WORK_DIR}/seller.cookie"
buyer_cookie="${WORK_DIR}/buyer.cookie"
env_file="${WORK_DIR}/sallijang-k6.env"

signup() {
  local email="$1"
  local name="$2"
  local role="$3"

  local status
  status="$(
    curl -k -sS -o "${WORK_DIR}/signup-${role}.json" -w "%{http_code}" \
      -X POST "${BASE_URL}/api/v1/auth/signup" \
      -H "Content-Type: application/json" \
      --data "$(printf '{"email":"%s","full_name":"%s","role":"%s","password":"%s"}' "${email}" "${name}" "${role}" "${PASSWORD}")"
  )"

  if [[ "${status}" != "201" && "${status}" != "400" ]]; then
    echo "signup ${role} failed: HTTP ${status}" >&2
    cat "${WORK_DIR}/signup-${role}.json" >&2
    exit 1
  fi
}

login() {
  local email="$1"
  local cookie_file="$2"
  local role="$3"

  local status
  status="$(
    curl -k -sS -o "${WORK_DIR}/login-${role}.json" -w "%{http_code}" \
      -c "${cookie_file}" \
      -X POST "${BASE_URL}/api/v1/auth/login" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "username=${email}" \
      --data-urlencode "password=${PASSWORD}"
  )"

  if [[ "${status}" != "200" ]]; then
    echo "login ${role} failed: HTTP ${status}" >&2
    cat "${WORK_DIR}/login-${role}.json" >&2
    exit 1
  fi
}

cookie_token() {
  local cookie_file="$1"
  awk '$6 == "access_token" { print $7 }' "${cookie_file}" | tail -n 1
}

create_store() {
  local status
  status="$(
    curl -k -sS -o "${WORK_DIR}/store.json" -w "%{http_code}" \
      -b "${seller_cookie}" \
      -X POST "${BASE_URL}/api/v1/stores/" \
      -H "Content-Type: application/json" \
      --data "$(printf '{"name":"%s","latitude":37.5665,"longitude":126.9780,"address":"서울특별시 중구 세종대로 110","address_detail":"k6"}' "${STORE_NAME}")"
  )"

  if [[ "${status}" != "201" ]]; then
    echo "create store failed: HTTP ${status}" >&2
    cat "${WORK_DIR}/store.json" >&2
    exit 1
  fi
}

json_number_field() {
  local file="$1"
  local field="$2"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(data[process.argv[2]] ?? '')" "${file}" "${field}"
}

echo "Preparing Sallijang k6 users against ${BASE_URL}"

signup "${SELLER_EMAIL}" "${SELLER_NAME}" "seller"
signup "${BUYER_EMAIL}" "${BUYER_NAME}" "buyer"
login "${SELLER_EMAIL}" "${seller_cookie}" "seller"
login "${BUYER_EMAIL}" "${buyer_cookie}" "buyer"
create_store

seller_token="$(cookie_token "${seller_cookie}")"
buyer_token="$(cookie_token "${buyer_cookie}")"
store_id="$(json_number_field "${WORK_DIR}/store.json" "id")"

cat > "${env_file}" <<EOF
export K6_BASE_URL="${BASE_URL}"
export K6_STORE_ID="${store_id}"
export K6_STORE_NAME="${STORE_NAME}"
export K6_SELLER_ACCESS_TOKEN="${seller_token}"
export K6_BUYER_ACCESS_TOKEN="${buyer_token}"
EOF

echo "Prepared test env:"
echo "  seller: ${SELLER_EMAIL}"
echo "  buyer:  ${BUYER_EMAIL}"
echo "  store:  ${store_id}"
echo "  env:    ${env_file}"
echo
echo "Run:"
echo "  source ${env_file}"
echo "  K6_USE_PROMETHEUS=0 bash tests/performance/run-sallijang-suite.sh"
