# Sallijang Dev Test Status - 2026-05-05

작성일: 2026-05-05 KST

## 결론

dev 환경은 다시 올라왔고 k6 smoke/load 테스트까지 실행 가능하다.

추가 한계치 측정 결과:

- 상품 조회 `GET /api/v1/products/`: `150 RPS` 안정, `155 RPS` 지연 기준 초과, `200 RPS`에서 500 오류 발생
- 주문 생성 `POST /api/v1/orders/`: `10 RPS` 안정, `20 RPS`에서 500 오류 발생
- 상품 생성/삭제 `POST /api/v1/products/` + `DELETE /api/v1/products/{id}`: `40 RPS` 안정, `80 RPS`에서 502 오류 발생

현재 주의할 점:

- `api.sallijang.shop` TLS 인증서가 host를 커버하지 않는다.
  - 현재 인증서는 `sallijang.shop`용이라 k6/curl은 임시로 `--insecure-skip-tls-verify` 또는 `curl -k`가 필요하다.
  - 정식 조치: ACM 인증서에 `api.sallijang.shop` 또는 wildcard/SAN 추가 후 ALB listener 교체.
- HPA는 동작한다.
  - `product-hpa`, `order-hpa` 모두 metrics-server CPU metrics를 읽는다.
  - 현재 부하에서는 CPU가 낮아 replica 2에서 유지된다.
- 2/5/10 RPS step 재실행 중 k6 로컬 runner의 wall-clock이 `03:03`에서 `08:41`로 튀면서 request timeout이 발생했다.
  - 같은 시점 `curl`은 164ms에 `200`을 받았다.
  - ingress/product 로그와 pod CPU는 정상이라 dev API 병목으로 단정하지 않는다.
  - 실제 capacity 측정은 WSL/로컬이 아니라 EC2, CI runner, 또는 클러스터 내부처럼 시간이 안정적인 runner에서 다시 한다.

## 현재 AWS/EKS 상태

- Account: `594486941613`
- IAM user: `arn:aws:iam::594486941613:user/CHS`
- Region: `ap-northeast-2`
- EKS: `pickup-dev-eks-cluster`
- ALB: `pickup-dev-alb`
- API DNS: `api.sallijang.shop`
- ALB DNS: `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com`
- VPC: `vpc-0a7f5476b40184718`
- Nodes:
  - `ip-10-0-3-88.ap-northeast-2.compute.internal`
  - `ip-10-0-4-180.ap-northeast-2.compute.internal`
- App pods:
  - `user`, `product`, `order`, `notify` 모두 Running
- ArgoCD apps:
  - `sallijang-ingress`
  - `sallijang-user`
  - `sallijang-product`
  - `sallijang-order`
  - `sallijang-notify`
  - 모두 `Synced` / `Healthy`

## 수동 작업 내역

Terraform apply 후 dev 테스트를 위해 아래 작업을 수동으로 적용했다. 다음 Terraform apply/destroy 뒤에는 사라질 수 있으므로 코드화가 필요하다.

1. Route53 `api.sallijang.shop.` A alias 추가
   - hosted zone: `Z076739714CV5CNEDIAMO`
   - alias target: `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com.`
2. ArgoCD Application 5개 생성
   - repo: `https://github.com/Salijang/sallijang-manifest.git`
   - paths: `base/user`, `base/product`, `base/order`, `base/notify`, `base/ingress`
3. Kubernetes secret 생성
   - namespace/name: `default/user-service-secret`
   - key: `secret-key`
4. EKS node security group inbound hotfix
   - node SG: `sg-09d636aa33c4b1adc`
   - TCP `8443` from `10.0.0.0/16`
   - reason: nginx ingress admission webhook timeout 해결
5. EKS managed add-on `metrics-server` 설치
   - version: `v0.8.0-eksbuild.3`
6. EKS node security group inbound hotfix
   - node SG: `sg-09d636aa33c4b1adc`
   - TCP `10251` from `10.0.0.0/16`
   - reason: metrics-server APIService timeout 해결

Terraform에 반영할 항목:

- `api.sallijang.shop` Route53 alias
- `api.sallijang.shop`를 포함하는 ACM 인증서
- node SG inbound `8443`, `10251`
- metrics-server add-on
- ArgoCD Application bootstrap
- `user-service-secret` 관리 방식

로컬 임시 infra clone에는 일부 재발 방지 패치를 넣어두었다.

- path: `/tmp/sallijang-api-check-infra`
- 반영한 내용:
  - ALB module: additional Route53 alias와 ACM SAN 입력 지원
  - dev ALB: `api.${var.domain_name}` alias/SAN 설정
  - EKS module: node SG inbound `8443`, `10251`
  - dev monitoring: `metrics-server` EKS add-on
