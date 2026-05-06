# Sallijang Dev Test Plan

작성일: 2026-05-05 KST

## 목적

dev 환경에서 k6 테스트와 모니터링 연결을 순서대로 검증한다.

대상:

- API: `https://api.sallijang.shop`
- EKS: `pickup-dev-eks-cluster`
- 주요 서비스: `user`, `product`, `order`, `notify`
- 모니터링: `kube-prometheus-stack`, Grafana, Prometheus

현재 주의:

- 2026-05-05 기준 ALB 인증서가 `api.sallijang.shop`를 커버하지 않으므로 외부 k6 실행에는 임시로 `--insecure-skip-tls-verify`가 필요하다.
- capacity 판정용 k6는 시간이 안정적인 runner에서 실행한다. WSL/로컬 runner에서 wall-clock jump가 발생하면 k6 request timeout이 가짜로 늘어날 수 있다.

## 전체 순서

1. 라우팅 상태 확인
2. 읽기 smoke 테스트
3. 테스트 계정과 store 준비
4. 쓰기/주문 smoke 테스트
5. 낮은 부하 기준선 측정
6. 단계별 부하로 한계 구간 확인
7. spike/soak 테스트
8. 모니터링 대시보드와 지표 정리
9. 결과 보고서 작성

처음부터 stress를 치지 않는다. dev에서는 `smoke -> 낮은 load -> step load -> spike/soak -> stress` 순서로 올린다.

## 1. 라우팅 상태 확인

목적:

- ALB, nginx ingress, backend service 라우팅이 살아있는지 확인한다.
- nginx `404`와 앱 레벨 `401`을 구분한다.

명령:

```bash
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/health
curl -sk -w '\n%{http_code} %{content_type}\n' 'https://api.sallijang.shop/api/v1/products/?limit=1&offset=0'
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/api/v1/auth/me
```

성공 기준:

- `/health` -> `200 text/plain`
- `/api/v1/products/` -> `200 application/json`
- 인증 필요한 API -> `401 application/json`
- nginx HTML `404`가 나오면 테스트 중단 후 Ingress부터 확인한다.

자세한 복구 절차는 [DEV_API_ROUTING_RUNBOOK.md](/home/system/workspace/k6testDemo/tests/performance/k6/sallijang/DEV_API_ROUTING_RUNBOOK.md)를 따른다.

## 2. 읽기 Smoke

목적:

- k6가 dev API에 붙는지 확인한다.
- 상품 목록 조회가 정상인지 확인한다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/smoke.js
```

성공 기준:

- checks `100%`
- `http_req_failed` `0%`
- `product list returns 200` 통과

## 3. 테스트 계정과 Store 준비

목적:

- 상품 생성, 주문 생성 테스트에 필요한 seller/buyer token과 store id를 만든다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
bash tests/performance/prepare-sallijang-test-env.sh
```

생성되는 값:

- `K6_STORE_ID`
- `K6_STORE_NAME`
- `K6_SELLER_ACCESS_TOKEN`
- `K6_BUYER_ACCESS_TOKEN`

주의:

- backend는 JWT를 `Authorization` 헤더가 아니라 `access_token` cookie에서 읽는다.
- 상품 생성/삭제는 store owner seller token이 필요하다.
- 주문 생성의 buyer id는 body가 아니라 buyer token에서 결정된다.

생성된 env 파일은 이후 쓰기/주문 테스트 전에 source 한다.

```bash
. tests/performance/results/prepare-YYYYMMDDHHMMSS/sallijang-k6.env
```

## 4. 쓰기/주문 Smoke

목적:

- seller token으로 상품 생성이 되는지 확인한다.
- buyer token으로 주문 생성 라우팅과 인증이 통과하는지 확인한다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_SMOKE_WRITE=1 \
K6_STORE_ID=1 \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/smoke.js
```

주문까지 확인:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_SMOKE_WRITE=1 \
K6_SMOKE_ORDER=1 \
K6_STORE_ID=1 \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/smoke.js
```

