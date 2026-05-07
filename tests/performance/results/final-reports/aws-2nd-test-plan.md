# Sallijang 2차 AWS 부하 테스트 계획서

작성일: 2026-05-07 KST
대상: `https://api.sallijang.shop`
기준 문서: `tests/performance/results/final-reports/aws-20260505/`

## 1. 배경

1차 AWS 테스트에서는 소비자/판매자 역할별 public API 부하 한계를 확인했다.

| 영역 | 1차 안정 구간 | 1차 실패 신호 |
|---|---:|---|
| 상품 조회 | `150 RPS` | `160 RPS` 첫 502, `200 RPS` p95 약 12초 |
| 주문 생성 | `10 RPS` 재현성 불안정 | `20 RPS` p95 `29.55s`, dropped 98 |
| 상품 생성/삭제 | `40 RPS` | `80 RPS` create 502 6건 |
| 재고 차감 직접 호출 | `160 RPS` | `240 RPS` 5xx 860건, dropped 5,790 |

1차 결론은 DB/RDS 단독 병목 확정이 아니라 `order-service -> product-service` 내부 호출, HPA/GitOps scale 정책, public 진입점 상태를 함께 확인해야 한다는 것이다. 따라서 2차 테스트는 단순 최대 RPS 갱신보다 원인 분리와 재현성 확인을 우선한다.

## 2. 테스트 목표

1. 주문 생성 `10 RPS`가 안정 구간인지 반복 검증한다.
2. 주문 `20 RPS` 지연 한계가 HPA/GitOps 충돌과 연결되는지 확인한다.
3. product remaining 직접 호출은 안정인데 주문 내부 호출만 흔들리는지 비교한다.
4. 상품 조회, 상품 생성/삭제, 재고 차감의 1차 한계 구간을 중간 RPS로 촘촘히 재검증한다.

## 3. 사전 조건

2차 테스트 전 아래 조건을 먼저 확인한다.

| 항목 | 확인 내용 | 통과 기준 |
|---|---|---|
| Public 진입점 | DNS, ALB alias, ingress-nginx controller | `/health`, 상품 조회, 인증 필요 API가 정상 응답 |
| HPA/GitOps | HPA scale-out과 ArgoCD self-heal 충돌 여부 | 부하 중 desired replicas가 즉시 원복되지 않음 |
| 테스트 데이터 | 1차 재고 차감 240 RPS 잔여 상품 cleanup | 테스트 전용 store/product 상태 정리 |
| 관찰 준비 | order/product 로그, HPA 이벤트, ingress 5xx, ALB target 지표 | 테스트 시간대별 수집 가능 |

## 4. 시나리오 0: 라우팅/스모크

목적: 부하 전 public 진입점 문제가 테스트 결과를 왜곡하지 않는지 확인한다.

| 확인 대상 | 방식 |
|---|---|
| Public API | `/health`, `GET /api/v1/products/`, `GET /api/v1/auth/me` |
| 내부 호출 | order pod 내부에서 `http://product-service/api/v1/products/{id}` probe |
| Kubernetes | ingress controller, service endpoints, pod restart count |
| ALB/Ingress | target health, 5xx, response time |

통과 기준:

- public API 5xx 0건
- 내부 product-service probe 100% 성공
- ingress-nginx controller와 service endpoints 정상

## 5. 시나리오 1: 상품 조회 재검증

1차 결과는 `150 RPS` 안정, `160 RPS` 첫 실패, `200 RPS` 지연 한계였다.

| 단계 | Target RPS | Duration | 목적 |
|---:|---:|---:|---|
| 1 | 120 | 3m | 안정 기준선 |
| 2 | 150 | 5m | 1차 안정 구간 재현 |
| 3 | 160 | 3m | 첫 실패 신호 재현 |
| 4 | 180 | 3m | 지연/502 확대 확인 |
| 5 | 200 | 3m | 처리량 한계 확인 |

통과 기준:

- `150 RPS`: 5xx 0건, p95 `<800ms`, dropped 0
- `160 RPS+`: 502, p95, dropped 발생 시점 기록

## 6. 시나리오 2: 주문 생성 재현성 테스트

1차에서는 `5~10 RPS`에서 409가 간헐 발생했고, `20 RPS`는 모두 201이었지만 p95가 `29.55s`까지 증가했다.

상품 pool 기준:

| Target RPS | 상품 pool |
|---:|---:|
| 5~10 | 200개 |
| 20~30 | 500개 |

실행 단계:

| 단계 | Target RPS | Duration | 목적 |
|---:|---:|---:|---|
| 1 | 5 | 3m | 낮은 부하 기준선 |
| 2 | 10 | 5m | 1차 간헐 409 재현성 확인 |
| 3 | 10 | 5m | 동일 조건 반복 |
| 4 | 20 | 5m | 지연 한계 재확인 |
| 5 | 20 | 5m | HPA 안정화 후 재반복 |
| 6 | 30 | 3m | 개선 확인 시 다음 한계 탐색 |