- 검증: `terraform validate` 성공

주의: 현재 dev에는 위 리소스 일부가 이미 수동으로 만들어져 있다. 이 상태에서 바로 `terraform apply`하면 "already exists" 충돌이 날 수 있으므로, apply 전 import를 하거나 fresh rebuild 때 적용한다. 또한 현재 tfvars의 `certificate_arn`은 기존 인증서를 그대로 쓰므로, TLS 문제는 `api.sallijang.shop`가 포함된 새 ACM 인증서 ARN으로 교체해야 완전히 해결된다.

## 외부 API 확인

인증서 문제가 해결되기 전까지 `-k`가 필요하다.

```bash
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/health
curl -sk -w '\n%{http_code} %{content_type}\n' 'https://api.sallijang.shop/api/v1/products/?limit=1&offset=0'
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/api/v1/auth/me
```

확인 결과:

- `/health` -> `200 text/plain`
- `/api/v1/products/?limit=1&offset=0` -> `200 application/json`
- `/api/v1/auth/me` -> `401 application/json`

`401 application/json`은 인증 필요한 API에서 정상 라우팅이 된 것이다. nginx `404`와 구분한다.

## 테스트 계정

준비 명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
bash tests/performance/prepare-sallijang-test-env.sh
```

생성 결과:

- env file: `tests/performance/results/prepare-20260505023754/sallijang-k6.env`
- seller: `k6-seller-20260505023754@sallijang.shop`
- buyer: `k6-buyer-20260505023754@sallijang.shop`
- store id: `1`

## k6 실행 결과

모든 외부 API k6 실행은 TLS 임시 우회를 위해 `--insecure-skip-tls-verify`를 붙였다.

### Smoke - read

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/smoke.js
```

결과:

- checks: `100%`
- `http_req_failed`: `0%`
- p95: `42.67ms`

### Smoke - write/order

명령:

```bash
. tests/performance/results/prepare-20260505023754/sallijang-k6.env
K6_SMOKE_WRITE=1 K6_SMOKE_ORDER=1 \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/smoke.js
```

결과:

- checks: `100%`
- `http_req_failed`: `0%`
- p95: `218.47ms`
- 상품 생성 성공
- 주문 생성 `201`

### Product list baseline

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_READ_RATE=5 K6_READ_DURATION=1m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/product-list-load.js
```

결과:

- requests: `301`
- checks: `100%`
- `http_req_failed`: `0%`
- avg: `32.05ms`
- p95: `40.2ms`
- max: `157.84ms`

### Order create baseline

명령:

```bash
. tests/performance/results/prepare-20260505023754/sallijang-k6.env
K6_ORDER_RATE=2 K6_ORDER_DURATION=1m \
k6 run --insecure-skip-tls-verify tests/performance/k6/sallijang/order-create-load.js
```

결과:

- iterations: `121`
- orders created: `121`
- checks: `100%`
- `http_req_failed`: `0%`
- 5xx: `0`
- overall p95: `282.49ms`
- `order_create` p95: `284.38ms`
- max: `713.25ms`

### Product list step - local runner caveat

명령:

```bash
K6_BASE_URL=https://api.sallijang.shop \
K6_STEP_TARGETS=2,5,10 K6_STEP_HOLD_DURATION=1m \
K6_PREALLOCATED_VUS=40 K6_MAX_VUS=200 \
k6 run --insecure-skip-tls-verify \
  --summary-export tests/performance/results/20260505-dev/product-list-step-2-5-10-summary.json \
  tests/performance/k6/sallijang/product-list-step-load.js
```

결과:

- total HTTP requests: `1498`
- 2xx: `1418`
- status other/request timeout: `80`
- `http_req_failed`: `5.34%`
- dropped iterations: `2`
- successful-response p95: `46.88ms`
- all-response p95: `58.79s`

해석:

- 성공한 API 응답만 보면 p95는 `46.88ms`로 낮다.
- timeout 80건은 k6 실행 중 로컬 runner wall-clock이 약 `5h38m` 튄 시점에 발생했다.
- 같은 시점 별도 curl:

```text
status=200 total=0.164719 connect=0.105189 tls=0.117173
```

- 같은 시점 pod CPU:
  - product pods: `2m`, `2m`
  - HPA target: `cpu: 2%/70%`
- 따라서 현재 데이터로는 10 RPS에서 backend/ingress 병목이라고 결론내리지 않는다.
- capacity 판정은 안정적인 runner에서 재실행해야 한다.

## HPA/모니터링 상태

확인 명령:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl get hpa -n default
```

