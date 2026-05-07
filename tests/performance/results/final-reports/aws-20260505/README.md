# Sallijang 1차 AWS 테스트 최종 보고서 패키지

작성일: 2026-05-05 KST

## 제출 순서

1. `00-final-one-page-report.md`: 최종 1장 보고서
2. `20260505-role-based-load-test-report.md`: 1차 AWS 테스트 소비자/판매자 관점 상세 보고서
3. `01-overview.png`: 전체 요약
4. `02-workflow.png`: 작업 진행 순서
5. `03-consumer-scenario.png`: 소비자 흐름과 한계
6. `04-seller-stock-scenario.png`: 판매자/재고 흐름과 한계
7. `05-infra-actions.png`: 인프라 한계와 후속 요청
8. `06-terms-glossary.png`: 부하 테스트 용어 설명
9. `07-local-vs-aws.png`: 지난 로컬 테스트와 1차 AWS/public API 테스트 차이
10. `evidence/`: 최종 수치 검증용 상세 요약 보고서

## 작업 진행 순서

1. AWS/환경 확인
2. API 라우팅/스모크 확인
3. 테스트 계정/데이터 준비
4. 상품 조회 한계 테스트
5. 상품 생성/삭제 테스트
6. 주문 생성 1차 테스트
7. 재고 차감 직접 테스트
8. 주문 생성 재검증
9. 주문 10 RPS + 내부 product-service probe
10. 주문 20 RPS 한계 테스트
11. HPA/GitOps 관찰
12. 추가 한계 테스트 후 진입점 상태 확인
13. VU 사용 방식과 결과 해석 정리
14. 최종 보고서/이미지/evidence 패키징

자세한 순차 기록은 `20260505-role-based-load-test-report.md`의 `2.1 작업 진행 순서`와 `evidence/20260505-sequential-test-report.md`를 확인한다.

## 핵심 결론

1차 AWS 테스트에서 소비자 관점은 상품 조회 `150 RPS`까지 안정, 주문 생성 `20 RPS`에서 지연 한계를 확인했다. 판매자 관점에서는 상품 생성/삭제 `40 RPS`까지 안정, `80 RPS`에서 실패 신호를 확인했다. 재고 차감 직접 호출은 주문 API를 거치지 않고 product-service remaining API만 때려본 원인 분리 테스트이며 `160 RPS`까지 안정, `240 RPS`에서 실패했다. 실제 주문에서는 소비자가 직접 호출하지 않고 `order-service`가 내부 호출한다.

스크립트는 k6 `constant-arrival-rate`로 target iteration/s를 고정하고 RPS별 1분씩 실행했다. 상품 생성/삭제는 한 iteration에서 create와 delete를 모두 호출하므로 실제 HTTP request/s는 target RPS의 약 2배다. 주문은 setup에서 상품 pool을 만든 뒤 buyer token으로 `POST /orders`를 호출했고, 재고차감 직접 검증은 별도 상품 pool에 `PATCH /remaining?delta=-1`만 호출했다.

p95 기준은 상품 조회 `800ms`, 주문 생성 `1500ms`, 상품 생성/삭제 `2000ms`, 재고 차감 직접 검증 `1000ms`다.

현재 추가 public API 테스트 전에는 Route53 alias 대상 ALB와 `ingress-nginx` controller 복구 확인이 필요하다.

DB/RDS/connection pool은 확인 대상이지만 현재 증거만으로 DB 문제를 단독 원인으로 확정하지 않는다.
