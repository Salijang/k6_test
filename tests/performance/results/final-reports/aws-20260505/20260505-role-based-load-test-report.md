# Sallijang 1차 AWS 테스트 역할별 부하 테스트 보고서

작성일: 2026-05-05 KST
대상: `https://api.sallijang.shop`
환경: public API 도메인이지만 AWS 리소스명/태그는 `dev` 계열로 확인됨
원칙: 테스트팀은 인프라/앱 설정 변경 없이 k6 부하 테스트와 읽기 전용 관찰만 수행

## 1. 테스트 목적

Sallijang 앱은 소비자 사용자와 판매자 사용자가 분리되어 있다. 따라서 단순히 API를 하나씩 때리는 방식이 아니라, 실제 사용자 역할별 핵심 흐름을 기준으로 부하 시나리오를 나누어 확인했다.

- 소비자 관점: 상품을 조회하고 주문을 생성할 때 어느 구간에서 지연/오류가 발생하는지 확인
- 판매자 관점: 상품을 생성/삭제하고 재고 관련 API가 어느 구간까지 버티는지 확인
- 인프라 관점: 실패가 단순 API 오류인지, 내부 서비스 호출/스케일링/진입점 문제인지 분리

## 2. 전체 결론

현재 확인된 보수적 상한은 소비자 상품 조회 `150 RPS`, 소비자 주문 생성 `10 RPS 재현성 불안정으로 한계 확정 보류`, 판매자 상품 생성/삭제 `40 RPS`, 재고 차감 직접 호출 `160 RPS`다.

실패 신호는 상품 조회 `160 RPS`, 상품 생성/삭제 `80 RPS`, 재고 차감 직접 호출 `240 RPS`, 주문 생성 `20 RPS`에서 확인했다. 주문 생성은 20 RPS에서 5xx 없이 모두 201이었지만 p95가 `29.55s`까지 증가해 운영 기준상 지연 한계로 판단했다.

### 2.1 작업 진행 순서

1차 AWS 테스트 작업은 아래 순서로 진행했다. 각 단계의 원천 로그와 summary는 `evidence/` 폴더에 포함했다.

