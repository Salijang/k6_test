#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF_DIR="${ROOT_DIR}/tests/performance"
RUNNER="${PERF_DIR}/run-with-prometheus.sh"
SCRIPT_PATH="tests/performance/k6/product-list-capacity.js"

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RESULTS_DIR="${RESULTS_DIR:-${PERF_DIR}/results/${RUN_ID}}"
K6_BASE_URL="${K6_BASE_URL:-http://localhost:14000}"
TEST_ID="${K6_TESTID:-${RUN_ID}-product-list-capacity}"
LOG_PATH="${RESULTS_DIR}/product-list-capacity.log"

mkdir -p "${RESULTS_DIR}"

echo "Run ID: ${RUN_ID}"
echo "Results directory: ${RESULTS_DIR}"
echo "Test ID: ${TEST_ID}"
echo "Base URL: ${K6_BASE_URL}"
echo "Log: ${LOG_PATH}"
echo

(
  cd "${ROOT_DIR}"
  K6_BASE_URL="${K6_BASE_URL}" \
  K6_TESTID="${TEST_ID}" \
  bash "${RUNNER}" "${SCRIPT_PATH}"
) 2>&1 | tee "${LOG_PATH}"

echo
echo "Completed capacity scenario."
echo "Use testid=${TEST_ID} in Grafana filters."
