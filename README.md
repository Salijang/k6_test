# K6 Pickup Market Demo

`k6` 연습용으로 만든 멀티매장 픽업 예약 마켓 데모 앱이다. 판매자는 자기 매장 상품을 등록하고 예약 상태를 운영하며, 고객은 매장별 상품을 조회하고 픽업 슬롯을 예약/취소할 수 있다.

## Stack

- Frontend: React + Vite
- API: Fastify
- Database: PostgreSQL
- Test: Vitest

## Structure

- `apps/web`: 판매자/고객 UI
- `apps/api`: Fastify API, 메모리 스토어, PostgreSQL 스토어
- `tests/performance`: k6/nGrinder용 성능 테스트 자산

## Run

1. 의존성 설치

```bash
npm install
```

2. PostgreSQL 실행

```bash
cp .env.example .env
npm run db:start
```

3. API 실행

```bash
npm run dev:api
```

`DATABASE_URL`가 없으면 API는 메모리 스토어로 동작한다. 실제 3-tier 연습은 PostgreSQL 연결 상태에서 진행하는 편이 맞다.

4. Frontend 실행

```bash
npm run dev:web
```

## Demo accounts

- Sellers
  - `seller-seoul-central`
  - `seller-busan-harbor`
  - `seller-incheon-terminal`
  - `seller-daegu-station`
- Customers
  - `customer-minji`
  - `customer-jisoo`
  - `customer-junho`
  - `customer-seoyeon`

UI에서 바로 계정을 고를 수 있고, API/k6에서는 `x-user-id` 헤더를 사용하면 된다.

## API

- `GET /stores`
- `GET /demo-users`
- `GET /stores/:storeId/products`
- `POST /stores/:storeId/products`
- `PATCH /stores/:storeId/products/:productId`
- `GET /stores/:storeId/pickup-slots?date=YYYY-MM-DD`
- `POST /pickup-reservations`
- `GET /stores/:storeId/reservations?date=YYYY-MM-DD`
- `PATCH /pickup-reservations/:id/status`
- `POST /pickup-reservations/:id/cancel`

## Validate

```bash
npm run build
npm test
```

## Performance assets

- 시나리오 설명: [tests/performance/shared/scenarios.md](/home/system/workspace/k6testDemo/tests/performance/shared/scenarios.md)
- 실행 방법: [tests/performance/README.md](/home/system/workspace/k6testDemo/tests/performance/README.md)