| 순서 | 작업 | 수행 내용 | 결과/판단 |
|---:|---|---|---|
| 1 | AWS/환경 확인 | AWS 계정, public API 도메인, EKS/ALB/RDS/Redis 리소스명 확인 | `api.sallijang.shop`은 public 도메인이지만 AWS 리소스명/태그는 `dev` 계열로 기록 |
| 2 | API 라우팅/스모크 확인 | `/health`, `/api/v1/products/`, `/api/v1/auth/me` 등으로 ALB -> ingress -> service 접근 확인 | 초기에 API 장애가 있었으나 CD 쪽 문제 수정 후 k6 테스트 진행 가능 상태 확인 |
| 3 | 테스트 계정/데이터 준비 | 테스트 전용 seller/buyer 가입, 로그인, store 생성, JWT cookie/env 파일 생성 | k6 부하 테스트용 인증/매장 데이터 확보 |
| 4 | 상품 조회 한계 테스트 | `GET /api/v1/products/`를 20 -> 200 RPS로 단계 상향 | `150 RPS` 안정, `160 RPS` 첫 502, `200 RPS` p95 약 12초/dropped 발생 |
| 5 | 상품 생성/삭제 테스트 | `POST /products` 후 같은 iteration에서 `DELETE /products/{id}` 수행, 2 -> 80 RPS 상향 | `40 RPS` 안정, `80 RPS`에서 create 502 6건 발생 |
| 6 | 주문 생성 1차 테스트 | 상품 pool 생성 후 buyer token으로 `POST /api/v1/orders/` 2 -> 5 RPS 실행 | `2 RPS` 통과, `5 RPS`에서 409 13건. 내부 product 호출 실패 로그 확인 |
| 7 | 재고 차감 직접 테스트 | 주문 API를 거치지 않고 `PATCH /products/{id}/remaining?delta=-1` 단독 호출, 40 -> 240 RPS 상향 | product remaining은 `160 RPS` 안정, `240 RPS`에서 timeout/5xx/dropped 대량 발생 |
| 8 | 주문 생성 재검증 | 상품 pool을 100개로 확대해 `POST /orders` 5 -> 10 RPS 재실행 | pool을 키워도 `10 RPS`에서 409 22건 발생. 단일 상품 충돌만으로 보기 어려움 |
| 9 | 내부 product-service probe | 주문 10 RPS 중 order pod 내부에서 product-service를 0.1초 간격 조회 | probe 900/900건 200. product-service DNS/Service 상시 장애는 아님 |
| 10 | 주문 20 RPS 한계 테스트 | 상품 pool 200개로 `POST /orders` 20 RPS 실행 | 1,103건 모두 201이나 p95 `29.55s`, max `43.19s`, dropped 98로 지연 한계 |
| 11 | HPA/GitOps 관찰 | 주문 20 RPS 직후 HPA, deployment event, ArgoCD 상태 확인 | order HPA `2 current / 4 desired`, ArgoCD self-heal로 replicas 되돌림 의심 |
| 12 | 추가 한계 후 진입점 확인 | 상품 생성/삭제 80 RPS, 재고 차감 240 RPS 후 DNS/LB/ingress 상태 확인 | `api.sallijang.shop` alias/DNS/ingress 상태 불안정. 이후 테스트 전 진입점 복구 필요 |
| 13 | VU/결과 해석 정리 | k6 VU max, dropped, p95, status code를 함께 분석 | VU 고정 테스트가 아니라 target iteration/s 테스트임을 명시. 서버 지연/진입점/스케일링 영향을 분리 |
| 14 | 보고서/증거 패키징 | 1장 보고서, 상세 보고서, 이미지 5장, 원천 summary/log/evidence 정리 | `aws-20260505`와 Windows Downloads zip으로 제출 패키지 구성 |

### 2.2 실행 방식과 스크립트 세팅

1차 AWS 테스트는 VU 수를 고정해서 사용자를 태운 방식이 아니라 k6 `constant-arrival-rate`로 목표 RPS를 먼저 정하고, 응답이 느려지면 k6가 필요한 VU를 자동으로 추가 투입하는 방식이다. 여기서 `RPS`는 k6 target iteration/s 기준이다. 한 iteration 안에서 여러 HTTP 요청을 보내는 상품 생성/삭제 시나리오는 실제 HTTP request/s가 target RPS보다 크게 나온다.

그래서 보고서의 핵심 기준은 `목표 iteration RPS`, `p95`, `status code`, `dropped iteration`, `실제 최대 VU`다.

공통 실행 조건:

| 항목 | 설정 |
|---|---|
| 대상 도메인 | `https://api.sallijang.shop` |
| 실행 단위 | RPS별 `1m` 실행 |
| 인증 | 테스트 전용 seller/buyer 계정으로 로그인 후 JWT cookie 사용 |
| 데이터 | 테스트 전용 store와 상품 pool 생성, 가능한 경우 teardown에서 삭제 |
| 통과 기준 | 5xx 0건, endpoint failure 1% 미만, checks 99% 초과, p95 기준 이내 |

p95 기준:

| 시나리오 | p95 기준 |
|---|---:|
| 상품 조회 | `800ms` |
| 주문 생성 | `1500ms` |
| 상품 생성/삭제 | `2000ms` |
| 재고 차감 직접 검증 | `1000ms` |

실제 사용 스크립트와 세팅:

