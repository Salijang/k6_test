# k6 성능 테스트 보고서 초안

## 1. 문서 개요

- 작성일: `YYYY-MM-DD`
- 작성자: `이름`
- 대상 프로젝트: `k6 Pickup Market Demo`
- 테스트 목적:
  로컬 3-tier 환경에서 조회, 쓰기 burst, 예약 경합, 상태 전이 시 API 안정성과 응답 성능을 검증한다.

## 2. 테스트 대상 및 범위

### 2.1 시스템 구성

- Frontend: React + Vite
- Backend: Fastify API
- Database: PostgreSQL
- Monitoring: Prometheus, Grafana
- Load Generator: k6

### 2.2 테스트 범위

- 상품 목록 조회 API 성능
- 판매자 상품 등록 burst 처리 성능
- 동일 픽업 슬롯 동시 예약 경합 처리
- 예약 취소 후 재예약 상태 전이 처리

### 2.3 테스트 제외 범위

- 브라우저 렌더링 성능
- 외부 연동 시스템
- 분산 환경/멀티 인스턴스 환경 검증

## 3. 테스트 환경

### 3.1 실행 환경

| 항목 | 값 |
| --- | --- |
| OS | `기입` |
| CPU | `기입` |
| Memory | `기입` |
| Node.js | `node -v 결과 기입` |
| npm/pnpm | `버전 기입` |
| k6 | `k6 version 결과 기입` |
| Docker | `docker version 결과 기입` |

### 3.2 로컬 실행 구성

| 구성요소 | 실행 방식 | 기본 주소 |
| --- | --- | --- |
| PostgreSQL | Docker Compose | `localhost:5432` |
| API | `npm run dev:api` | `http://localhost:4000` |
| Web | `npm run dev:web` | `http://localhost:15173` |
| Prometheus | `npm run monitoring:start` | `http://localhost:9090` |
| Grafana | `npm run monitoring:start` | `http://localhost:3000` |

### 3.3 사전 준비

```bash
npm install
cp .env.example .env
npm run db:start
npm run dev:api
npm run monitoring:start
```

주의:
- 로컬 개발 API를 대상으로 테스트할 때는 반드시 `K6_BASE_URL=http://localhost:4000` 을 지정한다.
- `tests/performance/k6/common.js` 의 기본값은 `http://localhost:14000` 이므로, 도커 통합 스택이 아니라면 환경변수 덮어쓰기가 필요하다.

## 4. 테스트 데이터 및 계정

### 4.1 기본 계정

- 판매자: `seller-seoul-central`
- 고객: `customer-minji`
- 매장: `store-seoul-central`

### 4.2 테스트 데이터 전제

- 대상 매장에 조회 가능한 상품이 최소 1개 이상 존재해야 한다.
- 대상 날짜에 픽업 슬롯이 최소 1개 이상 존재해야 한다.
- 예약 경쟁 테스트 전에 대상 상품 재고와 슬롯 잔여 수량이 충분해야 한다.

## 5. 시나리오 정의

### 5.1 시나리오 요약

| 시나리오 | 목적 | 대상 API | 성공 기준 |
| --- | --- | --- | --- |
| 상품 목록 조회 | 반복 조회 시 응답 안정성 확인 | `GET /stores/:storeId/products` | `200` 유지, 응답시간 안정 |
| 상품 등록 burst | 등록 처리량과 SKU 충돌 처리 확인 | `POST /stores/:storeId/products` | `201/409` 외 비정상 응답 최소화 |
| 핫 슬롯 예약 경쟁 | 과예약 방지와 경합 처리 확인 | `GET /pickup-slots`, `POST /pickup-reservations` | `500` 없어야 함, 과예약 없어야 함 |
| 취소 후 재예약 | 취소 후 자원 복구와 재예약 흐름 확인 | `POST /pickup-reservations`, `POST /pickup-reservations/:id/cancel` | 생성/취소 흐름 정상, 자원 복구 이상 없음 |

### 5.2 스크립트별 부하 설정

| 시나리오 | 스크립트 | Executor | 부하 설정 |
| --- | --- | --- | --- |
| 상품 목록 조회 | `tests/performance/k6/product-list-read.js` | `constant-vus` | `25 VUs`, `45s` |
| 상품 등록 burst | `tests/performance/k6/product-registration-burst.js` | `ramping-vus` | `1 -> 10 (15s)`, `10 -> 30 (30s)`, `30 -> 0 (10s)` |
| 핫 슬롯 예약 경쟁 | `tests/performance/k6/hot-slot-race.js` | `constant-arrival-rate` | `15 req/s`, `30s`, `preAllocatedVUs=30`, `maxVUs=60` |
| 취소 후 재예약 | `tests/performance/k6/cancel-and-rereserve.js` | `per-vu-iterations` | `10 VUs`, `10 iterations`, `maxDuration=1m` |

## 6. 실행 절차

### 6.1 권장 실행 순서

1. 상품 목록 조회
2. 상품 등록 burst
3. 핫 슬롯 예약 경쟁
4. 취소 후 재예약

