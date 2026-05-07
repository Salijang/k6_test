# k6 데모앱 성능 테스트 최종보고서

- 작성일: `2026-04-23`
- Run ID: `20260423-final-report`
- 대상 프로젝트: `k6 Pickup Market Demo`
- 실행 대상: 자원 제한 Docker Compose 스택
- Base URL: `http://localhost:14000`
- 측정 방식: `k6 -> API -> PostgreSQL`, `Prometheus/Grafana` 수집

## 1. 목적과 범위

이번 테스트는 `k6 Pickup Market Demo`의 핵심 성능 시나리오를 로컬 3-tier baseline 환경에서 검증하기 위해 수행했다. 대상은 `상품 목록 조회`, `상품 등록 burst`, `핫 슬롯 예약 경쟁`, `판매자 예약 운영 상태 전이`, `취소 후 재예약`이며, 별도 보완 테스트로 `상품 목록 조회 capacity`를 추가 수행했다.

본 결과는 단일 호스트와 단일 load generator 기준의 로컬 baseline이므로 운영 절대 수용량 보증 문서로 해석하기보다, 현재 구현의 안정성 확인과 회귀 검증 기준으로 활용하는 것이 적절하다.

## 2. 실행 구성

- API: `1.0 CPU / 768MB`
- PostgreSQL: `1.0 CPU / 1024MB`
- Web: `0.5 CPU / 256MB`
- Prometheus: `0.5 CPU / 512MB`
- Grafana: `0.5 CPU / 384MB`
- k6는 호스트에서 실행해 앱 컨테이너 자원과 분리했다.

로그 위치:

- `tests/performance/results/final-reports/local-20260423/product-list-read.log`
- `tests/performance/results/final-reports/local-20260423/product-registration-burst.log`
- `tests/performance/results/final-reports/local-20260423/hot-slot-race.log`
- `tests/performance/results/final-reports/local-20260423/reservation-status-flow.log`
- `tests/performance/results/final-reports/local-20260423/cancel-and-rereserve.log`
- `tests/performance/results/final-reports/local-20260423/product-list-capacity.log`

## 3. 결과 요약

주의:
`http_req_failed`는 `409 Conflict`를 실패로 집계하므로, 경합 시나리오에서는 장애율 대신 `5xx 발생 여부`와 `check pass rate`를 기준으로 해석했다.

| 시나리오 | 총 HTTP 요청 | Check Pass Rate | 실제 장애율(`5xx`) | 핵심 비즈니스 결과 | 평균 | p95 | 최대 | 판단 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 상품 목록 조회 | `2250` | `100%` | `0%` | `200` 유지 | `3.04ms` | `5.9ms` | `65.28ms` | 안정적 |
| 상품 등록 burst | `820` | `100%` | `0%` | `201=140`, `409=680` | `12.47ms` | `18.56ms` | `40.6ms` | 충돌 정상 제어 |
| 핫 슬롯 예약 경쟁 | `907` | `100%` | `0%` | `201=6`, `409=445`, 과예약/음수 재고 없음 | `3.24ms` | `5.56ms` | `14.02ms` | 정합성 유지 |
| 판매자 예약 운영 상태 전이 | `470` | `100%` | `0%` | `예약 생성=100`, `READY=50`, `PICKED_UP=50`, `NO_SHOW=50` | `9.02ms` | `16.92ms` | `105.28ms` | 안정적 |
| 취소 후 재예약 | `1020` | `100%` | `0%` | `생성=100`, `취소=200`, `재예약=100`, `409=0` | `8.84ms` | `30.28ms` | `74.86ms` | 복구 정상 |

## 4. 시나리오별 해석

