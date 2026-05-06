# User Role API Calls

작성일: 2026-05-05 KST

## 확인 범위

이 레포에는 두 종류의 API 호출 정보가 있다.

1. `apps/web`: 현재 레포에 들어있는 데모 프론트 앱의 실제 호출 코드
2. `tests/performance/k6/sallijang`: Sallijang public API 부하테스트에서 확인한 실제 `/api/v1/*` 호출

실제 Sallijang 운영 프론트 소스는 이 레포에 없으므로, 아래의 `/api/v1/*` 목록은 현재 k6 스크립트와 API 매핑 문서 기준이다.

## 1. `apps/web` 데모 앱 기준

기본 API base URL: `VITE_API_BASE_URL`, 기본값 `http://localhost:4000`

인증 방식: 보호 API는 `x-user-id` 헤더로 actor를 전달한다.

### 공통 초기 로딩

| 화면/동작 | Method | API | 호출 위치 | 비고 |
|---|---|---|---|---|
| 매장 목록 로딩 | `GET` | `/stores` | `bootstrap()` | 소비자/판매자 공통 |
| 데모 사용자 목록 로딩 | `GET` | `/demo-users` | `bootstrap()` | 역할 선택용 |

### 소비자 사용자 `customer`

| 화면/동작 | Method | API | Header/Body | 호출 위치 |
|---|---|---|---|---|
| 매장/날짜 변경 시 상품 조회 | `GET` | `/stores/{storeId}/products` | 없음 | `refreshStoreData()` |
| 매장/날짜 변경 시 픽업 슬롯 조회 | `GET` | `/stores/{storeId}/pickup-slots?date=YYYY-MM-DD` | 없음 | `refreshStoreData()` |
| 픽업 예약 생성 | `POST` | `/pickup-reservations` | `x-user-id: <customerId>` / `{ storeId, productId, slotId, quantity }` | `handleCreateReservation()` |
| 예약 취소 | `POST` | `/pickup-reservations/{reservationId}/cancel` | `x-user-id: <customerId>` | `handleCancelReservation()` |

소비자 앱 특이점:

- 소비자 예약 내역은 현재 세션 state에만 저장된다.
- 소비자 화면에서는 별도 `GET /my-reservations` 같은 API를 호출하지 않는다.
- 예약 생성/취소 후에는 상품/슬롯 최신화를 위해 다시 `GET /stores/{storeId}/products`, `GET /stores/{storeId}/pickup-slots`를 호출한다.

### 판매자 사용자 `seller`

| 화면/동작 | Method | API | Header/Body | 호출 위치 |
|---|---|---|---|---|
| 판매자 매장 상품 조회 | `GET` | `/stores/{storeId}/products` | 없음 | `refreshStoreData()` |
| 판매자 매장 픽업 슬롯 조회 | `GET` | `/stores/{storeId}/pickup-slots?date=YYYY-MM-DD` | 없음 | `refreshStoreData()` |
| 날짜별 예약 현황 조회 | `GET` | `/stores/{storeId}/reservations?date=YYYY-MM-DD` | `x-user-id: <sellerId>` | `refreshStoreData()` |
| 상품 등록 | `POST` | `/stores/{storeId}/products` | `x-user-id: <sellerId>` / `{ sku, name, description, price, stock, status }` | `handleCreateProduct()` |
| 재고/판매상태 수정 | `PATCH` | `/stores/{storeId}/products/{productId}` | `x-user-id: <sellerId>` / `{ stock }` 또는 `{ status }` | `handleQuickProductUpdate()` |
| 예약 상태 변경 | `PATCH` | `/pickup-reservations/{reservationId}/status` | `x-user-id: <sellerId>` / `{ status: READY | PICKED_UP | NO_SHOW }` | `handleReservationStatus()` |

판매자 앱 특이점:

- 판매자는 자기 `storeId`에 대해서만 상품 생성/수정/예약 조회가 가능하다.
- 백엔드에서 `assertSeller(actor, storeId)`로 권한을 검사한다.
- 예약 상태 변경도 해당 예약의 `storeId`가 판매자 소유 매장인지 검사한다.

## 2. Sallijang public API 기준

기본 host: `https://api.sallijang.shop`