### 6.2 실행 명령

```bash
K6_BASE_URL=http://localhost:4000 npm run k6:run:prometheus -- tests/performance/k6/product-list-read.js
K6_BASE_URL=http://localhost:4000 npm run k6:run:prometheus -- tests/performance/k6/product-registration-burst.js
K6_BASE_URL=http://localhost:4000 npm run k6:run:prometheus -- tests/performance/k6/hot-slot-race.js
K6_BASE_URL=http://localhost:4000 npm run k6:run:prometheus -- tests/performance/k6/cancel-and-rereserve.js
```

### 6.3 테스트 식별자 예시

```bash
K6_BASE_URL=http://localhost:4000 K6_TESTID=list-read-01 npm run k6:run:prometheus -- tests/performance/k6/product-list-read.js
```

권장 사항:
- 시나리오별로 `K6_TESTID` 를 명시해 Grafana에서 구분한다.
- 각 테스트 사이에 짧은 정리 시간을 둔다.
- 테스트 중 API 로그와 Docker 컨테이너 상태를 함께 확인한다.

## 7. 측정 지표

### 7.1 공통 지표

- 총 요청 수
- 초당 요청 수
- 평균 응답시간
- p90 응답시간
- p95 응답시간
- 최대 응답시간
- 실패율
- 상태코드 분포

### 7.2 시나리오별 검증 포인트

| 시나리오 | 추가 확인 항목 |
| --- | --- |
| 상품 목록 조회 | 응답시간 분산, 조회 응답 형태 정상 여부 |
| 상품 등록 burst | `201`, `409` 비율, `401/403/500` 발생 여부 |
| 핫 슬롯 예약 경쟁 | `201`, `409` 비율, `500` 발생 여부, 과예약 여부 |
| 취소 후 재예약 | 생성 성공 후 취소 성공 여부, 복구 후 재예약 가능 여부 |

## 8. 결과 요약

### 8.1 요약 표

| 시나리오 | 총 요청 수 | 성공률 | 에러율 | 평균 응답시간 | p95 응답시간 | 최대 응답시간 | 결론 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 상품 목록 조회 | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 상품 등록 burst | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 핫 슬롯 예약 경쟁 | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 취소 후 재예약 | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |

### 8.2 주요 관찰 내용

- 예시: 목록 조회는 전체적으로 안정적이었으며 `p95` 응답시간이 허용 범위 내에 유지되었다.
- 예시: 상품 등록 burst 구간에서 `409` 응답은 의도된 충돌 처리로 해석할 수 있다.
- 예시: 예약 경쟁 시 `500` 이 발생하지 않았다면 서버 안정성은 확보된 것으로 볼 수 있다.
- 예시: 취소 후 재예약 흐름에서 자원 복구 이상 여부를 추가 확인해야 한다.

## 9. 상태코드 해석 기준

| 상태코드 | 의미 | 이 프로젝트에서의 대표 사례 | 보고서 해석 |
| --- | --- | --- | --- |
| `200 OK` | 요청 정상 처리 | 목록 조회 성공, 예약 취소 성공 | 정상 성공 |
| `201 Created` | 자원 생성 성공 | 상품 등록 성공, 예약 생성 성공 | 정상 성공 |
| `400 Bad Request` | 요청 값 오류 | 필수 필드 누락, 잘못된 파라미터 | 테스트 입력 또는 검증 로직 문제 |
| `401 Unauthorized` | 인증 정보 없음 | `x-user-id` 누락 | 테스트 설정 오류 |
| `403 Forbidden` | 권한 없음 | 고객이 판매자 API 호출 | 권한 제어 검증 포인트 |
| `404 Not Found` | 대상 리소스 없음 | 없는 상품, 예약, 슬롯 조회 | 데이터 준비 문제 가능성 |
| `409 Conflict` | 현재 상태와 충돌 | 중복 SKU, 재고 부족, 슬롯 마감, 동시 예약 충돌 | 경합 시나리오에서는 정상 거절일 수 있음 |
| `500 Internal Server Error` | 서버 내부 오류 | 예외 처리 실패, DB 처리 오류 | 실제 장애로 봐야 함 |

해석 원칙:
- `200`, `201`은 비즈니스 성공으로 본다.
- `409`는 서버 장애가 아니라 비즈니스 규칙에 따른 충돌 거절일 수 있다.
- `500`은 실제 시스템 장애로 본다.
- `http_req_failed`는 `4xx`도 포함할 수 있으므로, 결과 해석 시 `check 통과율`과 상태코드 분포를 함께 기록한다.

## 10. 시나리오별 상세 분석

### 9.1 상품 목록 조회

#### 목적

- 고객/판매자 공통 조회 트래픽에서 목록 응답 성능 확인

#### 실행 조건

| 항목 | 값 |
| --- | --- |
| Script | `product-list-read.js` |
| Executor | `constant-vus` |
| Load | `25 VUs / 45s` |
| Base URL | `http://localhost:4000` |
| Test ID | `기입` |