| 시나리오 | k6 스크립트 | 주요 세팅값 | 스크립트 동작 |
|---|---|---|---|
| 상품 조회 | `product-list-load.js` | `K6_READ_RATE`로 RPS 변경, `duration=1m`, limit `20`, offset `0~60`, category 50% 랜덤 | `GET /api/v1/products/` 호출. 서울 좌표 기준 `user_lat/user_lng`를 약간 랜덤화하고 카테고리/페이지를 섞어서 조회 |
| 주문 생성 | `order-create-load.js` | `K6_ORDER_RATE`, `duration=1m`, 상품 pool `20 -> 100 -> 200`, pre/max VU `100~500 / 1000~2000`, 20 RPS는 `300 / 1500` | `setup()`에서 seller token으로 주문용 상품 pool 생성. 본문에서는 buyer token으로 `POST /api/v1/orders/` 호출. 상품은 pool에서 랜덤 선택. `teardown()`에서 setup 상품 삭제 |
| 상품 생성/삭제 | `product-create-load.js` | `K6_PRODUCT_CREATE_RATE`, `duration=1m`, 2~40 RPS는 pre/max VU `500 / 2000`, 80 RPS는 `300 / 1500` | 한 iteration 안에서 `POST /api/v1/products/?store_id=...`로 상품 생성 후, 성공한 상품은 즉시 `DELETE /api/v1/products/{id}`로 삭제 |
| 재고 차감 직접 검증 | `product-remaining-load.js` | `K6_REMAINING_RATE`, `duration=1m`, `delta=-1`, 40~160 RPS는 상품 pool `100`, pre/max VU `500 / 2000`, 240 RPS는 pool `300`, pre/max VU `800 / 3000` | `setup()`에서 seller token으로 상품 pool 생성. 본문에서는 상품을 랜덤 선택해 `PATCH /api/v1/products/{id}/remaining?delta=-1`만 직접 호출. `teardown()`에서 setup 상품 삭제 |

주문 API 테스트와 재고차감 직접 테스트의 관계:

| 구분 | 목적 | 호출 경로 |
|---|---|---|
| 주문 API 테스트 | 실제 소비자 주문 흐름의 한계 확인 | `k6 buyer -> POST /api/v1/orders/ -> order-service -> product-service remaining 내부 호출` |
| 재고차감 직접 테스트 | 주문 실패 원인이 product remaining API 자체 한계인지 분리 | `k6 seller -> PATCH /api/v1/products/{id}/remaining?delta=-1 -> product-service` |

따라서 재고차감 직접 테스트는 주문 API 테스트를 대체한 것이 아니라, 주문 API 테스트에서 보인 409/지연의 원인을 좁히기 위해 추가한 분리 검증이다.

## 3. 소비자 관점 시나리오

### 3.1 상품 탐색 시나리오

사용자 흐름:

1. 소비자가 앱에 진입한다.
2. 현재 위치 또는 카테고리 조건으로 상품 목록을 조회한다.
3. 페이지네이션 또는 카테고리 변경으로 목록 조회가 반복된다.

확인 API:

| Method | API | 주요 파라미터 | 인증 |
|---|---|---|---|
| `GET` | `/api/v1/products/` | `user_lat`, `user_lng`, `limit`, `offset`, `category` | 없음 또는 선택 |

부하검증 방식:

- k6 `constant-arrival-rate` 방식으로 목표 RPS를 고정
- `20 -> 40 -> 80 -> 120 -> 150 -> 155 -> 160 -> 180 -> 200 RPS` 순서로 상향
- 응답 성공률, 5xx/502, p95, dropped iteration을 확인

확인 결과:

| 구간 | 결과 |
|---:|---|
| `150 RPS` | 실패 0%, p95 `616.31ms` |
| `155 RPS` | 통과, p95 `677ms` |
| `160 RPS` | 첫 502 1건, p95 `790.4ms` |
| `180 RPS` | 502 2건, p95 `1.66s` |
| `200 RPS` | 5xx는 없었지만 p95 약 `12s`, dropped 413 |

판단:

- 소비자 상품 조회는 `150 RPS`까지 안정 구간으로 본다.
- `160 RPS`부터 실패 신호가 시작된다.
- `200 RPS`는 오류보다 응답 지연과 처리량 한계가 더 명확하다.

### 3.2 주문 생성 시나리오

