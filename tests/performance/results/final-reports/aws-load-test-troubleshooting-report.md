# Sallijang AWS 부하 테스트 트러블슈팅 보고서

작성일: 2026-05-11 KST  
대상: `https://api.sallijang.shop`  
범위: 2026-05-05 1차 AWS 부하 테스트, 2026-05-07 2차 AWS 재검증, 2026-05-11 주문 병목 재검증

## 1. 목적

본 문서는 Sallijang public API 부하 테스트 중 확인된 지연, 5xx, 내부 호출 실패, 스케일링 충돌 문제를 정리하고, 원인 분리 과정과 후속 조치 대상을 남기기 위한 트러블슈팅 보고서다.

테스트는 단순히 최대 RPS를 찾는 방식이 아니라, 실패 구간에서 다음 항목을 함께 대조했다.

- k6 응답시간, status code, dropped iteration, 실제 사용 VU
- order/product service 로그
- ingress 응답 코드와 response time
- HPA desired/current replicas
- ArgoCD self-heal 및 deployment event
- public DNS, ALB, ingress-nginx 진입점 상태

## 2. 핵심 결론

현재 상태는 "해결 완료"가 아니라 "주요 병목 1개를 제거했지만 운영 기준은 미달"이다. 2026-05-11 재검증에서 주문 `20 RPS / 5m`가 p95 `30.97s`, 5xx `17건`, dropped iteration `1,265`로 실패했고, 원인은 `order_number="TEMP"` unique index 대기로 인한 `order_flush` 병목으로 확인됐다. hotfix 배포 후 같은 조건 재검증에서는 p95가 `12.04s`, 5xx가 `1건`, dropped iteration이 `103`으로 개선됐지만, 기준 p95 `1.5s`와 5xx `0`은 아직 통과하지 못했다.

| 구분 | 확인된 현상 | 판단 |
|---|---|---|
| 주문 생성 내부 호출 | `10 RPS`에서 간헐 `409`, order 로그에 `All connection attempts failed` | `order-service -> product-service` 내부 호출 경로, timeout/connection 설정 확인 필요 |
| 주문 생성 `20 RPS` | 1차 p95 `29.55s`, 2차 p95 `8.22s`, HPA 조치 후에도 p95 `7.85s` | HPA/GitOps 충돌은 502와 scale-out 불안정 원인이나 tail latency의 유일 원인은 아님 |
| 2026-05-11 주문 재검증 | p95 `30.97s`, 5xx `17`, dropped `1,265`, 실제 처리량 `15.31 it/s` | 주문 `20 RPS` 병목 미해결 재확인 |
| 2026-05-11 Kubernetes 관찰 | order HPA `7 replicas`, 일부 order pod `Exit Code 139`, `[PERF] order_flush` 28~32s | 병목은 HPA 미동작만이 아니라 order-service/DB flush/프로세스 안정성까지 포함 |
| 2026-05-11 hotfix 후 재검증 | p95 `12.04s`, 5xx `1`, dropped `103`, 실제 처리량 `17.25 it/s`; 추가 확인에서 order pod `Exit Code 139` 재발 | 크게 개선됐지만 운영 기준은 아직 미달 |
| HPA/GitOps | HPA는 `4~5 replicas`를 원하지만 ArgoCD가 `replicas: 2`를 반복 적용 | HPA 대상 deployment에서 replicas 관리 정책 조정 필요 |
| 재고 차감 직접 호출 | `160 RPS` 안정, `240 RPS`에서 5xx `860`, dropped `5,790` | product-service/DB/ingress 처리 한계 구간 |
| 상품 생성/삭제 | `40 RPS` 안정, `80 RPS`에서 create 502 발생 | 짧은 burst 중 ingress/upstream, pod lifecycle, readiness 확인 필요 |
| public 진입점 | 한계 테스트 후 DNS/ALB/ingress-nginx 상태 불안정 관찰 | 추가 public API 테스트 전 진입점 복구 확인 필요 |

## 3. 테스트 진행 요약

1차 AWS 테스트는 아래 순서로 진행했다.

| 순서 | 작업 | 목적 |
|---:|---|---|
| 1 | AWS/환경 확인 | public API가 실제 어느 AWS 리소스에 연결되는지 확인 |
| 2 | API 라우팅/스모크 확인 | `/health`, 상품 조회, 인증 API 라우팅 확인 |
| 3 | 테스트 계정/데이터 준비 | seller/buyer/store/env 준비 |
| 4 | 상품 조회 한계 테스트 | read API 안정 구간 및 실패 신호 확인 |
| 5 | 상품 생성/삭제 테스트 | seller write API 한계 확인 |
| 6 | 주문 생성 1차 테스트 | consumer order API 낮은 RPS 구간 확인 |
| 7 | 재고 차감 직접 테스트 | 주문 실패가 product remaining 자체 한계인지 분리 |
| 8 | 주문 생성 재검증 | 상품 pool 확대로 단일 상품 충돌 가능성 제거 |
| 9 | 내부 product-service probe | product-service DNS/Service 상시 장애 여부 확인 |
| 10 | 주문 20 RPS 한계 테스트 | 주문 생성 tail latency 확인 |
| 11 | HPA/GitOps 관찰 | scale-out 유지 여부 확인 |
| 12 | 진입점 상태 확인 | DNS/LB/ingress 영향 분리 |