통과 기준:

- `10 RPS`: 409 0건 또는 0.1% 미만, p95 `<1500ms`, dropped 0
- `20 RPS`: p95 `<1500ms`면 개선 확인, 초과 시 지연 한계 유지

동시 관찰:

- order pod 내부 product-service probe
- `kubectl get hpa -w`
- order deployment scale event
- order 로그의 `All connection attempts failed`
- product 로그의 corresponding PATCH 성공/실패

판단 기준:

| 관찰 결과 | 해석 |
|---|---|
| probe는 성공, order만 409 | order 내부 HTTP client timeout/connection/retry 문제 가능성 |
| HPA desired 증가 후 replica 원복 | HPA/GitOps 충돌 가능성 |
| product PATCH 200, order 409 | 내부 호출 timeout 또는 오류 매핑 문제 가능성 |
| product 직접 호출도 실패 | product-service/DB/ingress 병목 가능성 |

## 7. 시나리오 3: 주문 내부 호출과 재고 차감 직접 호출 비교

목적: product remaining API 자체 한계와 주문 내부 호출 한계를 분리한다.

| 순서 | 테스트 | Target RPS | Duration |
|---:|---|---:|---:|
| 1 | product remaining 직접 호출 | 160 | 5m |
| 2 | 주문 생성 | 10 | 5m |
| 3 | product remaining 직접 호출 | 200 | 3m |
| 4 | 주문 생성 | 20 | 5m |

판단:

- remaining 160/200이 안정인데 주문 10/20이 흔들리면 내부 호출/주문 처리 문제가 우선이다.
- remaining 200부터 흔들리면 product-service, DB/RDS, ingress도 병목 후보로 본다.

## 8. 시나리오 4: 상품 생성/삭제 재검증

1차 결과는 `40 RPS` 안정, `80 RPS` create 502 6건이었다.

| 단계 | Target RPS | Duration | 목적 |
|---:|---:|---:|---|
| 1 | 40 | 5m | 안정 구간 장시간화 |
| 2 | 60 | 3m | 중간 구간 확인 |
| 3 | 80 | 3m | 502 재현 |
| 4 | 100 | 2m | 필요 시 실패 확대 확인 |

주의: 이 시나리오는 한 iteration에서 create/delete 2개 요청을 보내므로 `80 RPS`는 실제 HTTP request/s가 약 `160 req/s`다.

통과 기준:

- create 201, delete 204
- create 5xx 0건
- p95 `<2000ms`
- dropped 0

## 9. 시나리오 5: 재고 차감 한계 재탐색

1차 결과는 `160 RPS` 안정, `240 RPS` 명확 실패였다. 2차에서는 중간 구간을 촘촘히 확인한다.

| 단계 | Target RPS | Duration |
|---:|---:|---:|
| 1 | 160 | 5m |
| 2 | 180 | 3m |
| 3 | 200 | 3m |
| 4 | 220 | 3m |
| 5 | 240 | 2m |

통과 기준:

- 5xx 0건
- status other/timeouts 0건
- p95 `<1000ms`
- dropped 0

## 10. 권장 실행 순서

1. 라우팅/스모크
2. 상품 조회 `120 -> 150 -> 160`
3. 주문 `5 -> 10 -> 10 반복`
4. product remaining `160`
5. 주문 `20`
6. HPA/GitOps 관찰 결과 확인
7. 상품 생성/삭제 `40 -> 60 -> 80`
8. product remaining `180 -> 200 -> 220 -> 240`
9. 필요 시 주문 `30` 또는 조회 `180/200` 확장

## 11. 결과 정리 포맷

2차 결과는 아래 표로 정리한다.

| 영역 | 2차 안정 구간 | 2차 실패 시작 | 주요 증거 | 병목 후보 |
|---|---:|---:|---|---|
| 상품 조회 | TBD | TBD | 502, p95, dropped, ALB/ingress 지표 | ingress/product/DB |
| 주문 생성 | TBD | TBD | p95, 409, HPA, 내부 호출 로그 | order 내부 호출/HPA |
| 상품 생성/삭제 | TBD | TBD | create 502, p95, dropped | ingress/product write |
| 재고 차감 직접 | TBD | TBD | timeout, 5xx, dropped | product/DB/ingress |

2차 테스트의 핵심 결론은 주문 20 RPS의 지연이 재현되는지, 그리고 그 순간 HPA scale-out 유지 여부와 `order-service -> product-service` 내부 호출 실패가 함께 관찰되는지로 판단한다.
