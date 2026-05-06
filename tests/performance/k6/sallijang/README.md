# Sallijang k6 Scenarios

Salijang 배포 환경이 생기면 `K6_BASE_URL` 계열 변수만 바꿔서 바로 실행하는 k6 시나리오 모음이다.

실제 백엔드 코드 기준 API 매핑은 [API_MAPPING.md](API_MAPPING.md)에 정리한다.
dev API 라우팅 장애 확인/복구 절차는 [DEV_API_ROUTING_RUNBOOK.md](DEV_API_ROUTING_RUNBOOK.md)에 정리한다.
dev 환경 테스트 진행 순서는 [DEV_TEST_PLAN.md](DEV_TEST_PLAN.md)에 정리한다.
EC2 k6 runner 운영 절차는 [EC2_K6_RUNNER_RUNBOOK.md](EC2_K6_RUNNER_RUNBOOK.md)에 정리한다.
2026-05-05 dev 인프라 상태 확인 결과는 [DEV_TEST_STATUS_2026-05-05.md](DEV_TEST_STATUS_2026-05-05.md)에 정리한다.

## Scripts

- `smoke.js`
  - 목적: product/order service URL, 선택 health endpoint, 상품 목록 조회, 선택 쓰기/주문 smoke 확인
  - 기본은 읽기만 수행한다.
- `product-list-load.js`
  - 목적: buyer 상품 목록 조회 API의 기본 처리량과 p95 응답시간 확인
  - 기본값: `20 RPS`, `2m`, `p95 < 800ms`
- `order-create-load.js`
  - 목적: 주문 생성 API의 정상 부하 기준 확인
  - 기본값: `10 RPS`, `2m`, `p95 < 1500ms`
  - 기본 동작은 setup에서 상품 pool을 만들고 teardown에서 soft delete 한다.
- `product-create-load.js`
  - 목적: 상품 생성 API의 쓰기 부하 기준 확인
  - 기본값: `5 RPS`, `1m`, `p95 < 2000ms`
  - 기본 동작은 상품 생성 후 같은 iteration에서 즉시 soft delete 한다.
- `product-list-step-load.js`
  - 목적: RPS를 단계적으로 올리며 수용 한계와 HPA 반응 구간을 관찰
  - 기본값: `5,10,20,40,80 RPS`, 각 단계 `30s ramp + 2m hold`
  - 기본은 threshold를 강제하지 않는다. `K6_ENFORCE_THRESHOLDS=1`일 때만 gate로 쓴다.
- `product-list-spike.js`
  - 목적: 평상시 트래픽에서 갑작스런 피크 후 회복 여부 확인
  - 기본값: `5 RPS -> 50 RPS -> 5 RPS`
- `buyer-journey-soak.js`
  - 목적: 오래 실행하면서 메모리/DB connection/에러율 누적 문제 확인
  - 기본값: `5 VUs`, `30m`, 조회 후 `20%` 확률로 주문 생성

한계 탐색용 stress 스크립트는 기존 파일을 쓴다.

- `tests/performance/k6/stress/product-list-read-stress.js`
- `tests/performance/k6/stress/product-remaining-race-stress.js`
- `tests/performance/k6/stress/order-create-stress.js`

## Required Env

외부 ALB/Ingress 하나로 product/order가 같이 라우팅되면 `K6_BASE_URL`만 넣어도 된다.

```bash
export K6_BASE_URL=https://api.sallijang.shop
```

2026-05-06 확인 기준 `api.sallijang.shop`는 wildcard 인증서로 TLS 검증이 정상 통과한다. 이전 dev 인증서 문제처럼 TLS 검증이 실패하는 임시 환경에서만 k6에 `--insecure-skip-tls-verify`를 붙인다.

capacity 판정용 실행은 시간이 안정적인 runner에서 수행한다. WSL/로컬 runner의 wall-clock jump가 있으면 k6가 정상 API 요청을 timeout으로 집계할 수 있다.

서비스별 host가 다르면 분리한다.

```bash
export K6_BASE_URL_PRODUCT=https://product-api.sallijang.shop
export K6_BASE_URL_ORDER=https://order-api.sallijang.shop
```

쓰기/주문 시나리오는 기존 store id가 필요하다.

```bash
export K6_STORE_ID=1
export K6_STORE_NAME="Stress Test Store"
```

실제 product/order 보호 API는 JWT를 `Authorization` 헤더가 아니라 `access_token` 쿠키에서 읽는다.

```bash
export K6_ACCESS_TOKEN="..."
```

권한 모델을 실제에 가깝게 타려면 seller/buyer token을 분리한다.

```bash
export K6_SELLER_ACCESS_TOKEN="seller-token"
export K6_BUYER_ACCESS_TOKEN="buyer-token"
```

buyer token을 여러 개 분산하려면:

```bash
export K6_BUYER_ACCESS_TOKENS="buyer-token1,buyer-token2,buyer-token3"
```

커스텀 인증 헤더가 필요한 임시 환경이면 아래도 사용할 수 있다.

```bash
export K6_AUTH_HEADER_NAME="x-user-id"
export K6_AUTH_HEADER_VALUE="..."
```