2차 AWS 테스트는 1차에서 확인된 한계 구간을 재검증했다.

- 상품 조회: `120/150/160 RPS`
- 주문 생성: `5 RPS`, `10 RPS`, `10 RPS 반복`, `20 RPS`, `20 RPS HPA 조치 후`
- HPA/GitOps 충돌 확인 및 임시 조치 후 재실행

2026-05-11에는 주문 `20 RPS / 5m`를 다시 실행했다.

- Run ID: `order20-troubleshoot-20260511-095748`
- Route53 기준 대상: `api.sallijang.shop -> pickup-prod-alb-1200962877.ap-northeast-2.elb.amazonaws.com`
- 결과: p95 `30.97s`, 5xx `17`, dropped iteration `1,265`
- 판단: 주문 `20 RPS` 미해결 재확인

같은 날 hotfix merge 후 재검증도 실행했다.

- Merge commit: `65da9519fc577cacaff7a9349688d14f96635dbe`
- 배포 이미지: `sallijang-backend-order:65da9519fc577cacaff7a9349688d14f96635dbe`
- Run ID: `order20-post-merge-20260511-110900`
- 결과: p95 `12.04s`, 5xx `1`, dropped iteration `103`
- 판단: `TEMP` unique placeholder 병목 제거 효과는 확인됐지만, 주문 `20 RPS` 기준은 아직 실패

## 4. 해결 상태

| 항목 | 상태 | 근거 | 남은 확인 |
|---|---|---|---|
| HPA/GitOps replicas 충돌 | 부분 조치됨 | ArgoCD ignoreDifferences 임시 적용 후 order/product pod가 `5 replicas` 유지 | manifest에 영구 반영됐는지 확인 필요 |
| 주문 `20 RPS` 5xx | 부분 개선 | hotfix 전 `17건`, hotfix 후 `1건` | 남은 1건의 실패 지점 추적 필요 |
| 주문 `20 RPS` p95 지연 | 미해결 | hotfix 후에도 p95 `12.04s`; 기존 `order_flush` 28~32s 대기는 사라졌지만 기준 `1.5s` 초과 | `stock_reserve`, `order_reload`, publish 단계 병목 분리 필요 |
| order-service segfault | 미해결 | hotfix 전 order pod `Exit Code 139` 확인, hotfix 이미지에서도 추가 확인 시 5/7 pod 재시작 | SQLAlchemy ORM loading, GC, asyncpg/greenlet native extension 원인 확인 필요 |
| `TEMP` unique placeholder 병목 | 조치됨 | hotfix 후 p95 `30.97s -> 12.04s`, dropped `1,265 -> 103`, 5xx `17 -> 1`; order pod restart `0` | 남은 p95/5xx 병목 추가 분리 필요 |
| 주문 `10 RPS` 간헐 409 | 미해결/재현성 불안정 | 1차에서 409 발생, probe 실행에서는 통과 | 내부 호출 실패 원인과 에러 매핑 정책 확인 필요 |
| product remaining `240 RPS` 실패 | 미해결 | 5xx `860`, dropped `5,790` | product/DB/ingress 한계 분리 필요 |
| public 진입점 불안정 | 확인 필요 | DNS/ALB/ingress-nginx 불안정 기록 | 추가 테스트 전 smoke 및 인프라 상태 확인 필요 |

정리하면, 현재 해결됐다고 말할 수 있는 것은 "`TEMP` unique placeholder로 인한 `order_flush` 장기 대기 병목은 제거됐다"는 범위까지다. 주문 생성 `20 RPS / 5m` 운영 기준은 hotfix 후 재검증에서도 아직 통과하지 못했다.

## 5. 상세 트러블슈팅

### 5.0 2026-05-11 주문 20 RPS 재검증

실행 조건:

| 항목 | 값 |
|---|---|
| Run ID | `order20-troubleshoot-20260511-095748` |
| 대상 | `https://api.sallijang.shop` |
| Route53 alias | `pickup-prod-alb-1200962877.ap-northeast-2.elb.amazonaws.com` |
| 시나리오 | `order-create-load.js` |
| Rate | `20 iterations/s` |
| Duration | `5m` |
| VU | preAllocated `30`, max `300` |

결과:

| 항목 | 값 |
|---|---:|
| iterations | `4,735` |
| 실제 처리량 | `15.31 it/s` |
| 주문 201 | `4,718` |
| 5xx | `17` |
| http_req_failed | `0.35%` |
| dropped iterations | `1,265` |
| VU max | `300/300` |
| p95 | `30.97s` |
| max | `46.97s` |

판단:

- 주문 `20 RPS / 5m`는 다시 실패했다.
- VU가 max `300`까지 소진됐고 dropped iteration이 발생했으므로 서버 응답 지연으로 목표 arrival rate를 유지하지 못한 것으로 본다.
- 5xx도 `17건` 발생해 단순 tail latency만의 문제가 아니다.
- 현재 `api.sallijang.shop`은 prod ALB로 연결되어 있으므로, 이 결과는 2026-05-05의 dev 계열 리소스 기준 결과와 환경이 다를 수 있다.
- prod EKS는 임시 읽기 권한을 추가해 확인했다. order HPA는 `7 replicas`까지 scale-out됐고, product HPA도 테스트 중 `6 replicas`까지 scale-out 후 축소됐다.
- 이번에는 ArgoCD가 HPA scale-out을 곧바로 `2 replicas`로 되돌리는 패턴은 확인되지 않았다.
- order pod 일부에서 `Exit Code 139` segfault가 확인됐고, `[PERF] create_order` 로그는 다수의 긴 지연이 `stock_reserve`가 아니라 `order_flush`에 집중된 것을 보여줬다.

Kubernetes 관찰:

| 항목 | 관찰값 | 판단 |
|---|---|---|
| `order-hpa` | CPU `65% / 70%`, current replicas `7`, max `7` | 부하 후 최대 replica까지 scale-out |
| `product-hpa` | 테스트 중 `6`까지 scale-out 후 `2`로 축소 | product는 부하 해소 후 min으로 복귀 |
| scheduling | `0/2 nodes are available: 2 Insufficient cpu` 후 Karpenter nodeclaim 생성 | scale-out 중 node capacity 부족 구간 존재 |
| order pod restart | `order-deploy-7bc494dc74-grhkm` restart `65`, `Exit Code 139` | order-service 안정성 문제 동반 |
| product 로그 | 명확한 error grep 결과 없음 | 이번 실행의 1차 의심 지점은 product보다 order 쪽 |

order-service 대표 로그:

```text
[PERF] create_order total=31794.3ms ... stock_reserve=1.1ms order_flush=28621.0ms db_commit=20.1ms order_reload=3126.4ms
[PERF] create_order total=34820.7ms ... stock_reserve=1.0ms order_flush=32568.6ms db_commit=11.7ms order_reload=2203.4ms
[PERF] create_order total=29973.5ms ... stock_reserve=0.8ms order_flush=29251.9ms db_commit=22.1ms order_reload=678.7ms
```

segfault 대표 로그:

```text
Fatal Python error: Segmentation fault
Current thread:
  Garbage-collecting
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/state.py", line 204 in __init__
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/instrumentation.py", line 509 in new_instance
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/loading.py", line 1115 in _instance
Extension modules: ... greenlet._greenlet, asyncpg.pgproto.pgproto, asyncpg.protocol.protocol
```

추가 판단:

- 2026-05-11 실패는 HPA가 전혀 안 늘어서 생긴 단일 문제가 아니다. order-service가 scale-out된 상태에서도 p95와 5xx가 실패했다.
- 긴 지연의 주요 후보는 `order_flush` 내부의 ORM/DB flush 경로다. `db_commit`은 수십 ms로 기록된 로그가 많아 commit 자체보다 flush 전 insert/update, ORM 상태 처리, DB round-trip, connection checkout 대기, lock wait를 우선 확인해야 한다.
- order pod segfault는 성능 문제와 별도로 즉시 확인해야 한다. Python/SQLAlchemy/asyncpg/greenlet native extension 조합, GC 중 ORM 객체 로딩, SQS polling thread 동시 실행 여부가 점검 대상이다.

코드 확인 결과:

- 배포 기준 order-service `create_order`는 주문 ID 생성을 위해 `order_number="TEMP"`로 `orders` row를 먼저 insert/flush한 뒤, flush 후 실제 주문번호로 갱신한다.
- `orders.order_number`는 unique 컬럼이다.
- 부하 상황에서 모든 동시 주문이 같은 unique 값 `TEMP`를 insert하려고 하면 PostgreSQL unique index 충돌/대기 때문에 `db.flush()`가 길게 막힐 수 있다.
- 이 구조는 2026-05-11 로그의 `order_flush=28621~32568ms` 현상과 직접적으로 맞는다.
- `TEMP` 대신 요청별 고유 placeholder `PENDING-{uuid}`를 넣도록 수정했고, PR #1이 merge되어 배포됐다.
- 원본 repo 직접 push는 현재 GitHub 계정 권한으로 실패했지만, fork PR #1을 생성했고 권한자가 merge했다: https://github.com/Salijang/sallijang-backend-order/pull/1
- fork PR check는 AWS OIDC credential 부재로 실패했지만, 원본 `main` merge 후 push workflow는 성공했다.
- prod EKS 직접 patch도 현재 권한으로는 불가했다. `kubectl auth can-i patch deployment/order-deploy -n default` 결과는 `no`였다.

hotfix 후 재검증:

| 항목 | hotfix 전 | hotfix 후 |
|---|---:|---:|
| Run ID | `order20-troubleshoot-20260511-095748` | `order20-post-merge-20260511-110900` |
| iterations | `4,735` | `5,897` |
| 실제 처리량 | `15.31 it/s` | `17.25 it/s` |
| 201 | `4,718` | `5,896` |
| 5xx | `17` | `1` |
| dropped iterations | `1,265` | `103` |
| VU max | `300/300` | `133/300` |
| p95 | `30.97s` | `12.04s` |
| max | `46.97s` | `42.87s` |