- 상품 목록 조회는 `2250`건 동안 `200` 응답을 유지했고 `p95 5.9ms`로 매우 안정적이었다. 조회 baseline 성능은 현재 로컬 constrained stack 기준에서 충분히 여유가 있다.
- 상품 등록 burst는 `201=140`, `409=680`, `5xx=0`이었다. 중복 SKU를 의도적으로 많이 만들었기 때문에 `409` 비중이 높은 것은 설계된 결과이며, 서버 오류 없이 충돌을 빠르게 거절했다는 점이 핵심이다.
- 핫 슬롯 예약 경쟁은 `201=6`, `409=445`, `5xx=0`이었다. 성공 수가 낮은 것은 실제 슬롯 잔여 정원이 매우 제한된 상태에서 경쟁이 발생했기 때문이며, teardown 검증까지 포함해 과예약과 음수 재고는 발생하지 않았다.
- 판매자 예약 운영 상태 전이는 `예약 생성=100`, `READY=50`, `PICKED_UP=50`, `NO_SHOW=50`으로 모든 분기가 정상 수행됐다. 목록 조회와 상태 변경이 반복돼도 `5xx` 없이 안정적으로 처리됐다.
- 취소 후 재예약은 `생성=100`, `취소=200`, `재예약=100`, `409=0`, `5xx=0`이었다. 재고와 슬롯 잔여 수량 복구가 정상 동작했고, 복구 직후 후속 재예약까지 문제없이 이어졌다.

## 5. Capacity 보완 결과

`상품 목록 조회 capacity`는 별도 보완 실행으로 수행했다.

| 항목 | 값 |
| --- | --- |
| 총 HTTP 요청 | `85120` |
| Check Pass Rate | `100%` |
| `2xx` 응답 수 | `85120` |
| `5xx` 응답 수 | `0` |
| 평균 응답시간 | `2.5ms` |
| p95 응답시간 | `4.82ms` |
| 최대 응답시간 | `715.43ms` |
| 처리량 | `159.33 req/s` |

해석:

- 테스트 범위 `10 -> 25 -> 50 -> 100 -> 150 -> 200 VUs` 내에서 `200` 응답만 관찰됐고 `5xx` 및 check 실패는 발생하지 않았다.
- 집계 기준 `p95 4.82ms`로 tail latency도 매우 낮게 유지됐다.
- `max 715.43ms` 스파이크는 있었지만 `p95`가 낮고 실패가 없어, 지속적인 성능 저하 구간으로 보기는 어렵다.
- 따라서 이번 실행 범위 안에서는 `안정 운영 가능 구간 = 10~200 VUs`, `성능 저하 시작 구간 = 관찰되지 않음`, `명확한 한계 구간 = 관찰되지 않음`으로 판단했다.
- 현재 constrained stack 기준으로는 `상품 목록 조회 API capacity가 최소 200 VUs 이상`임을 확인했고, 실제 한계를 찾으려면 `250/300+ VU` 단계 확장이 필요하다.

상세 내용은 `capacity-report.md`를 참고한다.

## 6. 종합 결론

이번 본실행에서 핵심 시나리오 5개는 모두 threshold를 통과했고, `5xx` 장애는 한 번도 발생하지 않았다. 조회 시나리오는 매우 안정적이었고, 쓰기 burst와 예약 경쟁 시나리오에서는 `409`를 통해 비즈니스 충돌을 정상 제어했다. 판매자 운영 상태 전이와 취소 후 재예약도 정합성을 유지한 채 정상 수행됐다.

추가로 capacity 보완 실행에서도 `상품 목록 조회 API`는 자원 제한 스택 기준 `200 VUs`까지 실패 없이 버텼다. 따라서 현재 데모앱은 조회, 쓰기 burst, 예약 경쟁, 상태 전이, 자원 복구 관점에서 기본적인 안정성을 확보한 상태로 판단할 수 있다. 다만 조회 API 외의 쓰기/경합 API capacity와 장시간 soak/stress는 아직 별도 검증이 필요하다.

## 7. 참고 로그

- `product-list-read.log`: 조회 baseline
- `product-registration-burst.log`: SKU 충돌 burst
- `hot-slot-race.log`: 경합 및 정합성 검증
- `reservation-status-flow.log`: 판매자 운영 상태 전이
- `cancel-and-rereserve.log`: 취소 후 자원 복구 및 재예약
- `product-list-capacity.log`: step-load capacity
