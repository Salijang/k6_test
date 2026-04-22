#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "${ROOT_DIR}"

COMPOSE_ARGS=(
  -f docker-compose.stack.yml
  -f docker-compose.monitoring.yml
  -f docker-compose.capacity.yml
)

if [[ "${RESET_STACK_DATA:-0}" == "1" ]]; then
  echo "Resetting constrained stack volumes before startup..."
  docker compose "${COMPOSE_ARGS[@]}" down -v
fi

docker compose "${COMPOSE_ARGS[@]}" up --build -d

echo
echo "Constrained stack is up."
echo "Web: http://localhost:${WEB_PORT:-18080}"
echo "API: http://localhost:${API_PORT:-14000}"
echo "PostgreSQL: localhost:${POSTGRES_PORT:-15432}"
echo "Grafana: http://localhost:${GRAFANA_PORT:-3000}"
echo "Prometheus: http://localhost:${PROMETHEUS_PORT:-9090}"
echo
echo "Applied limits:"
echo "- API: cpus=${API_CPUS:-1.0}, mem=${API_MEM_LIMIT:-768m}"
echo "- PostgreSQL: cpus=${POSTGRES_CPUS:-1.0}, mem=${POSTGRES_MEM_LIMIT:-1024m}"
echo "- Web: cpus=${WEB_CPUS:-0.5}, mem=${WEB_MEM_LIMIT:-256m}"
echo "- Prometheus: cpus=${PROMETHEUS_CPUS:-0.5}, mem=${PROMETHEUS_MEM_LIMIT:-512m}"
echo "- Grafana: cpus=${GRAFANA_CPUS:-0.5}, mem=${GRAFANA_MEM_LIMIT:-384m}"
echo
echo "Run k6 from the host to avoid consuming the constrained app resources."
echo "Example:"
echo "K6_BASE_URL=http://localhost:${API_PORT:-14000} bash tests/performance/run-capacity-report.sh"