hotfix 후 Kubernetes 관찰:

- `order-deploy` image는 `65da9519fc577cacaff7a9349688d14f96635dbe`로 반영됐고 rollout은 완료됐다.
- 재검증 직후 확인 시점에는 order pod 7개 모두 restart `0`이었다.
- order HPA는 `7 replicas`, product HPA는 테스트 후 `6 replicas`였다.
- `[PERF]` 로그의 `order_flush`는 대부분 수백 ms~1초대까지 내려왔다. 기존 `28~32s`급 flush 대기는 재현되지 않았다.

hotfix 후 후속 확인:

- 2026-05-11 12:10 KST 추가 확인에서 hotfix 이미지의 order pod 5/7개가 `Exit Code 139`로 재시작된 것을 확인했다.
- previous 로그에는 `Fatal Python error: Segmentation fault`, `Garbage-collecting`, SQLAlchemy ORM loading 경로, `greenlet`, `asyncpg` native extension이 다시 기록됐다.
- hotfix 후 남은 5xx 1건은 ingress 기준 `2026-05-11 11:17:07 KST`의 주문 `502`였다.
- 해당 502의 upstream은 `10.1.3.201:8002`, upstream response size는 `0`, upstream time은 `0.024s`였다.
- 따라서 hotfix 후 남은 5xx는 product-service 처리 실패보다 order pod 프로세스/연결 순간 실패 가능성이 높다.

대표 hotfix 후 로그:

```text
[PERF] create_order total=2255.4ms ... stock_reserve=186.7ms order_flush=415.5ms db_commit=123.7ms order_reload=1288.0ms ...
[PERF] create_order total=2483.4ms ... stock_reserve=173.5ms order_flush=435.4ms db_commit=223.6ms order_reload=1550.8ms ...
[PERF] create_order total=3108.0ms ... stock_reserve=1017.1ms order_flush=1065.9ms db_commit=25.2ms order_reload=957.5ms ...
```

가용 hotfix 후 `[PERF] create_order` 로그 213건 집계:

| 단계 | avg | p50 | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|
| total | `2688.2ms` | `2286.1ms` | `2932.0ms` | `3706.0ms` | `19951.3ms` |
| stock_reserve | `571.2ms` | `603.3ms` | `1172.8ms` | `1291.5ms` | `1474.0ms` |
| order_flush | `613.7ms` | `455.8ms` | `1012.7ms` | `1239.5ms` | `16890.4ms` |
| db_commit | `509.3ms` | `81.1ms` | `670.3ms` | `778.4ms` | `17897.6ms` |
| order_reload | `761.8ms` | `639.0ms` | `1099.7ms` | `1263.9ms` | `18185.2ms` |
| stock_deduct_publish | `90.7ms` | `44.3ms` | `178.0ms` | `220.5ms` | `4291.2ms` |
| notify_publish | `61.7ms` | `56.2ms` | `92.0ms` | `102.0ms` | `872.6ms` |
| store_publish | `79.8ms` | `19.0ms` | `83.1ms` | `98.3ms` | `7189.8ms` |

남은 병목 판단:

- p95 `12.04s`로 아직 기준 `1.5s`를 초과한다.
- hotfix 후 느린 로그는 `order_flush` 단일 30초 대기가 아니라 `db_commit`, `order_reload`, `order_flush`, publish 단계로 분산된다.
- 5xx `1건`은 ingress에서 order upstream `502`로 확인됐고, 같은 hotfix 이미지에서 `Exit Code 139`도 재발했다.
- 따라서 다음 조치의 1순위는 order-service 런타임 안정성, 2순위는 DB commit/reload/flush tail latency 분리다.

후속 조치 진행:

- PR #2를 생성했다: https://github.com/Salijang/sallijang-backend-order/pull/2
- 변경 내용은 주문 생성 직후 `selectinload` 재조회(`order_reload`)를 제거하고, 생성된 주문/아이템 객체로 응답과 이벤트 payload를 구성하는 것이다.
- 검증: `python3 -m compileall routers schemas.py models.py database.py sqs_client.py main.py`
- PR #2 체크는 SonarCloud/GitGuardian 통과, `build-and-push` 실패다. 이는 fork PR의 AWS OIDC credential 제한 패턴이며, 원본 `main` merge 후 push workflow에서 배포 확인이 필요하다.
- 기대 효과: SQLAlchemy ORM loading/GC 경로를 주문 생성 hot path에서 줄이고, `order_reload` 지연 구간을 제거한다.

PR #2 merge/deploy 결과:

- PR #2는 2026-05-11 12:26 KST에 merge됐다.
- Merge commit: `7c72acd9b2268edadd843f123d8b2f7141e3ff59`
- 원본 `main` push workflow `25648688748`의 `build-and-push`는 성공했다.
- `order-deploy` image는 `594486941613.dkr.ecr.ap-northeast-2.amazonaws.com/sallijang-backend-order:7c72acd9b2268edadd843f123d8b2f7141e3ff59`로 반영됐고 rollout이 성공했다.
- 배포 후 smoke 확인에서 상품 생성 `201`, 주문 생성 `201`을 확인했다. smoke 주문 ID는 `82733`, 주문번호는 `PK-20260511-82733`이다.
- smoke 직후 order pod 7개는 모두 `Running`, restart `0`이었다.

