#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "${ROOT_DIR}"

docker compose \
  -f docker-compose.stack.yml \
  -f docker-compose.monitoring.yml \
  -f docker-compose.capacity.yml \
  down
