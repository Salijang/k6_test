# Monitoring

Prometheus와 Grafana를 k6 결과 확인용으로 분리해서 띄우는 설정이다.

## Start

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

기본 포트:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000`

기본 계정:

- ID: `admin`
- PW: `admin`

## Run k6 with remote write

```bash
bash tests/performance/run-with-prometheus.sh tests/performance/k6/product-list-read.js
```

기본으로 아래 값이 설정된다.

- `K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write`
- `K6_PROMETHEUS_RW_TREND_STATS=p(90),p(95),avg,min,max`
- `K6_PROMETHEUS_RW_STALE_MARKERS=true`
- `testid=<timestamp>`

참고: 현재 샘플 k6 스크립트 다수는 `options.scenarios` 를 직접 정의하고 있어서 `--vus`, `--duration` 같은 CLI 플래그가 기대대로 덮어쓰지 않을 수 있다.

## Full stack with monitoring

앱 전체 스택과 같이 띄우려면 compose 파일을 같이 넘기면 된다.

```bash
docker compose -f docker-compose.stack.yml -f docker-compose.monitoring.yml up --build -d
```