#### 결과

| 항목 | 값 |
| --- | --- |
| 총 요청 수 | `기입` |
| 평균 응답시간 | `기입` |
| p95 응답시간 | `기입` |
| 에러율 | `기입` |

#### 해석

- `기입`

### 9.2 상품 등록 burst

#### 목적

- 판매자 상품 등록 API의 처리량과 SKU 충돌 처리 확인

#### 실행 조건

| 항목 | 값 |
| --- | --- |
| Script | `product-registration-burst.js` |
| Executor | `ramping-vus` |
| Load | `1 -> 10 (15s), 10 -> 30 (30s), 30 -> 0 (10s)` |
| Base URL | `http://localhost:4000` |
| Test ID | `기입` |

#### 결과

| 항목 | 값 |
| --- | --- |
| 총 요청 수 | `기입` |
| `201` 비율 | `기입` |
| `409` 비율 | `기입` |
| 평균 응답시간 | `기입` |
| p95 응답시간 | `기입` |
| 비정상 응답 | `기입` |

#### 해석

- `409` 는 중복/충돌 제어가 정상 동작한 결과인지 구분해서 해석한다.
- `401`, `403`, `500` 발생 시 원인을 별도 분석한다.

### 9.3 핫 슬롯 예약 경쟁

#### 목적

- 같은 상품과 같은 픽업 슬롯에 동시 예약이 몰릴 때 과예약 방지 확인

#### 실행 조건

| 항목 | 값 |
| --- | --- |
| Script | `hot-slot-race.js` |
| Executor | `constant-arrival-rate` |
| Load | `15 req/s, 30s` |
| VU Pool | `preAllocatedVUs=30, maxVUs=60` |
| Base URL | `http://localhost:4000` |
| Test ID | `기입` |

#### 결과

| 항목 | 값 |
| --- | --- |
| 총 요청 수 | `기입` |
| `201` 비율 | `기입` |
| `409` 비율 | `기입` |
| `500` 발생 여부 | `기입` |
| 평균 응답시간 | `기입` |
| p95 응답시간 | `기입` |

#### 해석

- 핵심은 응답시간보다 과예약 방지와 서버 오류 미발생 여부다.
- 필요하면 테스트 전후 데이터 조회로 재고/슬롯 수량 정합성을 추가 검증한다.

### 9.4 취소 후 재예약

#### 목적

- 취소 시 자원 복구와 뒤이은 재예약 처리 확인

#### 실행 조건

| 항목 | 값 |
| --- | --- |
| Script | `cancel-and-rereserve.js` |
| Executor | `per-vu-iterations` |
| Load | `10 VUs, 10 iterations, maxDuration=1m` |
| Base URL | `http://localhost:4000` |
| Test ID | `기입` |

#### 결과

| 항목 | 값 |
| --- | --- |
| 생성 성공 수 | `기입` |
| 취소 성공 수 | `기입` |
| 충돌 응답 수 | `기입` |
| 평균 응답시간 | `기입` |
| p95 응답시간 | `기입` |

#### 해석

- 생성 후 취소까지의 상태 전이가 정상인지 확인한다.
- 자원 복구가 지연되거나 누락되는지 로그와 메트릭을 함께 본다.

## 11. 종합 결론

### 10.1 결론 요약

- `기입`

### 10.2 확인된 문제점

- `기입`

### 10.3 개선 방안

- API별 threshold 정의 추가
- 상태코드별 커스텀 메트릭 분리
- 테스트 전후 데이터 정합성 검증 스크립트 추가
- 시나리오별 테스트 데이터 초기화 절차 문서화
- 필요 시 soak/stress 시나리오 추가

## 12. 부록

### 11.1 Grafana 확인 항목

- `k6 / k6 Load Test Overview` 대시보드 확인
- `testid` 태그 기준으로 시나리오별 필터링
- `http_req_duration`, `http_reqs`, `iterations`, `checks`, `vus` 확인

### 11.2 실행 로그 첨부 위치

- 콘솔 로그: `기입`
- Grafana 스크린샷: `기입`
- Prometheus 쿼리 캡처: `기입`

### 11.3 참고 자료

- [tests/performance/README.md](/home/system/workspace/k6testDemo/tests/performance/README.md)
- [tests/performance/shared/scenarios.md](/home/system/workspace/k6testDemo/tests/performance/shared/scenarios.md)
- [tests/performance/k6/product-list-read.js](/home/system/workspace/k6testDemo/tests/performance/k6/product-list-read.js)
- [tests/performance/k6/product-registration-burst.js](/home/system/workspace/k6testDemo/tests/performance/k6/product-registration-burst.js)
- [tests/performance/k6/hot-slot-race.js](/home/system/workspace/k6testDemo/tests/performance/k6/hot-slot-race.js)
- [tests/performance/k6/cancel-and-rereserve.js](/home/system/workspace/k6testDemo/tests/performance/k6/cancel-and-rereserve.js)