결과:

```text
order-hpa     Deployment/order-deploy     cpu: 2%/70%   2   5   2
product-hpa   Deployment/product-deploy   cpu: 2%/70%   2   5   2
```

metrics-server와 HPA는 정상이다. 현재 낮은 부하에서는 CPU 사용률이 낮아 scaling이 발생하지 않았다.

## 다음 순서

1. TLS 인증서에 `api.sallijang.shop` 추가
2. 수동 hotfix를 Terraform/GitOps에 반영
3. k6 runner를 안정적인 환경으로 옮김
   - 권장: 같은 VPC 또는 같은 region EC2
   - 대안: CI runner
4. 2/5/10 RPS step을 재측정
5. 정상이라면 10/20/40 RPS step으로 한계 탐색
6. Grafana/Prometheus 대시보드에 테스트 시각, p95, 실패율, pod CPU/memory, HPA replica를 함께 기록

## Local Capacity Run - 2026-05-05 09:00 KST

추가로 로컬 WSL runner에서 product list read-only 한계치를 측정했다.

- result dir: `tests/performance/results/20260505-local-capacity-085953`
- summary: `tests/performance/results/20260505-local-capacity-085953/capacity-summary.md`
- script: `tests/performance/k6/sallijang/product-list-load.js`
- duration: RPS별 `1m`
- gate: `http_req_failed < 1%`, `p95 < 1000ms`

결과:

- `150 RPS`까지 통과
  - achieved: `154.4 RPS`
  - failure: `0%`
  - p95: `917.18ms`
- `155 RPS`부터 실패
  - achieved: `159.54 RPS`
  - failure: `0%`
  - p95: `1178.75ms`
- `160 RPS`도 실패
  - achieved: `164.27 RPS`
  - failure: `0%`
  - p95: `1146.87ms`

해석:

- 로컬 short cold-HPA 기준 안정 구간은 product list read `150 RPS`까지다.
- 첫 한계 구간은 `155 RPS`다.
- 실패 원인은 HTTP error가 아니라 latency p95 1초 초과다.
- ingress 로그에서도 실패 구간에 upstream response time 1초 이상이 확인됐다.
- product HPA는 테스트 직후 `443%/70%` CPU를 보고 스케일아웃을 시도했다. 1분짜리 짧은 테스트라 HPA scale-out 효과는 늦게 반영됐다.

## Local Actual Failure Run - 2026-05-05 09:26 KST

인프라 트러블슈팅 요청을 위해 p95 threshold가 아니라 실제 HTTP 실패가 나는 지점까지 추가 측정했다.

- result dir: `tests/performance/results/20260505-local-failure-092613`
- troubleshooting report: `tests/performance/results/20260505-local-failure-092613/infra-troubleshooting-request.md`
- script: `tests/performance/k6/sallijang/product-list-load.js`
- target: `GET /api/v1/products/`
- duration: `1m`
- threshold setup:
  - `http_req_failed < 1%`
  - `checks > 99%`
  - p95 threshold는 `100000ms`로 올려 latency만으로 중단되지 않게 함

200 RPS 결과:

- target: `200 RPS`
- achieved: `159.62 RPS`
- total HTTP requests: `10,838`
- 2xx: `10,717`
- 5xx: `121`
- HTTP failure rate: `1.116%`
- dropped iterations: `1,163`
- avg latency: `7.87s`
- p90 latency: `18.61s`
- p95 latency: `21.34s`
- max latency: `34.60s`

근거:

- ingress aggregate:
  - total: `10,838`
  - status 200: `10,717`
  - status 500: `121`
  - `>=1s`: `9,675`
  - `>=10s`: `3,445`
  - `>=30s`: `152`
- product service logs:
  - `sqlalchemy.exc.TimeoutError: QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00`
  - occurrence count: `121`
- ALB target group은 계속 healthy
- test 후 `/health`, `/api/v1/products/?limit=1&offset=0` 모두 `200`, 약 `52ms`

해석:

- 실제 실패 구간은 `200 RPS`다.
- 실패 원인은 ALB target health나 TLS/connect 문제가 아니라 product service DB connection pool exhaustion으로 보인다.
- HPA는 CPU 상승을 보고 scale-out을 시도했지만 1분짜리 burst 안에서는 늦게 반응했다.

## Order Create Actual Failure Run - 2026-05-05 09:42 KST

주문 생성 API도 조회와 별도로 쓰기 한계치를 측정했다.