인증 방식: JWT를 `Authorization` 헤더가 아니라 `access_token` 쿠키로 전달한다.

### 공통 인증/준비

| 사용자 | Method | API | 목적 |
|---|---|---|---|
| seller/buyer | `POST` | `/api/v1/auth/signup` | 테스트 사용자 가입 |
| seller/buyer | `POST` | `/api/v1/auth/login` | `access_token` 쿠키 발급 |
| 인증 사용자 | `GET` | `/api/v1/auth/me` | 인증 라우팅 확인 |

### 소비자 사용자 `buyer`

| 화면/동작 | Method | API | 주요 파라미터/Body | 부하테스트 스크립트 |
|---|---|---|---|---|
| 상품 목록 조회 | `GET` | `/api/v1/products/` | `user_lat`, `user_lng`, `limit`, `offset`, `category` | `product-list-load.js`, `product-list-step-load.js`, `product-list-spike.js`, `buyer-journey-soak.js` |
| 주문 생성 | `POST` | `/api/v1/orders/` | `{ store_id, store_name, payment_method, total_price, pickup_expected_at, items[] }` | `order-create-load.js`, `buyer-journey-soak.js`, `smoke.js` |

주문 생성 참고:

- `buyer_id`는 request body가 아니라 buyer JWT의 `user_id`에서 결정된다.
- 주문 생성 중 order-service가 product-service를 내부 호출한다.
  - `GET /api/v1/products/{product_id}`
  - `PATCH /api/v1/products/{product_id}/remaining?delta=-quantity`

### 판매자 사용자 `seller`

| 화면/동작 | Method | API | 주요 파라미터/Body | 부하테스트 스크립트 |
|---|---|---|---|---|
| 매장 생성 | `POST` | `/api/v1/stores/` | `{ name, latitude, longitude, address, address_detail }` | `prepare-sallijang-test-env.sh` |
| 상품 생성 | `POST` | `/api/v1/products/?store_id={storeId}` | 상품명, 가격, 수량, 카테고리, 설명 등 | `product-create-load.js`, setup helper |
| 재고 차감/복원 직접 호출 | `PATCH` | `/api/v1/products/{productId}/remaining?delta={delta}` | `delta=-1` 등 | `product-remaining-load.js` |
| 상품 삭제 | `DELETE` | `/api/v1/products/{productId}` | 없음 | `product-create-load.js`, cleanup helper |

판매자 API 참고:

- 상품 생성/삭제는 해당 store owner seller JWT가 필요하다.
- 재고 차감 직접 호출은 실제 앱 화면 호출이 아니라, 테스트팀이 product-service remaining API 자체 한계를 분리하기 위해 사용한 검증이다.
- 실제 주문에서는 소비자가 이 API를 직접 호출하지 않고 `POST /api/v1/orders/` 처리 중 `order-service`가 내부 호출한다.

## 3. 아직 앱 호출로 확인되지 않은 라우트

Ingress에는 아래 prefix가 있지만, 현재 `apps/web` 또는 k6 스크립트에서 실제 사용자 플로우 호출로 확인되지는 않았다.

| Prefix | Service | 비고 |
|---|---|---|
| `/api/v1/users` | `user-service` | 사용자 관리/프로필 가능성 |
| `/api/v1/wishlist` | `user-service` | 찜 기능 가능성. runbook에는 `/wishlists` vs `/wishlist` 불일치 이슈 기록 있음 |
| `/api/v1/reviews` | `product-service` | 리뷰 기능 가능성 |
| `/api/v1/notifications` | `notify-service` | 알림 기능 가능성 |

## 4. 부하테스트 관점 분류

소비자 부하:

- 상품 목록 조회: `GET /api/v1/products/`
- 주문 생성: `POST /api/v1/orders/`
- 혼합 여정: 상품 조회 후 일정 확률로 주문 생성

판매자 부하:

- 상품 생성/삭제: `POST /api/v1/products/?store_id=...` + `DELETE /api/v1/products/{id}`
- 재고 차감 직접 호출: `PATCH /api/v1/products/{id}/remaining?delta=-1`

공통/준비 부하:

- 가입/로그인은 테스트 setup 성격이다. 본 부하 시나리오에는 보통 포함하지 않고 사전 토큰 발급으로 처리한다.
