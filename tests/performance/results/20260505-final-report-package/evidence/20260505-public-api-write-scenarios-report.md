# Public API Write Scenarios Test - 2026-05-05

대상: `https://api.sallijang.shop`

주의: 공개 도메인이지만 현재 AWS 리소스 태그/이름은 `dev`로 확인된다. 테스트 전용 seller/buyer/store를 생성해 사용했다.

## 테스트 계정

- seller: `k6-seller-public-write-20260505141628@sallijang.shop`
- buyer: `k6-buyer-public-write-20260505141628@sallijang.shop`
- store id: `3`
- env: `tests/performance/results/prepare-public-write-20260505141628/sallijang-k6.env`
- 추가 한계 테스트 seller: `k6-seller-public-limit-write-20260505221301@sallijang.shop`
- 추가 한계 테스트 buyer: `k6-buyer-public-limit-write-20260505221301@sallijang.shop`
- 추가 한계 테스트 store id: `5`
- 추가 한계 테스트 env: `tests/performance/results/prepare-public-limit-write-20260505221301/sallijang-k6.env`

## 1. 상품 생성/삭제

시나리오: `POST /api/v1/products/?store_id=<id>` 후 같은 iteration에서 `DELETE /api/v1/products/{id}`. 2~40 RPS는 store `3`, 80 RPS 한계 테스트는 store `5`를 사용했다.

| Target RPS | HTTP reqs | Achieved HTTP RPS | Failure | Checks | p95 | Created 201 | Delete 204 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 240 | 3.59 | 0% | 100% | 296.44ms | 120 | 120 | 0 | 0 |
| 5 | 602 | 9.02 | 0% | 100% | 360.99ms | 301 | 301 | 0 | 0 |
| 10 | 1,202 | 18.33 | 0% | 100% | 164.71ms | 601 | 601 | 0 | 0 |
| 20 | 2,402 | 36.51 | 0% | 100% | 113.44ms | 1,201 | 1,201 | 0 | 0 |
| 40 | 4,802 | 73.35 | 0% | 100% | 93.76ms | 2,401 | 2,401 | 0 | 0 |
| 80 | 9,596 | 146.89 | 0.063% | 99.958% | 676.94ms | 4,795 | 4,795 | 6 | 0 |

결론: 상품 생성/삭제는 `40 RPS`까지 오류 없이 통과했고, `80 RPS`에서 create 502 6건으로 첫 실패 신호가 나왔다. VU max는 `77`, dropped는 `0`이라 클라이언트 VU 부족으로 보기는 어렵다. 생성에 성공한 상품 삭제는 모두 `204`로 처리됐다.

## 2. 주문 생성

시나리오: setup에서 주문용 상품 pool 생성 후 `POST /api/v1/orders/`. teardown에서 setup 상품은 삭제한다. 주문 레코드는 남을 수 있다.

| Target RPS | HTTP reqs | Achieved HTTP RPS | Failure | Checks | p95 | p90 | Max | 201 | 409 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 161 | 2.41 | 0% | 100% | 262.59ms | 194.06ms | 309.89ms | 121 | 0 | 0 | 0 |
| 5 | 341 | 4.98 | 3.812% | 97.841% | 239.59ms | 192.42ms | 1.73s | 288 | 13 | 0 | 0 |

Ingress aggregate for orders:

- total `422`
- status 201 `409`
- status 409 `13`
- 5xx `0`

Order service log evidence:

```text
[WARNING] 재고 수량 조정 실패 (product_id=14245, delta=-1): All connection attempts failed
POST /api/v1/orders/ HTTP/1.1" 409 Conflict
```

결론: 주문 생성은 `2 RPS`까지 통과했고 `5 RPS`에서 409가 13건 발생했다. 5xx나 DB pool timeout이 아니라, order service가 product service 재고 차감 내부 호출에 실패하며 409를 반환한 패턴이다.

## 3. 상품 재고 차감 직접 호출

시나리오: setup에서 상품 pool 100개 생성 후 `PATCH /api/v1/products/{id}/remaining?delta=-1` 직접 호출. cleanup 요청은 endpoint threshold에서 제외하도록 스크립트를 보정했다.

| Target RPS | PATCH count | Endpoint failure | Checks | p95 | p90 | Max | 200 | 409 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 40 | 2,400 | 0% | 100% | 36.07ms | 32.27ms | 1.63s | 2,400 | 0 | 0 | 0 |
| 80 | 4,801 | 0% | 100% | 36.58ms | 32.61ms | 1.65s | 4,801 | 0 | 0 | 0 |
| 120 | 7,201 | 0% | 100% | 40.46ms | 33.95ms | 1.65s | 7,201 | 0 | 0 | 0 |
| 160 | 9,601 | 0% | 100% | 81.45ms | 39.35ms | 1.65s | 9,601 | 0 | 0 | 0 |
| 240 | 8,611 | 93.578% | 53.211% | 9.21s | 9.18s | 65.20s | 553 | 0 | 860 | 5,790 |

Ingress aggregate for product remaining 40~160 RPS:

- total `24,003`
- status 200 `24,003`
- status 409/5xx `0`