- result dir: `tests/performance/results/20260505-order-failure-094205`
- script: `tests/performance/k6/sallijang/order-create-load.js`
- target: `POST /api/v1/orders/`
- duration: RPS별 `1m`
- setup: 각 run 시작 시 주문용 상품 pool 생성 후 teardown에서 삭제
- threshold setup:
  - `http_req_failed < 1%`
  - `checks > 99%`
  - 5xx count `0`
  - p95 threshold는 `100000ms`로 올려 latency만으로 중단되지 않게 함

결과:

| Target RPS | HTTP reqs | Achieved HTTP RPS | Failure | p95 | 201 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 401 | 6.50 | 0% | 191.95ms | 301 | 0 | 0 |
| 10 | 701 | 11.33 | 0% | 191.55ms | 601 | 0 | 0 |
| 20 | 1,186 | 12.96 | 0.169% | 35.56s | 1,084 | 2 | 96 |

근거:

- order service logs:
  - `sqlalchemy.exc.TimeoutError: QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00`
  - occurrence count: `2`
- ingress aggregate for `POST /api/v1/orders/`:
  - total: `1,938`
  - status 201: `1,919`
  - status 499: `17`
  - status 500: `2`
  - `>=1s`: `1,078`
  - `>=10s`: `898`
  - `>=30s`: `378`
- test 후 `/api/v1/products/?limit=1` health check는 `200`, 약 `70ms`

해석:

- 주문 생성은 `10 RPS`까지 안정적이고 `20 RPS`에서 실제 500이 발생했다.
- 실패 원인은 order service DB connection pool exhaustion으로 보인다.
- 같은 20 RPS라도 주문 생성은 상품 조회보다 DB 쓰기와 재고/주문 트랜잭션 비용이 커서 더 낮은 RPS에서 실패한다.

## Product Create/Delete Actual Failure Run - 2026-05-05 09:49 KST

상품 생성 API도 별도 스크립트로 한계치를 측정했다. 각 iteration은 상품을 생성한 뒤 바로 삭제한다.

- result dir: `tests/performance/results/20260505-product-create-failure-094905`
- script: `tests/performance/k6/sallijang/product-create-load.js`
- target: `POST /api/v1/products/?store_id=2` + `DELETE /api/v1/products/{id}`
- duration: RPS별 `1m`
- threshold setup:
  - `http_req_failed < 1%`
  - `checks > 99%`
  - 5xx count `0`
  - p95 threshold는 `100000ms`로 올려 latency만으로 중단되지 않게 함

결과:

| Target RPS | HTTP reqs | Achieved HTTP RPS | Failure | HTTP p95 | Iteration p95 | Created 201 | Delete 204 | 5xx/502 | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 242 | 4.17 | 0% | 57.26ms | 151.47ms | 121 | 121 | 0 | 0 |
| 5 | 602 | 10.36 | 0% | 56.14ms | 151.37ms | 301 | 301 | 0 | 0 |
| 10 | 1,202 | 20.70 | 0% | 48.10ms | 116.31ms | 601 | 601 | 0 | 0 |
| 20 | 2,400 | 41.41 | 0% | 49.62ms | 113.17ms | 1,200 | 1,200 | 0 | 0 |
| 40 | 4,800 | 82.80 | 0% | 53.59ms | 111.83ms | 2,400 | 2,400 | 0 | 0 |
| 80 | 9,600 | 156.72 | 0.021% | 4.06s | 6.30s | 4,799 | 4,799 | 2 | 0 |

근거:

- ingress aggregate for product create/delete:
  - total: `18,846`
  - `POST 201`: `9,422`
  - `DELETE 204`: `9,422`
  - `POST 502`: `2`
  - `>=1s`: `3,784`
  - `>=3s`: `1,056`
  - `>=10s`: `2`
- 80 RPS 실패 ingress sample:
  - `POST /api/v1/products/?store_id=2` -> `502`
  - upstream: `default-product-service-80`
- product service app 로그에서는 `QueuePool`/`Traceback`/`Exception`이 잡히지 않았다.
- test 후 `/api/v1/products/?limit=1` health check는 `200`, 약 `77ms`

해석:

- 상품 생성/삭제는 `40 RPS`까지 안정적이고 `80 RPS`에서 실제 502가 발생했다.
- 이번 502는 app 로그에 DB pool timeout이 남은 조회/주문 실패와 달리 ingress/upstream 레벨 장애로 잡혔다.
- product HPA는 테스트 직후 CPU가 `311%/70%`까지 올라갔고 scale 이벤트가 반복됐다. 짧은 burst 중 pod lifecycle, readiness, termination, HPA stabilization 설정을 같이 확인해야 한다.
