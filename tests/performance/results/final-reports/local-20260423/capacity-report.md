# 상품 목록 조회 Capacity 보완 보고서

- 작성일: `2026-04-23`
- Run ID: `20260423-final-report`
- Test ID: `20260423-final-report-product-list-capacity`
- 대상 스크립트: `tests/performance/k6/product-list-capacity.js`
- Base URL: `http://localhost:14000`

## 1. 목적

1차 성능 테스트는 핵심 기능 시나리오의 안정성을 확인하는 데 초점이 있었고, 단계별 동접 증가에 따른 최대 수용 구간은 별도로 측정하지 못했다. 이번 보완 실행은 자원 제한 Docker Compose 스택을 기준으로 `상품 목록 조회 API`의 step-load baseline을 확인하기 위해 수행했다.

## 2. 실행 조건

- 단계: `10, 25, 50, 100, 150, 200 VUs`
- 램프업: 각 단계 `20s`
- 유지: 각 단계 `1m`
- 쿨다운: `20s`
- 앱/DB/모니터링은 constrained stack으로 실행
- k6는 호스트에서 실행

실행 메모:

- 스택 재기동 직후 최초 preflight에서 API warm-up 중 연결 재설정이 한 번 발생했다.
- 실제 측정값은 API health 확인 후 같은 clean stack에서 다시 수행한 본실행 기준이다.

## 3. 결과 요약

| 항목 | 값 |
| --- | --- |
| 총 HTTP 요청 | `85120` |
| Check Pass Rate | `100%` |
| `2xx` 응답 수 | `85120` |
| `5xx` 응답 수 | `0` |
| 평균 응답시간 | `2.5ms` |
| p90 응답시간 | `3.9ms` |
| p95 응답시간 | `4.82ms` |
| 최대 응답시간 | `715.43ms` |
| 처리량 | `159.33 req/s` |
| 최대 관찰 동접 | `200 VUs` |

## 4. 해석

- `10~200 VUs` 전 구간에서 `200 OK`만 관찰됐고, check 실패와 `5xx`는 없었다.
- 집계 결과 기준 `p95 4.82ms`로 tail latency가 낮게 유지됐으므로, 본 테스트 범위에서는 의미 있는 성능 저하 시작 지점을 찾지 못했다.
- `max 715.43ms`는 존재하지만, 평균과 `p95`가 모두 낮고 실패가 없어 일시적 스파이크로 보는 것이 타당하다.
- 이번 보완 실행만 기준으로 하면 `안정 운영 가능 구간 = 10~200 VUs`, `성능 저하 시작 구간 = 미관찰`, `명확한 한계 구간 = 미관찰`이다.
- 따라서 현재 constrained baseline에서 `상품 목록 조회 API`의 수용 한계는 `200 VUs 이상`으로 판단한다.

## 5. 결론과 후속 과제

이번 capacity 보완 실행에서는 목표 범위 안에서 병목이나 한계 구간이 드러나지 않았다. 따라서 다음 단계는 조회 API보다 더 공격적인 범위인 `250/300+ VU` 확장, 혹은 쓰기 API와 예약 경합 API에 대한 별도 capacity 시나리오 추가가 적절하다.

권장 후속 작업:

1. `250/300/400 VUs` 단계 추가로 실제 한계 구간을 탐색한다.
2. `POST /stores/:storeId/products`와 `POST /pickup-reservations`에 대해서도 step-load capacity를 별도로 수행한다.
3. 장시간 soak 테스트를 추가해 짧은 burst로는 드러나지 않는 누적 지연이나 자원 누수를 확인한다.
