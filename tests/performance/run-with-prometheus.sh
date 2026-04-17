#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash tests/performance/run-with-prometheus.sh <script.js> [k6 options]"
  exit 1
fi

SCRIPT_PATH="$1"
shift

if [ ! -f "$SCRIPT_PATH" ]; then
  echo "k6 script not found: $SCRIPT_PATH"
  exit 1
fi

TEST_ID="${K6_TESTID:-$(date +%Y%m%d-%H%M%S)}"

export K6_PROMETHEUS_RW_SERVER_URL="${K6_PROMETHEUS_RW_SERVER_URL:-http://localhost:9090/api/v1/write}"
export K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM="${K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM:-false}"
export K6_PROMETHEUS_RW_TREND_STATS="${K6_PROMETHEUS_RW_TREND_STATS:-p(90),p(95),avg,min,max}"
export K6_PROMETHEUS_RW_STALE_MARKERS="${K6_PROMETHEUS_RW_STALE_MARKERS:-true}"

echo "Prometheus remote write: ${K6_PROMETHEUS_RW_SERVER_URL}"
echo "k6 testid: ${TEST_ID}"
echo "Trend stats: ${K6_PROMETHEUS_RW_TREND_STATS}"

exec k6 run -o experimental-prometheus-rw --tag "testid=${TEST_ID}" "$@" "$SCRIPT_PATH"