성공 기준:

- write smoke checks 통과
- 주문 요청이 `401`, `403`, nginx `404`로 실패하지 않아야 한다.

## 5. 낮은 부하 기준선

목적:

- dev 환경의 정상 상태 p95, 실패율, 처리량 기준선을 잡는다.
- 이 단계 결과를 이후 step/spike와 비교한다.

읽기 load:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_READ_RATE=5 \
K6_READ_DURATION=1m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/product-list-load.js
```

주문 load:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_STORE_ID=1 \
K6_ORDER_RATE=2 \
K6_ORDER_DURATION=1m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/order-create-load.js
```

성공 기준:

- `http_req_failed` 거의 `0%`
- p95가 급격히 튀지 않아야 한다.
- pod restart가 없어야 한다.

## 6. 단계별 부하

목적:

- 어느 RPS 구간부터 latency/error가 증가하는지 확인한다.
- HPA가 있으면 replica 증가 타이밍을 본다.
- HPA가 없으면 pod CPU/memory 상승 구간을 기록한다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_STEP_TARGETS=2,5,10 \
K6_STEP_HOLD_DURATION=1m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/product-list-step-load.js
```

관찰:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl get hpa,pods -n default -w
```

성공 기준:

- 어느 단계까지 안정적인지 수치로 남긴다.
- 실패율이 증가하는 첫 RPS를 기록한다.
- replica 변화가 있으면 변화 시각과 RPS를 기록한다.
- k6 실행 중 runner 시간이 튀었으면 capacity 결과로 쓰지 않는다. 성공 응답 p95, ingress 로그, 별도 curl, pod CPU를 같이 확인해서 runner 문제와 API 문제를 분리한다.

## 7. Spike와 Soak

Spike 목적:

- 갑작스런 트래픽 증가 후 회복되는지 본다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_SPIKE_BASE_RATE=2 \
K6_SPIKE_RATE=15 \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/product-list-spike.js
```

Soak 목적:

- 장시간 실행 중 memory, DB connection, error 누적을 본다.

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_STORE_ID=1 \
K6_SOAK_VUS=2 \
K6_SOAK_DURATION=10m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/buyer-journey-soak.js
```

dev에서는 처음부터 긴 soak를 돌리지 않는다. `10m` 통과 후 팀 합의로 `30m` 이상을 진행한다.

## 8. 모니터링 연결

목적:

- k6 실행 시점과 EKS 지표를 같이 본다.
- API latency, error, pod CPU/memory, restart, replica 변화를 묶어서 기록한다.

Grafana port-forward:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl port-forward svc/kube-prometheus-stack-grafana 3000:80 -n default
```

Prometheus port-forward:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl port-forward svc/kube-prometheus-stack-prometheus 9090:9090 -n default
```

확인할 지표:

- k6: request rate, p95/p99 latency, failed request rate
- Kubernetes: pod CPU, memory, restart count
- Deployment: desired/available replicas
- Ingress/nginx: 4xx/5xx rate
- DB/Redis 연동 시: connection, timeout, slow query 증상

## 9. 결과 정리

각 실행마다 아래 값을 남긴다.

- 실행 일시
- script
- `K6_BASE_URL`
- 주요 env 값
- 평균 latency, p95, p99
- 실패율
- 최고 RPS 또는 VUs
- pod replica 변화
- pod restart 여부
- 에러 응답 예시
- 병목 추정

결론은 다음처럼 정리한다.

- 안정 구간: 예) `read 10 RPS까지 p95 300ms 이하, fail 0%`
- 경계 구간: 예) `read 20 RPS부터 p95 1s 초과`
- 장애 구간: 예) `read 40 RPS에서 5xx 발생`
- 다음 조치: HPA 추가, resource request/limit 조정, DB pool 조정 등
