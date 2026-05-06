# Sallijang 역할별 부하 테스트 최종 1장 보고서

작성일: 2026-05-05 KST
대상: `https://api.sallijang.shop`
환경: public API 도메인이지만 AWS 리소스명/태그는 `dev` 계열로 확인됨
범위: 소비자/판매자 핵심 API 부하 검증, 인프라/앱 설정 변경 없음

## 1. 목적

Sallijang 앱은 소비자와 판매자 사용자가 나뉜다. 그래서 API 단건이 아니라 실제 역할별 흐름 기준으로 시나리오를 잡았다. 소비자는 `상품 조회 -> 주문 생성`, 판매자는 `상품 생성/삭제 -> 재고 관련 처리`를 중심으로 확인했다.

공통 방식은 k6 `constant-arrival-rate`다. VU를 고정한 테스트가 아니라 목표 RPS를 정하고, 응답이 느려질수록 k6가 필요한 VU를 자동 투입하게 했다. 각 RPS는 1분씩 실행했고 `status code`, p95, dropped iteration, 실제 최대 VU를 같이 기록했다.

여기서 RPS는 k6 target iteration/s 기준이다. 상품 생성/삭제는 한 iteration에서 create와 delete를 모두 호출하므로 실제 HTTP request/s는 target RPS의 약 2배다. p95 기준은 조회 `800ms`, 주문 `1500ms`, 상품 생성/삭제 `2000ms`, 재고 차감 `1000ms`로 잡았다.

스크립트 구성은 `setup -> default function -> teardown` 구조다. 주문은 setup에서 seller token으로 상품 pool을 만든 뒤 default function에서 buyer token으로 `POST /orders`를 호출했고, 재고차감 직접 검증은 setup 상품 pool을 대상으로 `PATCH /remaining?delta=-1`만 단독 호출했다.

작업 순서는 `환경 확인 -> 라우팅/스모크 -> 테스트 계정/데이터 준비 -> 상품 조회 -> 상품 생성/삭제 -> 주문 1차 -> 재고차감 직접 검증 -> 주문 재검증 -> 내부 product-service probe -> 주문 20 RPS 한계 -> HPA/GitOps 관찰 -> 진입점 상태 확인 -> VU/결과 해석 -> 보고서 패키징` 순서로 진행했다.

## 2. 소비자 관점

| 시나리오 | 확인 API | 검증 방식 | 확인된 한계 |
|---|---|---|---|
| 상품 탐색 | `GET /api/v1/products/` | 20~200 RPS 단계 상향, p95/502/dropped 확인 | `150 RPS` 안정, `160 RPS` 첫 502, `200 RPS` p95 약 12s |
| 주문 생성 | `POST /api/v1/orders/` | 상품 pool 20/100/200개, buyer token 주문 생성, 내부 product-service probe 병행 | `10 RPS` 재현성 불안정, `20 RPS` p95 29.55s로 지연 한계 |

주문 생성에서 소비자 앱은 재고차감 API를 직접 호출하지 않는다. `POST /orders` 처리 중 `order-service`가 `product-service`의 `PATCH /products/{id}/remaining`을 내부 호출한다.

## 3. 판매자 관점

| 시나리오 | 확인 API | 검증 방식 | 확인된 한계 |
|---|---|---|---|
| 상품 생성/삭제 | `POST /api/v1/products/?store_id=...` + `DELETE /api/v1/products/{id}` | 같은 iteration에서 생성 후 삭제, 2~80 RPS 단계 상향 | `40 RPS` 안정, `80 RPS` create 502 6건 |
| 재고 차감 직접 검증 | `PATCH /api/v1/products/{id}/remaining?delta=-1` | 상품 pool 100/300개, `delta=-1`, product remaining만 단독 호출 | `160 RPS` 안정, `240 RPS` 5xx 860건/dropped 5,790 |

재고 차감 직접 검증은 주문 API를 거치지 않고 product-service의 remaining API만 직접 호출한 원인 분리 테스트다. 실제 주문에서는 소비자가 직접 호출하지 않고 `order-service`가 내부 호출한다.

## 4. 현재 인프라 한계

- 주문 20 RPS 직후 order HPA는 `2 current / 4 desired`, CPU `380%/70%`까지 상승했다.
- ArgoCD self-heal이 replicas를 다시 2로 되돌리는 패턴이 의심된다.
- 주문 409는 product-service 상시 장애가 아니라 `order -> product` 내부 호출의 간헐 실패 패턴으로 보인다.
- 추가 한계 테스트 후 `api.sallijang.shop` alias ALB DNS 해석 실패와 `ingress-nginx` controller resource 미확인이 발생했다.

## 5. 결론과 요청사항

현재 보수적 기준은 상품 조회 `150 RPS`, 상품 생성/삭제 `40 RPS`, 재고 차감 직접 호출 `160 RPS`다. 주문 생성은 `10 RPS`에서도 간헐 409가 있어 내부 호출 안정화가 먼저 필요하고, `20 RPS`는 지연 한계로 본다.

DB/RDS/connection pool은 확인 대상이지만 현재 증거만으로 DB 문제를 단독 원인으로 확정하지 않는다. 요청사항은 Route53 alias ALB와 ingress-nginx 복구, HPA/GitOps replicas 정책 조정, `order -> product` timeout/retry/connection pool/keep-alive 확인, 내부 호출 실패의 409 반환 정책 재검토, 재고 차감 240 RPS 테스트 상품 cleanup 재시도다.

상세 보고서: `20260505-role-based-load-test-report.md`
순차 상세 기록: `evidence/20260505-sequential-test-report.md`
