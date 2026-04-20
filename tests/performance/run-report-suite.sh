#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF_DIR="${ROOT_DIR}/tests/performance"
RUNNER="${PERF_DIR}/run-with-prometheus.sh"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RESULTS_DIR="${RESULTS_DIR:-${PERF_DIR}/results/${RUN_ID}}"
K6_BASE_URL="${K6_BASE_URL:-http://localhost:4000}"

SCENARIOS=(
  "product-list-read:tests/performance/k6/product-list-read.js"
  "product-registration-burst:tests/performance/k6/product-registration-burst.js"
  "hot-slot-race:tests/performance/k6/hot-slot-race.js"
  "cancel-and-rereserve:tests/performance/k6/cancel-and-rereserve.js"
)

mkdir -p "${RESULTS_DIR}"

echo "Run ID: ${RUN_ID}"
echo "Results directory: ${RESULTS_DIR}"
echo "Base URL: ${K6_BASE_URL}"
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

  (
    cd "${ROOT_DIR}"
    K6_BASE_URL="${K6_BASE_URL}" \
    K6_TESTID="${test_id}" \
    bash "${RUNNER}" "${script_path}"
  ) 2>&1 | tee "${log_path}"

  echo
done

echo "Completed all scenarios."
echo "Logs saved under: ${RESULTS_DIR}"
echo "Use each testid in Grafana to filter the dashboard:"
for entry in "${SCENARIOS[@]}"; do
  name="${entry%%:*}"
  echo "- ${RUN_ID}-${name}"
done