추가 240 RPS 한계 테스트:

- `product_remaining_load_status_200`: 553
- `product_remaining_load_status_5xx`: 860
- `product_remaining_load_status_other`: 7,198
- `http_req_failed{endpoint:product_remaining}`: 93.578%
- VU max: `3000`
- dropped iterations: `5790`
- k6 warning 주요 패턴: `dial: i/o timeout`

결론: product 재고 차감 API를 외부 경로로 직접 호출하면 `160 RPS`까지 실패가 없었다. 하지만 `240 RPS`에서는 timeout/status 0 계열과 5xx가 대량 발생해 명확한 실패 구간이다. 따라서 주문 생성 409를 product remaining API 160 RPS 이하 처리 한계로 확정하기는 어렵지만, product remaining 자체도 240 RPS에서는 버티지 못한다.

## 4. 주문 생성 재검증

시나리오: 같은 public API에서 상품 pool 100개로 키운 뒤 `POST /api/v1/orders/` 재실행. 상품 pool을 키워 단일 상품 충돌 가능성을 낮췄다.

| Target RPS | Order count | Endpoint failure | Checks | p95 | p90 | Max | 201 | 409 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 301 | 0.332% | 99.834% | 206.29ms | 176.65ms | 1.23s | 300 | 1 | 0 | 0 |
| 10 | 600 | 3.667% | 98.167% | 273.97ms | 222.27ms | 3.06s | 578 | 22 | 0 | 0 |

Ingress aggregate for order retest:

- total `901`
- status 201 `878`
- status 409 `23`
- 5xx `0`

Order service log evidence:

```text
[WARNING] 재고 수량 조정 실패 (product_id=15022, delta=-1): All connection attempts failed
POST /api/v1/orders/ HTTP/1.1" 409 Conflict
```

Product service log evidence:

```text
PATCH /api/v1/products/15022/remaining?delta=-1 HTTP/1.1" 200 OK
```

결론: 주문 생성은 pool 100 조건에서도 `10 RPS`에서 409가 22건 발생했다. 같은 시간 product remaining 직접 호출은 200으로 처리되므로, 현재 증거상 병목은 DB 확정보다는 `order service -> product service` 내부 호출 경로, 서비스 디스커버리, 네트워크, timeout/connection 설정 쪽이다.

현재 시점의 읽기 전용 확인:

- `order-service` endpoints: `10.0.3.101:8002`, `10.0.4.32:8002`
- `product-service` endpoints: `10.0.3.234:8001`, `10.0.4.228:8001`
- `order-deploy` env: `PRODUCT_SERVICE_URL=http://product-service`
- order pod 내부에서 `http://product-service`와 `http://product-service/api/v1/products/...` 호출은 `200`
- 따라서 service/DNS가 완전히 죽은 상태는 아니고, 주문 부하 중 간헐적으로 내부 product 호출이 실패하는 패턴이다.

## 5. 주문 10 RPS 내부 product-service probe

시나리오: 주문 10 RPS 재실행과 동시에 order pod 내부에서 `http://product-service/api/v1/products/...`를 0.1초 간격으로 조회했다.

| 항목 | 결과 |
|---|---:|
| 주문 생성 | 601건 |
| 주문 201 | 601건 |
| 주문 409/5xx | 0건 |
| 주문 p95 | 179.71ms |
| 내부 product-service probe | 900건 |
| probe 200 | 900건 |
| probe error | 0건 |
| probe p95 | 29.6ms |

결론: 같은 10 RPS라도 통과하는 경우가 있었다. 내부 product-service DNS/Service가 상시 장애인 것은 아니며, 이전 409는 간헐 장애로 기록한다.

## 6. 주문 20 RPS 한계 구간

시나리오: 상품 pool 200개로 `POST /api/v1/orders/` 20 RPS 실행.

| Target RPS | Order count | Endpoint failure | Checks | p95 | p90 | Max | 201 | 409 | 5xx | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 1,103 | 0% | 100% | 29.55s | 28.23s | 43.19s | 1,103 | 0 | 0 | 98 |

결론: 20 RPS에서는 오류는 없지만 응답시간이 한계 구간이다. 주문은 모두 201로 끝났으나 p95가 약 `29.55s`, max가 `43.19s`, dropped iteration이 `98` 발생했다.

HPA/GitOps 관찰:

- 20 RPS 직후 order HPA CPU: `380%/70%`
- `kubectl describe hpa order-hpa`: `Deployment pods: 2 current / 4 desired`
- `kubectl describe deploy order-deploy`: `Scaled up ... to 4 from 2`, `Scaled down ... to 2 from 4` 반복
- deployment event count: scale up `x98`, scale down `x85` 수준으로 반복 확인
- ArgoCD application `sallijang-order`: `automated.prune=true`, `automated.selfHeal=true`, status `Synced/Healthy`

해석: HPA가 주문 부하에 반응해 4 replicas를 원하지만, GitOps/ArgoCD desired replica `2`와 충돌해 scale-out pod가 곧바로 종료되는 패턴이 강하게 의심된다. 이 상태에서는 주문 20 RPS에서 scale-out이 안정적으로 유지되지 않아 긴 지연이 발생할 수 있다.

