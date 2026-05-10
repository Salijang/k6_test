#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF_DIR="${ROOT_DIR}/tests/performance"
RUNNER="${PERF_DIR}/run-with-prometheus.sh"

RUN_ID="${RUN_ID:-sallijang-$(date +%Y%m%d-%H%M%S)}"
RESULTS_DIR="${RESULTS_DIR:-${PERF_DIR}/results/${RUN_ID}}"
USE_PROMETHEUS="${K6_USE_PROMETHEUS:-1}"
RUN_ORDER_LOAD="${K6_RUN_ORDER_LOAD:-0}"
RUN_HOT_ORDER="${K6_RUN_HOT_ORDER:-0}"
RUN_STEP_LOAD="${K6_RUN_STEP_LOAD:-0}"
RUN_SPIKE="${K6_RUN_SPIKE:-0}"
RUN_SOAK="${K6_RUN_SOAK:-0}"

SCENARIOS=(
  "smoke:tests/performance/k6/sallijang/smoke.js"
  "product-list-load:tests/performance/k6/sallijang/product-list-load.js"
)

if [[ "${RUN_ORDER_LOAD}" == "1" ]]; then
  SCENARIOS+=("order-create-load:tests/performance/k6/sallijang/order-create-load.js")
fi

if [[ "${RUN_HOT_ORDER}" == "1" ]]; then
  SCENARIOS+=("order-hot-product-race:tests/performance/k6/sallijang/order-hot-product-race.js")
fi

if [[ "${RUN_STEP_LOAD}" == "1" ]]; then
  SCENARIOS+=("product-list-step-load:tests/performance/k6/sallijang/product-list-step-load.js")
fi

if [[ "${RUN_SPIKE}" == "1" ]]; then
  SCENARIOS+=("product-list-spike:tests/performance/k6/sallijang/product-list-spike.js")
fi

if [[ "${RUN_SOAK}" == "1" ]]; then
  SCENARIOS+=("buyer-journey-soak:tests/performance/k6/sallijang/buyer-journey-soak.js")
fi

mkdir -p "${RESULTS_DIR}"

echo "Run ID: ${RUN_ID}"
echo "Results directory: ${RESULTS_DIR}"
echo "Product base URL: ${K6_BASE_URL_PRODUCT:-${K6_BASE_URL:-http://product-service}}"
echo "Order base URL: ${K6_BASE_URL_ORDER:-${K6_BASE_URL:-http://order-service}}"
echo "Prometheus remote write: ${USE_PROMETHEUS}"
echo "Optional scenarios: order=${RUN_ORDER_LOAD}, hot-order=${RUN_HOT_ORDER}, step=${RUN_STEP_LOAD}, spike=${RUN_SPIKE}, soak=${RUN_SOAK}"
echo

for entry in "${SCENARIOS[@]}"; do
  name="${entry%%:*}"
  script_path="${entry#*:}"
  log_path="${RESULTS_DIR}/${name}.log"
  test_id="${RUN_ID}-${name}"

  echo "=== ${name} ==="
  echo "script: ${script_path}"
  echo "testid: ${test_id}"
  echo "log: ${log_path}"

  if [[ "${USE_PROMETHEUS}" == "1" ]]; then
    (
      cd "${ROOT_DIR}"
      K6_TESTID="${test_id}" bash "${RUNNER}" "${script_path}"
    ) 2>&1 | tee "${log_path}"
  else
    (
      cd "${ROOT_DIR}"
      K6_TESTID="${test_id}" k6 run --tag "testid=${test_id}" "${script_path}"
    ) 2>&1 | tee "${log_path}"
  fi

  echo
done

echo "Completed Sallijang scenarios."
echo "Logs saved under: ${RESULTS_DIR}"