사용자 흐름:

1. 소비자가 상품을 선택한다.
2. 주문 생성 API를 호출한다.
3. 서버 내부에서 주문 생성 중 상품 조회와 재고 차감이 수행된다.

확인 API:

| Method | API | 주요 Body | 인증 |
|---|---|---|---|
| `POST` | `/api/v1/orders/` | `store_id`, `store_name`, `payment_method`, `total_price`, `pickup_expected_at`, `items[]` | buyer JWT cookie |

주문 생성 내부 호출:

| 호출 주체 | Method | API | 목적 |
|---|---|---|---|
| `order-service` | `GET` | `/api/v1/products/{product_id}` | 상품 확인 |
| `order-service` | `PATCH` | `/api/v1/products/{product_id}/remaining?delta=-quantity` | 재고 차감 |

중요: 소비자 앱은 재고 차감 API를 직접 호출하지 않는다. 재고 차감은 `POST /api/v1/orders/` 처리 중 서버가 내부적으로 수행한다.

부하검증 방식:

- seller token으로 주문용 상품 pool을 먼저 생성
- buyer token으로 `POST /api/v1/orders/` 반복 호출
- 초기 2~5 RPS는 상품 pool 20개, 재검증 5~10 RPS는 pool 100개, 20 RPS 한계 검증은 pool 200개로 실행
- 단일 상품 충돌을 줄이기 위해 상품 pool을 단계적으로 확대
- 주문 payload는 `store_id`, `store_name`, `payment_method=toss`, `pickup_expected_at=18:00`, `items[{ product_id, product_name, quantity=1, unit_price=8000 }]` 구조로 생성
- RPS별 1분 실행, pre/max VU는 5~10 RPS `100/1000`, 20 RPS `300/1500`
- 주문 API 결과와 동시에 내부 product-service probe를 수행해 service/DNS 상시 장애 여부를 분리

확인 결과:

| 구간 | 결과 |
|---:|---|
| `2 RPS` | 121건 201, 409/5xx 0 |
| `5 RPS` 1차 | 288건 201, 409 13건, 5xx 0 |
| `5 RPS` 재검증 | 300건 201, 409 1건, 5xx 0 |
| `10 RPS` 재검증 | 578건 201, 409 22건, 5xx 0 |
| `10 RPS + 내부 probe` | 주문 601/601건 201, product-service probe 900/900건 200 |
| `20 RPS` | 1,103/1,103건 201, p95 `29.55s`, max `43.19s`, dropped 98 |

판단:

- 주문 생성은 낮은 RPS에서도 409가 간헐적으로 발생했다.
- 같은 10 RPS에서도 통과/실패가 모두 관찰되어 product-service DNS/Service 상시 장애로 보기는 어렵다.
- `10 RPS`는 통과 구간으로 확정하지 않고, 재현성 불안정 구간으로 기록한다.
- 20 RPS에서는 오류가 아니라 응답 지연이 한계다. 모두 201이어도 p95가 30초에 가까워 운영 기준상 실패 구간이다.
- 핵심 의심 지점은 `order-service -> product-service` 내부 호출의 timeout/retry/connection 설정과 HPA/GitOps 스케일링 충돌이다.

## 4. 판매자 관점 시나리오

### 4.1 상품 생성/삭제 시나리오

사용자 흐름:

1. 판매자가 자기 매장에 상품을 등록한다.
2. 등록된 상품을 삭제하거나 테스트 데이터 cleanup을 수행한다.

확인 API:

| Method | API | 주요 Body/Param | 인증 |
|---|---|---|---|
| `POST` | `/api/v1/products/?store_id={storeId}` | 상품명, 원가, 할인가, 수량, 카테고리, 설명 등 | seller JWT cookie |
| `DELETE` | `/api/v1/products/{productId}` | path `productId` | seller JWT cookie |

부하검증 방식:

- 같은 iteration에서 상품 생성 후 삭제까지 수행
- 상품 payload는 `create-load-product-{run}-{VU}-{ITER}` 이름, `original_price=10000`, `discount_price=8000`, `remaining=1000`, `category=베이커리` 기준
- RPS별 1분 실행, 2~40 RPS는 pre/max VU `500/2000`, 80 RPS는 `300/1500`
- 이 시나리오는 target RPS가 iteration/s 기준이다. 한 iteration에서 create와 delete를 모두 호출하므로 HTTP request/s는 target RPS의 약 2배가 된다.
- `2 -> 5 -> 10 -> 20 -> 40 -> 80 RPS` 순서로 상향
- create 201, delete 204, 5xx/502, p95, dropped를 확인

확인 결과:

| 구간 | 결과 |
|---:|---|
| `2 RPS` | 통과, 실패 0% |
| `5 RPS` | 통과, 실패 0% |
| `10 RPS` | 통과, 실패 0% |
| `20 RPS` | 통과, 실패 0% |
| `40 RPS` | 통과, 실패 0%, p95 `93.76ms` |
| `80 RPS` | create 502 6건, create p95 `676.94ms`, VU max 77, dropped 0 |

판단:

- 판매자 상품 생성/삭제는 `40 RPS`까지 안정 구간으로 본다.
- `80 RPS`에서 create 502가 발생했다.
- VU max 77, dropped 0이므로 k6 클라이언트 VU 부족으로 보기 어렵다.
- 생성에 성공한 상품 삭제는 모두 204로 처리되어 삭제보다 생성 경로/ingress 502 원인 확인이 우선이다.

### 4.2 재고 차감 직접 검증 시나리오

한 줄 설명: 주문 API를 거치지 않고 product-service의 재고차감 API만 따로 때려본 원인 분리 테스트다.

실제 주문 흐름에서는 소비자가 재고차감 API를 직접 호출하지 않는다.

```text
소비자 -> POST /api/v1/orders/ -> order-service -> PATCH /api/v1/products/{id}/remaining -> product-service
```

이번 직접 검증은 아래처럼 주문 API와 order-service를 빼고 product-service의 remaining API만 단독으로 호출했다.

```text
테스트팀 k6 -> PATCH /api/v1/products/{id}/remaining?delta=-1 -> product-service
```

이렇게 분리한 이유는 주문 생성 실패 원인을 `order-service 문제`, `order-service -> product-service 내부 호출 문제`, `product remaining API 자체 한계`, `인프라/스케일링 문제`로 나눠 보기 위해서다.

확인 API:

| Method | API | 주요 Param | 인증 |
|---|---|---|---|
| `PATCH` | `/api/v1/products/{productId}/remaining?delta=-1` | `delta=-1` | seller JWT cookie |

부하검증 방식:

- setup에서 상품 pool을 생성
- pool 내 상품을 랜덤 선택해 remaining API 직접 호출
- 40~160 RPS는 상품 pool 100개, 240 RPS는 상품 pool 300개로 실행
- 각 상품은 초기 재고 `100000`, 호출 delta는 `-1`
- RPS별 1분 실행, 40~160 RPS는 pre/max VU `500/2000`, 240 RPS는 `800/3000`
- `40 -> 80 -> 120 -> 160 -> 240 RPS` 순서로 상향
- 200, 409, 5xx, timeout/status 0, p95, VU max, dropped를 확인

확인 결과:

| 구간 | 200 | 409 | 5xx | p95 | Dropped |
|---:|---:|---:|---:|---:|---:|
| `40 RPS` | 2,400 | 0 | 0 | `36.07ms` | 0 |
| `80 RPS` | 4,801 | 0 | 0 | `36.58ms` | 0 |
| `120 RPS` | 7,201 | 0 | 0 | `40.46ms` | 0 |
| `160 RPS` | 9,601 | 0 | 0 | `81.45ms` | 0 |
| `240 RPS` | 553 | 0 | 860 | `9.21s` | 5,790 |

판단:

- product remaining API 자체는 단독 호출 기준 `160 RPS`까지 안정적이다.
- 따라서 주문 생성 `10~20 RPS`에서 보인 문제를 product remaining API 자체의 160 RPS 이하 처리 한계로 바로 단정하기는 어렵다.
- 주문 쪽 문제는 `order-service -> product-service` 내부 호출 timeout, retry, connection pool, keep-alive 설정과 HPA/GitOps 스케일링 충돌을 우선 확인해야 한다.
- `240 RPS`에서는 timeout/status other 7,198건, 5xx 860건, VU max 3000, dropped 5,790으로 명확한 실패 구간이다.
- 다만 product remaining API도 `240 RPS`에서는 자체 한계가 드러났으므로, 이후 인프라 개선 후 `160 -> 240 RPS` 구간을 다시 검증해야 한다.

## 5. 인프라 관점 한계

### 5.0 이전 로컬 k6 테스트 대비 차이

지난번 로컬 테스트는 로컬 WSL k6 runner에서 public API의 상품 조회 단일 경로를 중심으로 부분 한계치를 본 테스트였다. 1차 AWS 테스트는 같은 public API를 대상으로 하되, 소비자/판매자 역할별 실제 흐름과 AWS/EKS 관찰까지 확장해 주요 API별 한계 구간을 확인했다.

| 구분 | 지난번 로컬 k6 테스트 | 1차 AWS/public API 테스트 |
|---|---|---|
| 실행 위치 | 로컬 WSL k6 runner | 로컬 k6 runner + AWS/EKS 읽기 전용 관찰 |
| 주요 대상 | `GET /api/v1/products/` 상품 조회 | 상품 조회, 주문 생성, 상품 생성/삭제, 재고차감 직접 검증 |
| 테스트 관점 | 상품 조회 API 단일 경로의 부분 한계 확인 | 소비자/판매자 실제 시나리오별 주요 API 한계 확인 |
| 안정 구간 | 상품 조회 `150 RPS` | 상품 조회 `150 RPS`, 상품 생성/삭제 `40 RPS`, 재고차감 직접 `160 RPS` |
| 실패 신호 | `155 RPS` p95 1초 초과, `200 RPS` 500 121건 | 조회 `160 RPS` 첫 502, 주문 `20 RPS` p95 29.55초, 상품 생성 `80 RPS` 502, 재고차감 `240 RPS` timeout/5xx |
| 원인 해석 | product service DB connection pool timeout 근거가 강함 | DB 단독 원인 확정 아님. 내부 호출, HPA/GitOps, public 진입점 이슈를 함께 확인해야 함 |

핵심 차이:

- 로컬 k6 테스트는 전체 서비스 한계가 아니라 상품 조회 API 단일 경로의 DB pool/RDS 계열 병목을 좁히는 데 유효했다.
- 1차 AWS 테스트는 주문, 상품 생성, 재고차감까지 넓혀 실제 사용자 흐름에서 주요 API별 한계를 확인했다.
- 특히 주문 문제는 product remaining API 자체 한계보다 `order-service -> product-service` 내부 호출과 스케일링/진입점 문제를 우선 확인해야 하는 패턴으로 보인다.
- 따라서 두 테스트는 서로 모순되지 않는다. 로컬 테스트는 조회 API 부분 한계 근거이고, 1차 AWS 테스트는 역할별 end-to-end 흐름과 인프라 병목 근거다.

### 5.1 HPA/GitOps 충돌 의심

주문 20 RPS 직후 관찰:

- order HPA CPU: `380%/70%`
- HPA 상태: `2 current / 4 desired`
- deployment event: `Scaled up ... to 4 from 2`, `Scaled down ... to 2 from 4` 반복
- ArgoCD `sallijang-order`: `automated.selfHeal=true`, `prune=true`, `Synced/Healthy`

판단:

- HPA가 scale-out을 시도하지만 ArgoCD desired replicas가 다시 2로 되돌리는 패턴이 의심된다.
- 이 상태에서는 부하 중 pod scale-out이 유지되지 않아 지연이 커질 수 있다.

