# Sallijang Public API 부하 테스트 순차 보고서 - 2026-05-05

대상: `https://api.sallijang.shop`
주의: public API 도메인이지만 AWS 리소스명/태그는 `dev` 계열로 확인됨. 테스트팀은 인프라/앱 설정을 변경하지 않고 k6 테스트와 읽기 전용 확인만 수행했다.

## 1. 환경 확인

목적: 현재 테스트 대상이 실제로 접근 가능한지, AWS/EKS 리소스가 어떤 환경인지 확인.

결과:

- AWS 계정: `sesac_team_3`, account id `594486941613`
- public API: `https://api.sallijang.shop`
- 확인된 주요 리소스명: `pickup-dev-eks-cluster`, `pickup-dev-alb`, `pickup-dev-rds`, `pickup-dev-redis`
- `prod` 명칭의 실제 AWS 리소스는 확인되지 않음
- `api.sallijang.shop`은 dev 계열 ALB로 연결됨

판단: 테스트 대상은 팀이 말한 public API이나, AWS 기준으로는 dev 계열 환경으로 기록한다.

## 2. API 라우팅/스모크 확인

목적: ALB -> nginx ingress -> service/pod 라우팅이 살아 있는지 확인.

결과:

- `/api/v1/products/` 조회 가능
- `/api/v1/auth/me` 인증 필요 응답 확인
- user/product/order 라우팅은 동작
- 초기에 API 장애가 있었으나 CD 쪽 문제 수정 후 dev/public API 테스트 가능 상태가 됨

판단: k6 부하 테스트 진행 가능.

## 3. 상품 조회 한계치 테스트

목적: 읽기 API의 처리량과 실패 구간 확인.

결과:

| Target RPS | 결과 |
|---:|---|
| 20 | 통과, p95 `31.36ms` |
| 40 | 통과, p95 `34.03ms` |
| 80 | 통과, p95 `39.16ms` |
| 120 | 통과, p95 `277.58ms` |
| 150 | 통과, p95 `616.31ms` |
| 155 | 통과, p95 `677ms` |
| 160 | 첫 502 1건 발생, p95 `790.4ms` |
| 180 | 502 2건, p95 `1.66s` |
| 200 | 5xx는 없었지만 p95 약 `12s`, dropped 413 |

판단:

- 조회 API는 150 RPS 부근까지 안정적
- 160 RPS부터 실패 신호 발생
- 200 RPS에서는 오류보다 지연/처리량 한계가 더 큼

## 4. 상품 생성/삭제 테스트

목적: 쓰기 API 중 상품 등록/삭제 처리량 확인.

시나리오: `POST /api/v1/products/?store_id=<id>` 후 같은 iteration에서 `DELETE /api/v1/products/{id}`.

결과:

| Target RPS | 결과 |
|---:|---|
| 2 | 통과, 실패 0% |
| 5 | 통과, 실패 0% |
| 10 | 통과, 실패 0% |
| 20 | 통과, 실패 0% |
| 40 | 통과, 실패 0%, p95 `93.76ms` |
| 80 | 실패 신호, create 5xx `6건`, create p95 `676.94ms`, delete 204 `4,795건` |

판단: 상품 생성/삭제는 `40 RPS`까지 안정적이고, `80 RPS`에서 첫 실패 신호가 확인됐다. 실패는 생성 요청의 `502` 6건이며, 생성에 성공한 상품 삭제는 모두 `204`로 처리됐다.

## 5. 주문 생성 1차 테스트

목적: 주문 생성 API의 낮은 RPS 구간 안정성 확인.

시나리오: setup에서 상품 pool 생성 후 `POST /api/v1/orders/`.

결과:

| Target RPS | 201 | 409 | 5xx | 판단 |
|---:|---:|---:|---:|---|
| 2 | 121 | 0 | 0 | 통과 |
| 5 | 288 | 13 | 0 | 실패 |

로그:

```text
[WARNING] 재고 수량 조정 실패 (...): All connection attempts failed
POST /api/v1/orders/ HTTP/1.1" 409 Conflict
```

판단:

- 5xx나 DB timeout은 확인되지 않음
- order service가 product service 재고 차감 내부 호출에 실패하며 409를 반환하는 패턴 확인

## 6. 상품 재고 차감 직접 테스트

목적: 주문 실패 원인이 product remaining API 자체 한계인지 분리.

시나리오: `PATCH /api/v1/products/{id}/remaining?delta=-1` 직접 호출.

결과:

| Target RPS | 200 | 409 | 5xx | p95 |
|---:|---:|---:|---:|---:|
| 40 | 2,400 | 0 | 0 | `36.07ms` |
| 80 | 4,801 | 0 | 0 | `36.58ms` |
| 120 | 7,201 | 0 | 0 | `40.46ms` |
| 160 | 9,601 | 0 | 0 | `81.45ms` |
| 240 | 553 | 0 | 860 | `9.21s` |

판단:

- product remaining API 자체는 160 RPS까지 안정적
- 240 RPS에서는 200 응답이 553건에 그치고 timeout/status 0 계열이 7,198건, 5xx가 860건 발생
- 240 RPS에서 VU max `3000`, dropped `5790`까지 증가했으므로 k6 VU 부족이 아니라 응답 지연/진입점/서버 처리 한계로 기록
- 주문 409를 product API 160 RPS 이하 처리 한계로 보기는 어렵지만, product remaining 자체도 240 RPS에서는 명확한 실패 구간이다.

## 7. 주문 생성 재검증

목적: 상품 pool을 키워 주문 실패가 단일 상품 충돌인지 확인.

시나리오: 상품 pool 100개로 `POST /api/v1/orders/`.

결과:

| Target RPS | 201 | 409 | 5xx | p95 | 판단 |
|---:|---:|---:|---:|---:|---|
| 5 | 300 | 1 | 0 | `206.29ms` | 거의 통과 |
| 10 | 578 | 22 | 0 | `273.97ms` | 409로 실패 |

판단:

- pool을 키워도 409가 간헐 발생
- order -> product 내부 호출 경로, timeout, connection 설정 문제 가능성이 더 큼

## 8. 주문 10 RPS + 내부 product-service probe

목적: product-service DNS/Service가 상시 장애인지 확인.

시나리오: 주문 10 RPS 실행 중 order pod 내부에서 `http://product-service/api/v1/products/...`를 0.1초 간격으로 조회.

결과:

| 항목 | 결과 |
|---|---:|
| 주문 생성 | 601건 |
| 주문 201 | 601건 |
| 주문 409/5xx | 0건 |
| 내부 product-service probe | 900건 |
| probe 200 | 900건 |
| probe error | 0건 |

판단:

- product-service DNS/Service가 상시 죽은 상태는 아님
- 10 RPS 409는 재현성이 있는 간헐 장애로 기록

## 9. 주문 20 RPS 한계 테스트

목적: 주문 생성의 다음 한계 구간 확인.

시나리오: 상품 pool 200개로 `POST /api/v1/orders/` 20 RPS 실행.

결과:

| Target RPS | 201 | 409 | 5xx | p95 | Max | Dropped |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 1,103 | 0 | 0 | `29.55s` | `43.19s` | 98 |

판단:

- 20 RPS에서는 오류가 아니라 응답 지연으로 실패
- 주문은 모두 201이지만 p95가 약 30초로 운영 기준상 한계 구간

## 10. HPA/GitOps 관찰

목적: 주문 20 RPS 지연 원인 중 인프라 스케일링 문제 확인.

결과:

- 20 RPS 직후 order HPA CPU: `380%/70%`
- HPA 상태: `2 current / 4 desired`
- deployment event: `Scaled up ... to 4 from 2`, `Scaled down ... to 2 from 4` 반복
- ArgoCD `sallijang-order`: `automated.selfHeal=true`, `prune=true`, `Synced/Healthy`

판단:

- HPA는 scale-out을 시도하지만 ArgoCD desired replicas `2`로 되돌아가는 패턴이 강하게 의심됨
- 이 상태에서는 부하 중 order pod scale-out이 유지되지 않아 지연이 커질 수 있음

## 11. 추가 한계 테스트 후 진입점 상태

상품 생성/삭제 80 RPS와 재고 차감 240 RPS 한계 테스트 후, 외부 진입점 상태를 재확인했다.

- Route53 `api.sallijang.shop` A alias: `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com`
- 현재 로컬 DNS에서 `api.sallijang.shop` 및 alias ALB DNS 해석 실패
- `ingress-nginx` namespace에는 실행 중인 controller resource가 확인되지 않음
- product service cleanup을 위해 `kubectl port-forward`와 apiserver service proxy를 시도했으나 product endpoint까지 연결되지 않음
- 재고 차감 테스트 teardown은 timeout으로 종료되어 일부 테스트 상품 cleanup이 보류될 수 있음

판단: 이 시점 이후의 추가 public API 부하 테스트는 API 처리 한계가 아니라 DNS/LB/ingress 진입점 장애에 의해 왜곡될 수 있다. 진입점 복구 후 cleanup과 재테스트가 필요하다.