PR #2 배포 후 가벼운 부하 재검증:

| 항목 | 값 |
|---|---|
| Run ID | `order10-pr2-20260511-123200` |
| Rate | `10 iterations/s` |
| Duration | `3m` |
| Store ID | `7` |
| Product pool | `100` |
| VU 설정 | preAllocated `20`, max `100` |

| 지표 | 값 |
|---|---:|
| iterations | `1,772` |
| 실제 처리량 | `9.03 it/s` |
| 주문 201 | `1,772` |
| 5xx | `0` |
| http_req_failed | `0` |
| dropped iterations | `29` |
| VU max | `49/100` |
| http_req_duration p95 | `6.77s` |
| endpoint p95 | `7.87s` |
| max | `21.18s` |

판단:

- PR #2로 `order_reload` 단계는 제거됐고, 로그에는 `response_build=0.0ms` 수준으로 기록된다.
- 하지만 `10 RPS / 3m`에서도 p95 기준 `1.5s`는 실패했고 dropped iteration `29`가 남았다.
- 5xx는 `0`이라 요청 실패는 줄었지만, order pod 2개가 `Exit Code 139`로 재시작했다.
- previous 로그는 `Fatal Python error: Segmentation fault`, `Garbage-collecting`, SQLAlchemy ORM loading, `greenlet`, `asyncpg` native extension 경로를 다시 가리켰다.
- 따라서 PR #2는 불필요한 `order_reload` 지연은 제거했지만, segfault 근본 원인은 아직 미해결이다.

### 5.1 주문 생성 10 RPS 간헐 409

현상:

- 주문 생성 재검증에서 상품 pool을 100개로 늘렸는데도 `10 RPS`에서 `409`가 22건 발생했다.
- 5xx는 발생하지 않았다.
- order-service 로그에는 product 재고 차감 내부 호출 실패가 기록됐다.

대표 로그:

```text
[WARNING] 재고 수량 조정 실패 (...): All connection attempts failed
POST /api/v1/orders/ HTTP/1.1" 409 Conflict
```

원인 분리:

| 확인 항목 | 결과 |
|---|---|
| product remaining 직접 호출 | 같은 product endpoint는 직접 호출 시 `200 OK` 확인 |
| order pod 내부 product-service probe | 900/900건 `200` |
| product-service DNS/Service | 상시 장애는 아님 |
| DB timeout | 해당 구간에서는 명확한 DB timeout 증거 없음 |

판단:

- 단일 상품 경합만으로 보기 어렵다.
- product-service 자체가 계속 죽어 있는 상태도 아니다.
- 우선 의심 지점은 `order-service -> product-service` 내부 호출의 timeout, connection pool, retry, service discovery, readiness 전환 시점이다.
- 내부 호출 실패를 `409 Conflict`로 반환하는 정책이 적절한지도 별도 확인이 필요하다. 실제 재고 부족과 내부 호출 실패는 응답 코드/에러 코드가 분리되는 것이 운영 분석에 유리하다.

### 5.2 주문 생성 20 RPS tail latency

1차 결과:

| Target RPS | 주문 수 | 201 | 409 | 5xx | p95 | max | Dropped |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 1,103 | 1,103 | 0 | 0 | `29.55s` | `43.19s` | 98 |

2차 결과:

| Target RPS | Duration | 주문 시도 | 201 | 409 | 5xx | endpoint p95 | max | 판단 |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 20 | 5m | 6,000 | 5,999 | 0 | 1 | `8.22s` | `13.74s` | 실패 |
| 20 HPA 조치 후 | 5m | 6,001 | 6,001 | 0 | 0 | `7.85s` | `17.05s` | 실패 |

판단:

- 주문 생성 `20 RPS` 병목은 1차와 2차에서 모두 재현됐다.
- 2차에서 HPA/GitOps 조치 후 5xx는 제거됐지만 p95는 계속 기준 `1.5s`를 초과했다.
- 따라서 HPA/GitOps 충돌은 scale-out 불안정과 502의 직접 원인이지만, 주문 생성 tail latency의 유일 원인은 아니다.

추가 확인 대상:

- order-service 내부 처리 단계별 소요 시간
- DB connection pool, lock wait, slow query, transaction duration
- product-service 재고 차감 내부 호출 latency
- order-service HTTP client timeout, keep-alive, retry 설정
- notify 등 주문 부가 처리 경로가 응답시간에 주는 영향

### 5.3 HPA와 ArgoCD self-heal 충돌

관찰 증거:

| 항목 | 결과 |
|---|---|
| order HPA 목표 | CPU `70%` 기준 scale-out |
| 주문 20 RPS 중 HPA | `2 current / 4 desired` |
| ArgoCD app | `sallijang-order`, `selfHeal=true`, `prune=true` |
| deployment event | `Scaled up ... to 4 from 2`, `Scaled down ... to 2 from 4` 반복 |
| ArgoCD 로그 | automated sync 반복, `order-deploy configured` 반복 |
| pod event | HPA로 생성된 order pod가 곧바로 `Terminating`되는 패턴 |