### 5.2 내부 호출 간헐 실패

주문 생성 실패 로그:

```text
[WARNING] 재고 수량 조정 실패 (...): All connection attempts failed
POST /api/v1/orders/ HTTP/1.1" 409 Conflict
```

반면 같은 시간대 내부 product-service probe는 900/900건 200으로 성공한 케이스가 있다.

판단:

- product-service DNS/Service가 상시 죽은 상태는 아니다.
- order-service에서 product-service로 가는 내부 호출이 부하 중 간헐적으로 실패하는 패턴이다.
- timeout, retry, keep-alive, connection pool, readiness 전환 시점 확인이 필요하다.

### 5.3 Public 진입점 불안정

추가 한계 테스트 후 확인:

- Route53 `api.sallijang.shop` A alias: `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com`
- 로컬 DNS에서 `api.sallijang.shop` 및 alias ALB DNS 해석 실패
- `ingress-nginx` namespace에 실행 중인 controller resource 미확인
- apiserver service proxy로 product endpoint 접근 시 503
- 재고 차감 240 RPS 테스트 teardown timeout으로 일부 테스트 상품 cleanup 보류 가능

판단:

- 이 시점 이후 추가 public API 테스트는 API 자체 처리 한계가 아니라 DNS/LB/ingress 장애 영향을 받을 수 있다.
- 추가 부하 테스트 전 진입점 복구와 cleanup이 먼저 필요하다.

### 5.4 DB 원인 확정 여부

현재 결과만으로 DB/RDS/connection pool을 단독 원인으로 확정하지 않는다. 주문 409 로그에는 내부 product-service 호출 실패가 남았고, 같은 시점 product-service probe가 900/900건 200으로 성공한 케이스도 있었다. DB/RDS/pool은 확인 대상이지만, 현재 보고서의 결론은 `내부 호출`, `HPA/GitOps`, `public 진입점`을 우선 점검해야 한다는 것이다.

## 6. 최종 요청사항

1. Route53 `api.sallijang.shop` alias 대상 ALB와 `ingress-nginx` controller 복구 확인
2. HPA 대상 Deployment의 `replicas`를 ArgoCD self-heal이 되돌리는지 확인하고 관리 정책 조정
3. `order-service -> product-service` 내부 호출 timeout, retry, connection pool, keep-alive 설정 확인
4. product pod scale-out/scale-down 또는 readiness 전환 중 내부 호출 실패가 발생하는지 확인
5. DB/RDS/connection pool은 확인하되, 단독 원인으로 단정하지 말고 내부 호출/스케일링 증거와 함께 검증
6. 내부 호출 실패를 비즈니스 409로 반환할지, 시스템 오류/별도 코드로 분리할지 정책 결정
7. `api.sallijang.shop` TLS 인증서 SAN 확인
8. 재고 차감 240 RPS 테스트 상품 cleanup 재시도

## 7. 재테스트 순서

인프라 조치 후 아래 순서로 다시 확인한다.

1. 라우팅 스모크: `/health`, `/api/v1/products/`, `/api/v1/auth/me`
2. 소비자 상품 조회: `150 -> 160 -> 180 -> 200 RPS`
3. 소비자 주문 생성: `5 -> 10 -> 20 -> 40 RPS`
4. 판매자 상품 생성/삭제: `40 -> 80 RPS`
5. 재고 차감 직접 검증: `160 -> 240 RPS`
6. 주문 부하 중 내부 product-service probe 동시 실행

## 8. 결과 경로

- API 호출 역할 매핑: `tests/performance/k6/sallijang/USER_ROLE_API_CALLS.md`
- 순차 상세 보고서: `tests/performance/results/20260505-sequential-test-report.md`
- 상세 쓰기 보고서: `tests/performance/results/20260505-public-api-write-scenarios-report.md`
- 최종 제출 패키지: `tests/performance/results/final-reports/aws-20260505`