VU 관찰:

| 테스트 | 설정 VU | 실제 최대 VU | Dropped |
|---|---:|---:|---:|
| 상품 재고 차감 160 RPS | pre `500`, max `2000` | `80` | 0 |
| 상품 생성/삭제 80 RPS | pre `300`, max `1500` | `77` | 0 |
| 상품 재고 차감 240 RPS | pre `800`, max `3000` | `3000` | 5,790 |
| 주문 10 RPS + probe | pre `100`, max `1000` | `3` | 0 |
| 주문 20 RPS | pre `300`, max `1500` | `397` | 98 |

해석: 이번 테스트는 `constant-arrival-rate` 방식이라 VU 고정 부하가 아니라 목표 RPS를 맞추기 위해 k6가 VU를 자동 투입했다. 상품 생성/삭제 80 RPS는 VU 여유가 있었는데도 502가 발생했고, 재고 차감 240 RPS와 주문 20 RPS는 VU가 크게 늘고 dropped가 발생했다. VU 부족보다는 서버 응답 지연 또는 진입점 처리 실패 누적으로 판단한다.

테스트 데이터 정리:

- 20 RPS setup 상품 `15149..15348` 200개는 teardown에서 401 cleanup 실패
- fresh seller login 후 `DELETE /api/v1/products/{id}` 재실행
- 결과: `204` 200건
- 재고 차감 240 RPS 테스트는 teardown이 timeout으로 종료됨
- 이후 `api.sallijang.shop` DNS 및 alias ALB DNS 해석 실패, `ingress-nginx` controller resource 미확인, apiserver service proxy 503으로 cleanup 재시도 보류

## 추가 진입점 상태

한계 테스트 후 현재 public 진입점 상태:

- Route53 `api.sallijang.shop` A alias: `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com`
- AWS `elbv2 describe-load-balancers`와 classic `elb describe-load-balancers`에서 활성 LB 목록 없음
- 로컬 DNS에서 `api.sallijang.shop` 및 alias ALB DNS 해석 실패
- `ingress-nginx` namespace에 실행 중인 controller resource 없음

해석: 이 시점 이후 public API 테스트는 서비스 처리 한계가 아니라 DNS/LB/ingress 진입점 장애 영향을 받는다. 진입점 복구 후 cleanup과 재테스트가 필요하다.

## 후속 요청사항

- order -> product internal call 실패 원인 확인
- `PRODUCT_SERVICE_URL=http://product-service` 호출 경로, service endpoints, keep-alive/timeout 설정 확인
- product service readiness/scale-up 중 내부 호출 실패 여부 확인
- 주문 생성 시 409를 모두 정상 비즈니스 충돌로 볼지, 내부 호출 실패는 별도 5xx/에러 코드로 분리할지 백엔드 정책 확인
- order HPA와 ArgoCD self-heal 충돌 확인: HPA가 `4 desired`로 올린 직후 deployment가 `2 desired`로 되돌아가는 이벤트가 반복된다.
- HPA 대상 deployment에는 ArgoCD `ignoreDifferences` 또는 replicas 관리 정책 조정이 필요하다. 테스트팀은 설정 변경하지 않았고 증거만 수집했다.
- `api.sallijang.shop` TLS 인증서 SAN 확인: k6는 인증서가 `sallijang.shop`로만 유효하다고 판단해 `--insecure-skip-tls-verify`가 필요했다.
- `api.sallijang.shop` Route53 alias 대상 ALB 및 ingress-nginx controller 복구 확인
- 재고 차감 240 RPS 테스트 상품 cleanup 재시도

## 회복 상태

테스트 후 상태:

- product deployment: 테스트 직후 HPA가 `5` replicas까지 올린 흔적 확인, 이후 ArgoCD/HPA에 의해 다시 축소되는 패턴 관찰
- order deployment `2/2`
- product HPA: 240 RPS 후 `ScalingLimited=True`, max `5` replica 도달 이벤트 확인
- order HPA `2%/70%`
- product remaining 부하 중 product HPA는 일시적으로 scale-out 후 다시 `2/2`로 회복됨

## 결과 경로

- 상품 생성/삭제: `tests/performance/results/20260505-public-api-product-create-141646`
- 상품 생성/삭제 한계: `tests/performance/results/20260505-public-api-product-create-limit-221320`
- 주문 생성: `tests/performance/results/20260505-public-api-order-create-142340`
- 상품 재고 차감 직접 호출: `tests/performance/results/20260505-public-api-product-remaining-extended-145106`
- 상품 재고 차감 한계: `tests/performance/results/20260505-public-api-product-remaining-limit-221534`
- 주문 생성 재검증: `tests/performance/results/20260505-public-api-order-create-retest-145710`
- 주문 10 RPS + 내부 probe: `tests/performance/results/20260505-order10-internal-product-probe-151632`
- 주문 20 RPS 한계: `tests/performance/results/20260505-public-api-order-create-limit-151905`
- 주문 20 RPS cleanup: `tests/performance/results/cleanup-order20-202605051520`
