# Sallijang 2차 AWS 테스트 결과 보고서

작성일: 2026-05-07 KST
대상: `https://api.sallijang.shop`
기준 문서: `tests/performance/results/final-reports/aws-20260505/`
실행 메모: `tests/performance/results/aws-2nd-20260507/README.md`

## 1. 요약

2차 AWS 테스트는 1차 AWS 테스트에서 확인된 한계 구간을 재검증하는 방식으로 진행했다.

결론:

- 상품 조회는 `150 RPS`까지 통과했지만 p95가 `781.84ms`로 기준 `800ms`에 근접했다.
- 상품 조회 `160 RPS`는 5xx 없이 모두 응답했지만 p95가 `1.06s`로 상승해 실패 신호가 재현됐다.
- 주문 생성은 `10 RPS`까지 기능 실패 없이 통과했지만 반복 실행에서 endpoint p95가 `907.66ms`까지 상승했다.
- 주문 생성 `20 RPS`는 `6,000`건 중 `5,999`건이 성공했으나 `5xx` 1건과 endpoint p95 `8.22s`가 발생해 실패했다.
- HPA/GitOps 충돌 임시 조치 후 `20 RPS` 재실행에서는 `6,001`건이 모두 `201`로 성공해 5xx는 제거됐지만 endpoint p95 `7.85s`로 여전히 실패했다.
- 1차 AWS 테스트의 주문 생성 tail latency 병목은 2차에서도 재현됐고, replica 충돌 외에 order-service/DB/product-service 호출 경로의 추가 병목 확인이 필요하다.

## 2. 사전 확인

| 항목 | 결과 |
|---|---|
| k6 | `k6 v1.7.1` |
| `/health` | `200`, 약 `87ms` |
| `GET /api/v1/products/` | `200`, 약 `148ms` |
| 읽기 smoke | 통과, p95 `71.36ms`, 실패율 `0%` |
| 쓰기+주문 smoke | 통과, 상품 생성 성공, 주문 `201`, p95 `137.46ms`, 실패율 `0%` |

## 3. 상품 조회 결과

| Target RPS | Duration | HTTP 요청 | 실패율 | Check | p90 | p95 | max | VU max | Dropped | 판단 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 120 | 3m | 21,601 | 0% | 100% | 83.77ms | 281.37ms | 3.56s | 49 | 0 | 통과 |
| 150 | 5m | 45,001 | 0% | 100% | 598.63ms | 781.84ms | 3.34s | 131 | 0 | 통과, 기준 근접 |
| 160 | 3m | 28,801 | 0% | 100% | 868.59ms | 1.06s | 5.55s | 151 | 0 | 실패, p95 기준 초과 |

판단:

- `150 RPS`는 1차 AWS 테스트의 안정 구간을 재현했다.
- `160 RPS`는 5xx가 없어 장애성 실패는 아니지만, p95 기준을 넘으면서 조회 한계 시작 지점이 재현됐다.
- 조회 `180/200 RPS` 확장은 생략하고 주문 생성 한계 재현으로 전환했다.

## 4. 주문 생성 결과

상품 pool은 각 실행의 setup에서 생성하고 teardown에서 삭제했다.

| Target RPS | Duration | 상품 pool | 주문 시도 | 201 | 409 | 5xx | endpoint p95 | max | Dropped | 판단 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 5 | 3m | 200 | 901 | 901 | 0 | 0 | 96.16ms | 2.72s | 0 | 통과 |
| 10 1회차 | 5m | 200 | 3,000 | 3,000 | 0 | 0 | 132.31ms | 3.56s | 0 | 통과 |
| 10 2회차(refresh) | 5m | 200 | 3,001 | 3,001 | 0 | 0 | 907.66ms | 6.09s | 0 | 통과, tail latency 증가 |
| 20 | 5m | 500 | 6,000 | 5,999 | 0 | 1 | 8.22s | 13.74s | 0 | 실패, p95/5xx 기준 초과 |
| 20 HPA 조치 후 | 5m | 500 | 6,001 | 6,001 | 0 | 0 | 7.85s | 17.05s | 0 | 실패, 5xx 제거됐지만 p95 기준 초과 |

판단:

- `5 RPS`와 `10 RPS`는 주문 생성 자체는 안정적으로 처리됐다.
- `10 RPS` 반복 실행에서 409/5xx는 없었지만 p95가 `907.66ms`까지 상승해 지연 흔들림이 시작됐다.
- `20 RPS`는 dropped iteration 없이 목표 iteration을 모두 수행했으나, endpoint p95 `8.22s`와 max `13.74s`로 성능 기준을 크게 초과했다.
- `20 RPS` 중 VU가 최대 `201`까지 상승해 순간 처리 지연이 누적되는 패턴이 관찰됐다.

## 5. 실행 중 이슈

### HPA/GitOps 충돌

`20 RPS` 실패 후 클러스터 상태를 확인한 결과, 주문 생성 tail latency를 악화시킨 우선 운영 이슈는 `order-hpa`와 ArgoCD self-heal 충돌로 판단한다.

관찰 증거:

- `order-hpa`는 CPU 기준 `70%`를 목표로 `order-deploy`를 `4` replicas까지 올리려 했다.
- 동시에 `order-deploy` live spec과 ArgoCD desired manifest에는 `spec.replicas: 2`가 명시되어 있었다.
- ArgoCD application `sallijang-order`는 `selfHeal: true`이고 source는 `https://github.com/Salijang/sallijang-manifest.git`, path는 `base/order`다.
- 최근 20분 동안 ArgoCD 로그에서 `sallijang-order` automated sync가 `62`회 시작됐고, `order-deploy configured`가 `32`회 발생했다.
- 같은 시간대 pod 이벤트에서는 HPA로 생성된 order pod가 바로 `Killing/Terminating`되는 패턴이 반복됐다.

ingress 기준 주문 API 집계:

| 항목 | 값 |
|---|---:|
| 주문 요청 | 6,000 |
| 201 | 5,999 |
| 502 | 1 |
| 1초 초과 | 1,232 |
| 5초 초과 | 628 |
| max response time | 14.934s |

해석:

- order-service 자체가 완전히 죽은 상태는 아니다. 대부분의 요청은 `201`로 끝났다.
- 다만 부하 중 HPA가 scale-out을 시도하는 동안 ArgoCD가 `replicas: 2`를 반복 적용해 신규 pod가 안정적으로 유지되지 못했다.
- 그 결과 실제 처리 capacity가 2 replicas 근처에 묶이고, 요청 큐잉/대기 시간이 커지며 p95 `8.22s`와 502 1건으로 나타난 것으로 본다.

임시 조치:

- ArgoCD application `sallijang-order`, `sallijang-product`에 `/spec/replicas` ignore rule과 `RespectIgnoreDifferences=true`를 적용했다.
- 조치 후 `order-hpa`와 `product-hpa`는 각각 `5` replicas를 유지했고, order pod 5개가 모두 `Running` 상태로 남았다.
- `sallijang-manifest`에는 `base/order/deployment.yaml`, `base/product/deployment.yaml`의 `replicas` 제거 커밋을 로컬로 만들었지만, GitHub push는 권한 문제로 실패했다.

조치 후 `20 RPS / 5m` 재실행 결과:

| 항목 | 값 |
|---|---:|
| 주문 시도 | 6,001 |
| 201 | 6,001 |
| 5xx | 0 |
| endpoint p90 | 4.62s |
| endpoint p95 | 7.85s |
| endpoint max | 17.05s |
| ingress p95 | 7.809s |
| ingress max | 15.632s |

조치 후 5xx는 제거됐지만 p95는 기준 `1.5s`를 계속 초과했다. 따라서 HPA/GitOps 충돌은 scale-out 불안정과 502의 원인이었으나, 주문 생성 tail latency의 유일 원인은 아니다.

### 인증 만료

`10 RPS` 반복 실행 중 기존 seller/buyer 토큰이 만료되어 `auth/me`가 모두 `401`을 반환했다. 해당 실행은 주문 병목 판단에서 제외했고, setup 상품 `404..603`은 재로그인 후 `200/200`개 cleanup 완료했다.

이후 `10 RPS` 반복과 `20 RPS`는 새 테스트 계정/store로 진행했다.

### k6 URL cardinality

상품 조회 테스트에서 랜덤 query string 조합이 URL별 고유 시계열로 잡혀 high-cardinality 경고가 발생했다. 이후 `requestOptions()`에 `name` tag를 추가해 endpoint 단위 grouping을 보정했다.

## 6. 1차 대비 결론

| 영역 | 1차 AWS 결과 | 2차 AWS 결과 | 판단 |
|---|---|---|---|
| 상품 조회 | `150 RPS` 안정, `160 RPS`부터 실패 신호 | `150 RPS` 통과, `160 RPS` p95 `1.06s` | 한계 구간 재현 |
| 주문 생성 | `10 RPS` 재현성 불안정, `20 RPS` p95 `29.55s` | `10 RPS` 통과, `20 RPS` p95 `8.22s`, HPA 조치 후 p95 `7.85s` | 병목 재현, replica 충돌 외 추가 병목 필요 |

2차 결과는 1차 결론을 구체화한다. 주문 생성 `20 RPS`에서 HPA scale-out과 ArgoCD self-heal의 충돌은 명확히 확인됐고, 이 충돌은 502와 scale-out 불안정을 만든다. 다만 임시 조치 후에도 p95가 `7.85s`로 남아 있어, 주문 생성 tail latency는 order-service 내부 처리, DB connection pool/lock, product-service 재고 차감 호출 지연까지 추가로 확인해야 한다.

## 7. 다음 액션

우선순위:

1. `sallijang-manifest`의 `base/order`, `base/product` deployment에서 `spec.replicas` 제거를 원격 repo에 반영한다.
2. 현재 임시 ArgoCD `ignoreDifferences` 조치를 manifest로 영구화할지, HPA 대상 deployment에서 `replicas`를 제거하는 방식으로 정리할지 결정한다.
3. order-service 로그에서 `POST /api/v1/orders` 처리 시간을 단계별로 분해한다.
4. DB connection pool, lock wait, slow query, transaction duration을 주문 생성 시간대와 대조한다.
5. product-service 재고 차감/상품 조회 호출 지연과 timeout 설정을 확인한다.
6. 병목 조치 후 `20 RPS / 5m`를 같은 조건으로 재실행한다.

추가 RPS 탐색은 `20 RPS` p95가 `1.5s` 아래로 내려간 뒤 진행하는 것이 맞다.