해석:

- HPA는 부하에 반응해 order pod를 늘리려 했다.
- 하지만 GitOps desired manifest에 `spec.replicas: 2`가 남아 있어 ArgoCD self-heal이 이를 반복 적용했다.
- 이로 인해 신규 pod가 안정적으로 유지되지 못했고, 실제 처리 capacity가 2 replicas 근처에 묶인 것으로 판단한다.

임시 조치:

- ArgoCD application `sallijang-order`, `sallijang-product`에 `/spec/replicas` ignore rule 적용
- `RespectIgnoreDifferences=true` 적용
- 조치 후 order/product HPA는 각각 `5 replicas`를 유지

임시 조치 결과:

- `20 RPS / 5m` 재실행에서 5xx는 `0`으로 제거됐다.
- 그러나 endpoint p95는 `7.85s`로 기준을 계속 초과했다.
- 따라서 이 조치는 최종 해결이 아니라, HPA/GitOps 충돌 영향을 분리하기 위한 임시 조치로 기록한다.

후속 조치:

- HPA 대상 deployment에서는 GitOps manifest에서 `spec.replicas`를 제거하거나, ArgoCD ignoreDifferences 정책을 manifest로 영구화해야 한다.
- 임시 클러스터 패치가 아니라 `sallijang-manifest` 저장소에 반영되어야 재발을 막을 수 있다.

### 5.4 product remaining 240 RPS 실패

목적:

- 주문 생성 실패가 product remaining API 자체 한계 때문인지 분리하기 위해 order-service를 거치지 않고 product-service remaining API를 직접 호출했다.

결과:

| Target RPS | 200 | 409 | 5xx | p95 |
|---:|---:|---:|---:|---:|
| 40 | 2,400 | 0 | 0 | `36.07ms` |
| 80 | 4,801 | 0 | 0 | `36.58ms` |
| 120 | 7,201 | 0 | 0 | `40.46ms` |
| 160 | 9,601 | 0 | 0 | `81.45ms` |
| 240 | 553 | 0 | 860 | `9.21s` |

추가 지표:

- `240 RPS`에서 status other/request timeout 계열 `7,198`
- VU max `3000`
- dropped iteration `5,790`

판단:

- product remaining API 자체는 `160 RPS`까지 안정적이었다.
- `240 RPS`는 명확한 실패 구간이다.
- 이 구간은 k6 VU 부족보다는 서버 응답 지연, product-service 처리 한계, DB connection pool, ingress 처리 실패 누적으로 보는 것이 합리적이다.

### 5.5 상품 생성/삭제 80 RPS 502

결과:

| Target RPS | HTTP p95 | Created 201 | Delete 204 | 5xx/502 | Dropped |
|---:|---:|---:|---:|---:|---:|
| 40 | `53.59ms` | 2,400 | 2,400 | 0 | 0 |
| 80 | `4.06s` | 4,799 | 4,799 | 2~6 | 0 |

관찰:

- `80 RPS`에서 `POST /api/v1/products/?store_id=...` create 요청에 502 발생
- product service app 로그에서는 명확한 QueuePool/Traceback/Exception이 잡히지 않은 실행이 있었다.
- ingress/upstream 레벨 실패로 기록됐다.
- product HPA는 테스트 직후 CPU 상승을 보고 scale-out을 시도했다.

판단:

- 상품 생성/삭제는 `40 RPS`까지 안정적이다.
- `80 RPS`에서는 app 내부 예외만으로 설명하기 어려운 ingress/upstream 또는 pod lifecycle 문제가 섞여 있을 수 있다.
- 짧은 burst 중 readiness, termination, HPA stabilization, upstream timeout을 함께 봐야 한다.

### 5.6 public 진입점 상태 불안정

한계 테스트 후 확인된 상태:

- Route53 `api.sallijang.shop` A alias는 `pickup-dev-alb-293633002.ap-northeast-2.elb.amazonaws.com`을 가리킴
- 로컬 DNS에서 `api.sallijang.shop` 및 alias ALB DNS 해석 실패가 관찰됨
- `ingress-nginx` namespace에 실행 중인 controller resource가 확인되지 않은 시점이 있음
- product cleanup을 위해 port-forward와 apiserver service proxy를 시도했으나 product endpoint까지 연결되지 않음

판단:

- 이 시점 이후의 public API 부하 테스트는 애플리케이션 처리 한계가 아니라 DNS/LB/ingress 진입점 장애에 의해 왜곡될 수 있다.
- 추가 테스트 전 public 진입점 복구 확인이 선행되어야 한다.

### 5.7 테스트 도구/환경 이슈

