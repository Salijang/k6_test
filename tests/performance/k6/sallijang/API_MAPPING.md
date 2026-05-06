# Sallijang API Mapping

이 문서는 k6 스크립트가 실제 Salijang 백엔드 API와 어떤 전제로 연결되는지 정리한다.

확인 기준:

- `Salijang/sallijang-backend-product`
- `Salijang/sallijang-backend-order`
- `Salijang/sallijang-manifest`
- 확인일: 2026-05-04

## Ingress

`sallijang-manifest/base/ingress/ingress.yaml` 기준 외부 host는 아래다.

```text
api.sallijang.shop
```

path 라우팅:

| Path prefix | Service |
| --- | --- |
| `/api/v1/auth` | `user-service` |
| `/api/v1/users` | `user-service` |
| `/api/v1/wishlist` | `user-service` |
| `/api/v1/stores` | `product-service` |
| `/api/v1/products` | `product-service` |
| `/api/v1/reviews` | `product-service` |
| `/api/v1/orders` | `order-service` |
| `/api/v1/notifications` | `notify-service` |

따라서 외부 k6 기본값은 아래처럼 둔다.

```bash
export K6_BASE_URL=https://api.sallijang.shop
```

## Auth

product/order 보호 API는 JWT를 `Authorization` 헤더가 아니라 `access_token` 쿠키에서 읽는다.

```text
Cookie: access_token=<jwt>
```

k6에서는 단순 smoke용 fallback으로 아래 변수를 사용할 수 있다.

```bash
export K6_ACCESS_TOKEN="..."
```

실제 권한 모델에 맞추려면 seller/buyer token을 분리한다.

```bash
export K6_SELLER_ACCESS_TOKEN="seller-token"
export K6_BUYER_ACCESS_TOKEN="buyer-token"
```

여러 buyer token을 분산하려면:

```bash
export K6_BUYER_ACCESS_TOKENS="buyer-token1,buyer-token2,buyer-token3"
```

주의:

- 상품 생성/삭제는 store owner 검사를 하므로 해당 store의 seller token이 필요하다.
- 주문 생성의 `buyer_id`는 request body가 아니라 JWT의 `user_id`에서 결정된다.

## Product Service

소스 기준: `sallijang-backend-product/routers/products.py`, `schemas.py`

### List Products

```text
GET /api/v1/products/
```

query:

| Name | Type | Required | Note |
| --- | --- | --- | --- |
| `store_id` | int | no | 특정 가게 상품만 조회 |
| `category` | string | no | 카테고리 필터 |
| `user_lat` | float | no | 거리 계산/정렬 |
| `user_lng` | float | no | 거리 계산/정렬 |
| `limit` | int | no | 기본 20 |
| `offset` | int | no | 기본 0 |

k6 scripts:

- `product-list-load.js`
- `product-list-step-load.js`
- `product-list-spike.js`
- `buyer-journey-soak.js`
- `stress/product-list-read-stress.js`

### Create Product

```text
POST /api/v1/products/?store_id=<store_id>
Cookie: access_token=<seller_jwt>
```

body:

```json
{
  "name": "k6-product",
  "original_price": 10000,
  "discount_price": 8000,
  "remaining": 100000,
  "total_quantity": 100000,
  "expiry_minutes": 60,
  "pickup_deadline": null,
  "category": "베이커리",
  "image_url": null,
  "weight": null,
  "description": "k6 generated product",
  "is_deleted": false
}
```

owner check:

```text
store.owner_id == current_user.user_id
```

### Adjust Remaining

```text
PATCH /api/v1/products/{product_id}/remaining?delta=-1
```

expected status:

- `200`: 차감/복원 성공
- `409`: 재고 부족
- `404`: 상품 없음

k6 script:

- `stress/product-remaining-race-stress.js`

### Delete Product

```text
DELETE /api/v1/products/{product_id}
Cookie: access_token=<seller_jwt>
```

soft delete 방식이다.

## Order Service

소스 기준: `sallijang-backend-order/routers/orders.py`, `schemas.py`

### Create Order

```text
POST /api/v1/orders/
Cookie: access_token=<buyer_jwt>
```

body:

```json
{
  "store_id": 1,
  "store_name": "Stress Test Store",
  "payment_method": "toss",
  "total_price": 8000,
  "pickup_expected_at": "18:00",
  "items": [
    {
      "product_id": 1,
      "product_name": "k6-product",
      "quantity": 1,
      "unit_price": 8000
    }
  ]
}
```

important behavior:

- `buyer_id`는 body가 아니라 JWT의 `user_id`에서 설정된다.
- 주문 생성 중 product-service를 호출한다.
  - `GET /api/v1/products/{product_id}`
  - `PATCH /api/v1/products/{product_id}/remaining?delta=-quantity`
- Redis 재고 선점 실패 또는 product-service 실패에 따라 `409` 또는 `503`이 발생할 수 있다.
- 주문 생성 후 notify event를 SQS로 publish한다.

k6 scripts:

- `order-create-load.js`
- `buyer-journey-soak.js`
- `stress/order-create-stress.js`

## Current Gaps

아래 값은 실제 환경에서 받아야 한다.

- 부하테스트용 seller JWT
- 부하테스트용 buyer JWT 또는 buyer JWT pool
- seller JWT가 소유한 `K6_STORE_ID`
- 테스트 대상 환경의 DB seed 상태
- 운영/개발 환경별 목표 RPS와 p95 기준
