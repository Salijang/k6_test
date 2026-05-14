# SQS 재고 차감 경로 경량 재검증

- 실행 일시: `2026-05-13 16:48 KST`
- 실행 위치: local k6 runner
- 대상: `https://api.sallijang.shop`
- Test ID: `20260513-sqs-retest-hot-order`
- Script: `tests/performance/k6/sallijang/order-hot-product-race.js`
- 목적: product-service SQS stock_deduct 컨슈머 batch 병렬 처리 반영 후, hot product 주문 경합에서 재고 정합성과 5xx 발생 여부 확인

## 실행 조건

| 항목 | 값 |
|---|---:|
| Rate | `2 iterations/s` |
| Duration | `30s` |
| Product pool | `1` |
| Initial stock | `20` |
| preAllocated VUs | `10` |
| max VUs | `30` |
| SAGA settle | `10s` |

## 결과

| 지표 | 값 |
|---|---:|
| iterations | `60` |
| checks | `183/183`, `100%` |
| 주문 201 | `20` |
| 주문 409 | `40` |
| 5xx | `0` |
| http_req_failed | `0%` |
| endpoint p95 | `342.23ms` |
| endpoint max | `3.12s` |
| created orders | `20` |
| final remaining | `0` |
| active hot product orders | `20` |
| VU max | `10` |

## 통과한 check

- `hot order never 5xx`
- `hot product remaining is never negative`
- `hot product remaining does not exceed initial stock`
- `active hot product orders do not exceed stock`

## 판단

재고 `20`인 단일 hot product에 주문 시도 `60`회를 넣었고, 정확히 `20`건만 생성됐다. 나머지 `40`건은 재고 소진에 따른 `409 Conflict`로 거절됐다. 최종 재고는 `0`, 활성 주문 수는 `20`으로 맞아 과주문과 음수 재고는 발생하지 않았다.

이 결과는 낮은 RPS의 경량 재검증이다. SQS queue age, visible message count, DLQ 유입량을 같이 수집하지 못했으므로 운영 용량 근거로 쓰려면 `5/10/20 RPS` 단계 재검증과 CloudWatch SQS 지표 수집이 필요하다.