| 이슈 | 내용 | 처리 |
|---|---|---|
| TLS 인증서 SAN | `api.sallijang.shop`이 인증서에 포함되지 않아 k6/curl에서 인증서 검증 실패 | 임시로 `--insecure-skip-tls-verify`, 정식으로 ACM SAN/wildcard 필요 |
| 로컬 runner 시간 튐 | WSL/local runner wall-clock이 약 `5h38m` 튀며 request timeout 발생 | 해당 결과는 backend 병목으로 단정하지 않음, 안정적인 EC2/CI runner 권장 |
| k6 URL cardinality | 랜덤 query string 조합이 URL별 고유 시계열로 잡힘 | `requestOptions()`에 `name` tag 추가해 endpoint grouping 보정 |
| 인증 만료 | 주문 반복 테스트 중 seller/buyer token 만료로 `401` 발생 | 해당 실행은 병목 판단에서 제외, 재로그인 후 cleanup |

### 5.8 PR #3 및 리소스 증설 후 재확인

PR #3:

- Repository: `Salijang/sallijang-backend-order`
- PR: https://github.com/Salijang/sallijang-backend-order/pull/3
- Merge commit: `ec1ee1162dec69b06d74ac19c431cea1b9f52947`
- 조치:
  - `DISABLE_SQLALCHEMY_CEXT=1`
  - `pip install --no-binary=SQLAlchemy`
  - `SQLAlchemy==2.0.49`, `asyncpg==0.31.0` 고정
- 근거: SQLAlchemy 공식 문서는 C extension 빌드를 시도하지 않도록 `DISABLE_SQLALCHEMY_CEXT` 환경변수를 사용할 수 있다고 설명한다.

배포 확인:

- ECR image tag `ec1ee1162dec69b06d74ac19c431cea1b9f52947` 생성 확인
- `sallijang-manifest` image tag 자동 갱신 확인
- `order-deploy` rollout 성공
- 배포 후 smoke:
  - 상품 생성 `201`, product ID `685`
  - 주문 생성 `201`, order ID `84506`

PR #3 직후 `10 RPS / 2m` 재검증:

| 항목 | 값 |
|---|---:|
| Run ID | `order10-pr3-20260511-125800` |
| 주문 201 | `1,157` |
| 5xx | `23` |
| http_req_failed | `1.79%` |
| dropped iterations | `20` |
| endpoint p95 | `7.09s` |
| max | `16.42s` |

pod 상태:

- order pod 1개가 `OOMKilled`, exit `137`
- rollout 직전 다른 기존 pod 1개에서 `Error`, exit `139`도 추가 관측됨

판단:

- PR #3은 SQLAlchemy C extension 경로를 줄이기 위한 완화 조치지만, 이 시점에서 segfault가 완전히 해결됐다고 볼 수 없다.
- 5xx의 직접 원인은 부하 중 pod restart였고, 그중 하나는 메모리 제한 `1Gi` 초과였다.
- pure Python SQLAlchemy로 전환하면서 CPU/메모리 사용량이 늘었을 가능성도 있다.

Manifest 리소스 증설:

- Repository: `Salijang/sallijang-manifest`
- PR: https://github.com/Salijang/sallijang-manifest/pull/3
- Merge commit: `c3242f1d12ab8dc8e29d286013b7c924e224ec33`
- 조치:
  - order-service memory request `256Mi -> 512Mi`
  - order-service memory limit `1Gi -> 2Gi`
- rollout 후 `order-deploy`는 memory request `512Mi`, limit `2Gi`로 반영됨

리소스 증설 후 `10 RPS / 2m` 재검증:

| 항목 | 값 |
|---|---:|
| Run ID | `order10-pr3-mem-20260511-130600` |
| 주문 201 | `1,166` |
| 5xx | `0` |
| http_req_failed | `0` |
| dropped iterations | `35` |
| endpoint p95 | `11.57s` |
| max | `22.70s` |
| order pod restart | `0` |

판단:

- 메모리 증설 후 짧은 `10 RPS / 2m`에서는 5xx와 pod restart가 사라졌다.
- 다만 p95가 `11.57s`로 더 높아 응답시간 기준은 여전히 실패다.
- 현재 상태는 "사용자 실패율은 낮춘 상태"이지 "성능 문제가 해결된 상태"가 아니다.
- 팀 프로젝트 시연 수준에서는 10 RPS 전후의 짧은 주문 생성은 버틸 가능성이 높아졌지만, 안정 용량으로 주장하려면 tail latency 원인 분석이 더 필요하다.

수용량 및 동접 추정:

| 구분 | 현재 보고 가능 수치 | 해석 |
|---|---:|---|
| 주문 생성 부하 | `10 RPS / 2m` | 초당 주문 생성 약 10건 수준 |
| 주문 생성 성공 | `1,166건` | 전체 주문 요청이 `201 Created`로 처리됨 |
| 주문 생성 실패 | `5xx 0건`, pod restart `0건` | 짧은 테스트 기준 장애성 실패 없음 |
| 최대 VU | `55` | 주문 생성 API를 동시에 밀어 넣은 가상 사용자 규모 |
| 응답시간 | endpoint p95 `11.57s` | 쾌적한 성능은 아니며 tail latency 개선 필요 |

보고용 결론:

- 주문 생성 API 기준으로는 **동시 주문 부하 약 50명**, **초당 주문 약 10건**까지는 장애 없이 처리한 것으로 보고한다.
- 전체 서비스 동접은 모든 사용자가 동시에 주문하지 않는다는 가정이 필요하다.
- 보수적으로 전체 접속자의 `20%`가 주문 생성까지 진행한다고 보면, `50 / 0.2 = 250`명이므로 **전체 서비스 동접 약 250명 내외**로 추정한다.
- 이 값은 "실패 없이 버틴 범위"이지 "p95까지 안정적인 확정 수용량"은 아니다.

## 6. 재발 방지 및 후속 액션

우선순위:

1. order-service `Exit Code 139` segfault는 PR #3 이후에도 1회 추가 관측됐으므로 근본 원인 미해결로 관리한다.
2. 리소스 증설 후 5xx/restart는 짧은 재검증에서 사라졌지만, p95 `11.57s`가 남아 tail latency 원인을 계속 추적한다.
3. SQS polling thread를 주문 API process와 분리하거나, 같은 process에서 asyncpg/SQLAlchemy/greenlet과 충돌할 가능성을 확인한다.
4. 남은 주문 p95 지연을 `order_flush`, `db_commit`, `stock_deduct_publish`, `notify_publish` 단계별로 분리한다.
5. order-service DB connection pool checkout 대기, lock wait, slow query, transaction duration, ORM flush 대상 객체 수를 주문 생성 시간대와 대조한다.
6. pure Python SQLAlchemy 전환 후 CPU/메모리 사용량이 증가했는지 CloudWatch Container Insights 또는 metrics-server 권한으로 확인한다.
7. `sallijang-manifest`의 HPA 대상 deployment에서 `spec.replicas`를 제거하거나 ArgoCD ignoreDifferences 정책을 영구 반영한다.
8. `order-service -> product-service` 내부 호출의 timeout, keep-alive, connection pool, retry 정책을 확인한다.
9. product-service remaining API의 `200 RPS~240 RPS` 구간을 더 촘촘히 재측정한다.
10. ingress-nginx, ALB target health, upstream timeout, pod readiness/termination event를 테스트 시간대별로 함께 수집한다.
11. `api.sallijang.shop` TLS 인증서를 SAN 또는 wildcard 인증서로 교체한다.
12. capacity 판정용 k6 runner는 WSL/local이 아니라 같은 region EC2, CI runner, 또는 클러스터 내부 runner를 사용한다.
13. 테스트 계정 token 만료 시간을 고려해 장시간/반복 실행 전 env를 갱신한다.
14. 조치 후 주문 생성 `10/20/40 RPS`를 같은 조건으로 재실행한다.
15. runner의 S3 업로드 대상 버킷을 현재 계정 기준으로 정리한다. 현재 계정에는 `pickup-dev-logs`가 없고 `pickup-prod-logs`만 확인된다.
16. k6 runner subnet route table의 IGW 기본 route를 Terraform에 반영한다. 2026-05-11에 `rtb-01b43a8737ff469b6`에 `0.0.0.0/0 -> igw-023ad0d0b3a41163d`를 임시 추가했다.
17. `api.sallijang.shop`이 prod ALB를 바라보는 상태에서 부하 테스트를 계속할지 팀과 확인한다.
18. prod EKS 확인을 위해 추가한 `arn:aws:iam::594486941613:user/CHS` 임시 access entry를 제거한다. 정리 시점의 CLI credential이 다른 계정(`150809275884`)으로 전환되어 즉시 제거하지 못했다.

## 7. 다음 테스트 기준

다음 테스트는 단순히 RPS를 더 올리기보다 `20 RPS` 주문 생성 병목을 먼저 줄이는 방향으로 진행한다.

권장 순서:

1. public 진입점 smoke: `/health`, 상품 조회, 인증 API
2. HPA/ArgoCD replicas 충돌 미발생 확인
3. order-service segfault 원인 조치
4. 시연 전 public 진입점과 주문 생성 smoke 재확인
5. p95가 `1.5s` 이하로 내려간 뒤 `30/40 RPS` 탐색

통과 기준:

| 항목 | 기준 |
|---|---:|
| 주문 생성 5xx | `0` |
| 주문 생성 409 | 내부 호출 실패성 409는 `0` |
| endpoint p95 | `1.5s` 이하 |
| dropped iteration | `0` |
| HPA scale-out | 부하 중 desired replicas 유지 |
| ArgoCD sync | HPA scale-out을 즉시 원복하지 않음 |

## 8. 근거 문서

- `tests/performance/results/final-reports/aws-20260505/evidence/20260505-public-api-write-scenarios-report.md`
- `tests/performance/results/final-reports/aws-20260505/evidence/20260505-sequential-test-report.md`
- `tests/performance/results/final-reports/aws-2nd-test-report.md`
- `tests/performance/results/aws-2nd-20260507/README.md`
- `tests/performance/k6/sallijang/DEV_TEST_STATUS_2026-05-05.md`
- `tests/performance/results/aws-troubleshoot-20260511/README.md`
- SQLAlchemy 2.0 Documentation, Overview / C extension build control: https://docs.sqlalchemy.org/20/intro.html