## 12. VU 사용 방식

이번 테스트는 VU를 고정해서 태우는 방식이 아니라, k6 `constant-arrival-rate` executor로 목표 RPS를 먼저 정하고 k6가 필요한 VU를 자동 투입하는 방식이다.

- `preAllocatedVUs`: 미리 확보해 둔 VU 용량
- `maxVUs`: 부족할 때 늘릴 수 있는 최대 VU 용량
- `vus.max`: 테스트 중 실제 동시에 사용된 최대 VU
- `vus_max`: k6가 확보한 VU 용량 지표

대표 결과:

| 테스트 | 설정 VU | 실제 최대 VU | Dropped | 해석 |
|---|---:|---:|---:|---|
| 재고 차감 160 RPS | pre `500`, max `2000` | `80` | 0 | 적은 실제 VU로 목표 처리 |
| 상품 생성/삭제 80 RPS | pre `300`, max `1500` | `77` | 0 | 클라이언트 병목 없이 create 502 발생 |
| 재고 차감 240 RPS | pre `800`, max `3000` | `3000` | 5,790 | VU 상한까지 소진, timeout/5xx 대량 발생 |
| 주문 10 RPS probe | pre `100`, max `1000` | `3` | 0 | 정상 구간 |
| 주문 20 RPS | pre `300`, max `1500` | `397` | 98 | 응답 지연으로 VU가 급증했지만 목표 RPS 유지 실패 |

판단: 주문 20 RPS와 재고 차감 240 RPS에서는 VU를 충분히 열어놨는데도 실제 VU가 크게 증가했고 dropped가 발생했다. 이는 k6 클라이언트 VU 부족이라기보다 서버 응답 지연 또는 진입점 처리 실패 누적으로 봐야 한다.

## 최종 결론

1. 상품 조회는 `160 RPS`부터 실패 신호, `200 RPS`에서 지연/처리량 한계가 명확하다.
2. 상품 생성/삭제는 `40 RPS`까지 안정적이고, `80 RPS`에서 create 502 6건으로 실패 신호가 발생했다.
3. 상품 재고 차감 직접 호출은 `160 RPS`까지 안정적이고, `240 RPS`에서 timeout/5xx/dropped가 대량 발생했다.
4. 주문 생성은 `10 RPS`에서 간헐 409가 발생하고, `20 RPS`에서는 p95 약 30초로 지연 한계가 발생한다.
5. DB 문제로 확정할 증거는 없다.
6. 현재 핵심 의심 지점은 `order -> product` 내부 호출 간헐 실패와 HPA/ArgoCD replicas 충돌이다.
7. 현재 public 진입점 DNS/LB/ingress 상태가 불안정해 추가 테스트 전 복구 확인이 필요하다.

## 후속 요청

- order -> product 내부 호출 timeout, retry, connection pool, keep-alive 설정 확인
- 내부 호출 실패를 409로 반환하는 정책이 맞는지 확인
- HPA 대상 deployment의 replicas를 ArgoCD가 되돌리지 않도록 정책 조정
- `api.sallijang.shop` TLS 인증서 SAN 확인
- `api.sallijang.shop` Route53 alias 대상 ALB와 ingress-nginx controller 복구 확인
- 재고 차감 240 RPS 테스트 상품 cleanup 재시도
- 조치 후 주문 `10/20/40 RPS` 재테스트

## 결과 경로

- 상세 쓰기 보고서: `tests/performance/results/20260505-public-api-write-scenarios-report.md`
- 한 장 요약: `tests/performance/results/20260505-order-product-internal-call-one-page.md`
- 조회 한계: `tests/performance/results/20260505-public-api-read-limit-130834`
- 조회 확장: `tests/performance/results/20260505-public-api-read-extended-132922`
- 상품 생성/삭제: `tests/performance/results/20260505-public-api-product-create-141646`
- 상품 생성/삭제 한계: `tests/performance/results/20260505-public-api-product-create-limit-221320`
- 상품 재고 차감: `tests/performance/results/20260505-public-api-product-remaining-extended-145106`
- 상품 재고 차감 한계: `tests/performance/results/20260505-public-api-product-remaining-limit-221534`
- 주문 재검증: `tests/performance/results/20260505-public-api-order-create-retest-145710`
- 주문 10 RPS probe: `tests/performance/results/20260505-order10-internal-product-probe-151632`
- 주문 20 RPS 한계: `tests/performance/results/20260505-public-api-order-create-limit-151905`
