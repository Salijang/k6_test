# 공통 성능 테스트 시나리오

## 1. 상품 등록 burst

- 목적: 판매자 상품 등록 API의 처리량과 SKU 충돌 처리 확인
- 대상 API: `POST /stores/:storeId/products`
- 부하 포인트:
  - 동일 매장에 판매자 요청 집중
  - SKU unique 제약 충돌
  - 상품 row insert 지연
- 성공 기준:
  - 서버 오류율이 낮아야 함
  - 중복 SKU는 `409`로 빠르게 실패해야 함

## 2. 상품 목록 조회

- 목적: 고객/판매자 공통 조회 트래픽에서 목록 응답 성능 확인
- 대상 API: `GET /stores/:storeId/products`
- 부하 포인트:
  - 반복 조회 시 응답 시간 안정성
  - 매장별 데이터 분리 확인

## 3. 핫 슬롯 예약 경쟁

- 목적: 같은 상품과 같은 픽업 슬롯에 동시 예약이 몰릴 때 과예약 방지 확인
- 대상 API:
  - `GET /stores/:storeId/pickup-slots`
  - `POST /pickup-reservations`
- 부하 포인트:
  - 재고 차감
  - 슬롯 잔여 정원 차감
  - 트랜잭션/락 경합
- 성공 기준:
  - 슬롯 정원 초과 예약이 없어야 함
  - 재고가 음수가 되면 안 됨

## 4. 취소 후 재예약

- 목적: 취소 시 자원 복구와 뒤이은 재예약 처리 확인
- 대상 API:
  - `POST /pickup-reservations/:id/cancel`
  - `POST /pickup-reservations`
- 부하 포인트:
  - 재고 복원
  - 슬롯 잔여 정원 복원
  - 취소 직후 재예약 경쟁