주의: 상품 생성/삭제는 store owner 검사를 하므로 `K6_STORE_ID`의 owner seller token이 필요하다. 주문 생성의 buyer id는 request body가 아니라 JWT에서 결정된다.

## Run

AWS EC2 k6 runner에서 실행할 때는 로컬 파일을 직접 복사하지 않는다.
로컬에서 수정한 스크립트를 `Salijang/k6_test`에 push한 뒤 runner가 GitHub에서 pull해서 실행한다.
자세한 절차는 [EC2_K6_RUNNER_RUNBOOK.md](EC2_K6_RUNNER_RUNBOOK.md)를 따른다.

테스트 계정과 store를 새로 만들 수 있는 환경이면 먼저 준비 스크립트를 실행한다.

```bash
K6_BASE_URL=https://api.sallijang.shop \
bash tests/performance/prepare-sallijang-test-env.sh
```

스크립트는 seller/buyer 가입, 로그인, store 생성 후 `source` 가능한 env 파일 경로를 출력한다.

읽기 smoke:

```bash
k6 run tests/performance/k6/sallijang/smoke.js
```

상품 생성까지 확인:

```bash
K6_SMOKE_WRITE=1 K6_STORE_ID=1 k6 run tests/performance/k6/sallijang/smoke.js
```

주문 생성까지 확인:

```bash
K6_SMOKE_WRITE=1 K6_SMOKE_ORDER=1 K6_STORE_ID=1 k6 run tests/performance/k6/sallijang/smoke.js
```

기본 조회 load:

```bash
K6_READ_RATE=20 K6_READ_DURATION=2m k6 run tests/performance/k6/sallijang/product-list-load.js
```

기본 주문 load:

```bash
K6_STORE_ID=1 K6_ORDER_RATE=10 K6_ORDER_DURATION=2m k6 run tests/performance/k6/sallijang/order-create-load.js
```

기본 상품 생성/삭제 load:

```bash
K6_STORE_ID=1 K6_PRODUCT_CREATE_RATE=5 K6_PRODUCT_CREATE_DURATION=1m \
k6 run tests/performance/k6/sallijang/product-create-load.js
```

단계별 capacity/HPA 관찰:

```bash
K6_STEP_TARGETS=5,10,20,40,80 \
k6 run tests/performance/k6/sallijang/product-list-step-load.js
```

spike:

```bash
K6_SPIKE_BASE_RATE=5 K6_SPIKE_RATE=50 \
k6 run tests/performance/k6/sallijang/product-list-spike.js
```

soak:

```bash
K6_STORE_ID=1 K6_SOAK_VUS=5 K6_SOAK_DURATION=30m \
k6 run tests/performance/k6/sallijang/buyer-journey-soak.js
```

Prometheus remote write로 보낼 때:

```bash
K6_TESTID=sallijang-read-$(date +%Y%m%d-%H%M%S) \
bash tests/performance/run-with-prometheus.sh tests/performance/k6/sallijang/product-list-load.js
```

suite 실행:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_USE_PROMETHEUS=0 \
bash tests/performance/run-sallijang-suite.sh
```

선택 시나리오까지 포함:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_STORE_ID=1 \
K6_RUN_ORDER_LOAD=1 \
K6_RUN_STEP_LOAD=1 \
K6_RUN_SPIKE=1 \
K6_RUN_SOAK=1 \
K6_USE_PROMETHEUS=0 \
bash tests/performance/run-sallijang-suite.sh
```

## Safe Defaults For Dev

dev 환경에서는 아래처럼 낮게 시작한다.

```bash
K6_READ_RATE=5 K6_READ_DURATION=1m k6 run tests/performance/k6/sallijang/product-list-load.js
K6_STORE_ID=1 K6_ORDER_RATE=2 K6_ORDER_DURATION=1m k6 run tests/performance/k6/sallijang/order-create-load.js
K6_STORE_ID=1 K6_PRODUCT_CREATE_RATE=2 K6_PRODUCT_CREATE_DURATION=1m k6 run tests/performance/k6/sallijang/product-create-load.js
K6_STEP_TARGETS=2,5,10 K6_STEP_HOLD_DURATION=1m k6 run tests/performance/k6/sallijang/product-list-step-load.js
K6_SPIKE_BASE_RATE=2 K6_SPIKE_RATE=15 k6 run tests/performance/k6/sallijang/product-list-spike.js
K6_STORE_ID=1 K6_SOAK_VUS=2 K6_SOAK_DURATION=10m k6 run tests/performance/k6/sallijang/buyer-journey-soak.js
```

## Scenario Order

1. `smoke.js`: URL, 라우팅, 인증, 테스트 데이터 확인
2. `product-list-load.js`, `order-create-load.js`, `product-create-load.js`: 정상 부하 기준선 확인
3. `product-list-step-load.js`: 수용 한계와 HPA/Pod replica 반응 확인
4. `product-list-spike.js`: 순간 피크와 회복 확인
5. `buyer-journey-soak.js`: 장시간 누적 문제 확인
6. `stress/*.js`: 한계 탐색과 장애 지점 분석

목표는 처음부터 깨는 게 아니라, smoke 통과 -> 낮은 load 안정 확인 -> RPS 단계 상승 -> spike/soak -> stress 순서로 병목 지점을 찾는 것이다.
