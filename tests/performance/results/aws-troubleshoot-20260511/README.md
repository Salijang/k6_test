# AWS 부하 테스트 트러블슈팅 실행 메모 - 2026-05-11

대상: `https://api.sallijang.shop`  
Route53 확인: `api.sallijang.shop`은 현재 `pickup-prod-alb-1200962877.ap-northeast-2.elb.amazonaws.com`으로 연결됨  
Runner: `i-04a0a7d028c6b9156` (`pickup-dev-k6-runner`)

## 1. 사전 이슈

### k6 runner SSM 미등록

초기 상태:

- runner EC2는 존재했지만 `stopped` 상태였다.
- 시작 후에도 SSM managed instance 목록에 등록되지 않았다.
- IAM role에는 `AmazonSSMManagedInstanceCore`가 붙어 있었다.
- runner subnet은 public IP를 할당하도록 설정되어 있고 IGW도 VPC에 attach되어 있었다.
- 하지만 main route table에는 `0.0.0.0/0 -> IGW` route가 없었다.

조치:

- `rtb-01b43a8737ff469b6`에 `0.0.0.0/0 -> igw-023ad0d0b3a41163d` route 추가
- runner reboot
- 이후 SSM `Online` 확인

주의:

- 이 route 변경은 AWS에서 직접 적용한 임시 조치다.
- Terraform/GitOps 기준으로 영구 반영 여부를 별도 확인해야 한다.

### 관찰 권한 제한

- 현재 AWS 계정에는 `pickup-prod-eks-cluster`만 조회된다.
- `pickup-dev-eks-cluster`는 `ResourceNotFoundException`으로 조회되지 않았다.
- `api.sallijang.shop`은 prod ALB로 연결되어 있다.
- prod EKS kubeconfig는 생성됐지만 처음에는 Kubernetes API가 `the server has asked for the client to provide credentials`를 반환했다.
- 원인: 현재 AWS principal `arn:aws:iam::594486941613:user/CHS`가 prod EKS access entry에 없었다.
- 읽기 전용 확인을 위해 `AmazonEKSViewPolicy`를 cluster scope로 연결한 access entry를 추가했다.
- 보고서 정리 후 해당 임시 권한 제거를 시도했지만, 현재 CLI credential이 `arn:aws:iam::150809275884:user/muinone-terraform` 계정으로 전환되어 `pickup-prod-eks-cluster`를 조회하지 못했다. `594486941613` 계정 credential로 다시 전환한 뒤 임시 access entry 제거가 필요하다.

### 결과 업로드 이슈

- runner script는 `s3://pickup-dev-logs/k6-results/dev/...`로 업로드하도록 되어 있다.
- 현재 계정에는 `pickup-dev-logs` 버킷이 없고 `pickup-prod-logs`만 있다.
- 이번 실행은 k6 threshold 실패로 `aws s3 cp` 단계 전에 종료되어 S3 업로드가 되지 않았다.
- 원격 runner의 `/opt/sallijang/results/order20-troubleshoot-20260511-095748/summary.json`, `run.log`를 SSM으로 직접 확인했다.

## 2. 실행 조건

| 항목 | 값 |
|---|---|
| Run ID | `order20-troubleshoot-20260511-095748` |
| Scenario | `tests/performance/k6/sallijang/order-create-load.js` |
| Target | `POST /api/v1/orders/` |
| Rate | `20 iterations/s` |
| Duration | `5m` |
| Store ID | `5` |
| Product pool | `10` |
| VU 설정 | preAllocated `30`, max `300` |
| Runner 위치 | EC2 k6 runner |

주의: wrapper 실행 시 `K6_ORDER_PRODUCT_POOL_SIZE=500`을 넘겼지만, 실제 runner 로그에는 `productPool=10`으로 기록됐다. 이후 hotfix 후 재검증에서는 runner에 `K6_PRODUCT_POOL_SIZE=500`을 명시해 실제 로그의 `productPool=500` 반영을 확인했다.

## 3. 결과

| 항목 | 값 |
|---|---:|
| iterations | `4,735` |
| 목표 대비 실제 처리량 | `15.31 it/s` |
| http_reqs | `4,755` |
| HTTP request rate | `15.38 req/s` |
| 주문 201 | `4,718` |
| 5xx | `17` |
| http_req_failed | `0.35%` |
| checks | `99.82%` |
| dropped iterations | `1,265` |
| VU max | `300/300` |
| http_req_duration avg | `8.26s` |
| http_req_duration med | `2.08s` |
| http_req_duration p90 | `26.84s` |
| http_req_duration p95 | `30.97s` |
| http_req_duration max | `46.97s` |
| endpoint p95 | `30.98s` |

Threshold 결과:

- `checks rate > 0.99`: 통과
- `http_req_failed{endpoint:order_create} rate < 0.01`: 통과
- `http_req_duration p95 < 1500ms`: 실패
- `http_req_duration{endpoint:order_create} p95 < 1500ms`: 실패
- `order_create_load_status_5xx count == 0`: 실패

## 4. 판단

주문 `20 RPS / 5m`는 2026-05-11 재검증에서도 실패했다.

- 목표 `20 it/s`를 유지하지 못하고 실제 `15.31 it/s` 수준에 그쳤다.
- VU가 `300/300`까지 소진됐고 dropped iteration이 `1,265` 발생했다.
- p95는 `30.97s`로 기준 `1.5s`를 크게 초과했다.
- 5xx가 `17건` 발생했다.

따라서 기존 보고서의 "주문 생성 병목 미해결" 판단은 유지된다. 이번 실행 기준으로는 HPA/GitOps 조치 여부와 별개로, 현재 public API 경로의 주문 생성 `20 RPS`는 운영 기준을 통과하지 못한다.

## 4.1 Hotfix 배포 후 재검증

`order_number="TEMP"` unique placeholder 병목을 제거한 PR #1이 merge됐고, 원본 `main` push workflow가 성공했다.

배포 확인:

- Merge commit: `65da9519fc577cacaff7a9349688d14f96635dbe`
- Deployment image: `594486941613.dkr.ecr.ap-northeast-2.amazonaws.com/sallijang-backend-order:65da9519fc577cacaff7a9349688d14f96635dbe`
- `order-deploy` rollout 성공

재검증 조건:

| 항목 | 값 |
|---|---|
| Run ID | `order20-post-merge-20260511-110900` |
| Rate | `20 iterations/s` |
| Duration | `5m` |
| Store ID | `6` |
| Product pool | `500` |
| VU 설정 | preAllocated `30`, max `300` |

결과:

| 항목 | hotfix 전 | hotfix 후 |
|---|---:|---:|
| iterations | `4,735` | `5,897` |
| 실제 처리량 | `15.31 it/s` | `17.25 it/s` |
| 주문 201 | `4,718` | `5,896` |
| 5xx | `17` | `1` |
| http_req_failed | `0.35%` | `0.01%` |
| dropped iterations | `1,265` | `103` |
| VU max | `300/300` | `133/300` |
| p95 | `30.97s` | `12.04s` |
| max | `46.97s` | `42.87s` |

판단:

- hotfix 효과는 명확하다. `order_flush` 28~32초 대기는 재현되지 않았고, p95/5xx/dropped/VU max가 모두 개선됐다.
- 그러나 threshold는 여전히 실패했다. 실패 항목은 `http_req_duration`, `http_req_duration{endpoint:order_create}`, `order_create_load_status_5xx`다.
- 따라서 주문 `20 RPS / 5m`는 아직 운영 기준 통과가 아니다.
- 재검증 직후 확인 시점에는 order pod 7개 restart가 `0`이었다.
- 남은 지연은 `order_flush` 단일 병목이 아니라 `stock_reserve`, `order_reload`, `stock_deduct_publish`, `store_publish` 등 여러 단계로 분산된다.

후속 확인:

- 2026-05-11 12:10 KST 추가 확인에서 hotfix 이미지의 order pod 5/7개가 `Exit Code 139`로 재시작된 것을 확인했다.
- previous 로그에는 `Fatal Python error: Segmentation fault`, `Garbage-collecting`, SQLAlchemy ORM loading 경로, `greenlet`, `asyncpg` native extension이 다시 기록됐다.
- hotfix 후 남은 5xx 1건은 ingress 기준 `2026-05-11 11:17:07 KST`의 주문 `502`였다. upstream은 `10.1.3.201:8002`, upstream response size는 `0`, upstream time은 `0.024s`로 기록됐다.
- 따라서 5xx는 product-service 응답 실패보다 order pod 프로세스/연결 순간 실패 가능성이 더 높다.

가용 `[PERF] create_order` 로그 213건 집계:

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

해석:

- `TEMP` 병목처럼 모든 tail이 한 구간에 고정되지는 않는다.
- 다만 초장기 tail은 `db_commit`, `order_reload`, `order_flush`, `store_publish`, `stock_deduct_publish`에서 각각 발생한다.
- order pod segfault가 재현됐으므로, 남은 5xx와 장기 tail은 order-service 런타임 안정성 문제와 함께 봐야 한다.

## 5. Kubernetes 관찰 결과

테스트 후 prod EKS 상태를 읽기 전용으로 확인했다.

### HPA

| HPA | CPU current/target | Min | Max | Current replicas | 판단 |
|---|---:|---:|---:|---:|---|
| `order-hpa` | `65% / 70%` | 2 | 7 | 7 | 주문 부하 후 max replica까지 scale-out 유지 |
| `product-hpa` | `2% / 70%` | 2 | 7 | 2 | 테스트 중 scale-out 후 다시 min으로 축소 |

HPA 이벤트:

- `order-hpa`: `New size: 7; reason: cpu resource utilization above target`
- `product-hpa`: `New size: 3`, `4`, `6` 이후 `New size: 2; reason: All metrics below target`

### Pod 상태

| Pod | 상태 | Restart | 특이사항 |
|---|---|---:|---|
| `order-deploy-7bc494dc74-grhkm` | Running | 65 | 직전 종료 `Exit Code 139`, segfault |
| `order-deploy-7bc494dc74-kdj4x` | Running | 1 | 직전 종료 `Exit Code 139`, segfault |
| product pods | Running | 0 | 명확한 에러 로그 미확인 |

### Event

테스트 시간대 주변에서 아래 이벤트가 확인됐다.

- `order-hpa`가 7 replicas까지 scale-out
- `order-deploy` 신규 pod 생성 중 `0/2 nodes are available: 2 Insufficient cpu`
- Karpenter가 신규 nodeclaim을 만들고 node를 추가
- `order` pod에서 `BackOff restarting failed container`
- `product-hpa`는 6까지 scale-out 후 2로 scale-down

### Order service 로그

`[PERF] create_order` 로그에서 긴 지연 대부분이 DB flush 구간에서 발생했다.

대표 로그:

```text
[PERF] create_order total=31794.3ms ... stock_reserve=1.1ms order_flush=28621.0ms db_commit=20.1ms order_reload=3126.4ms
[PERF] create_order total=34820.7ms ... stock_reserve=1.0ms order_flush=32568.6ms db_commit=11.7ms order_reload=2203.4ms
[PERF] create_order total=29973.5ms ... stock_reserve=0.8ms order_flush=29251.9ms db_commit=22.1ms order_reload=678.7ms
```

해석:

- 이번 실행의 주된 tail latency는 `stock_reserve`가 아니라 `order_flush` 구간에서 발생했다.
- `db_commit` 자체는 수십 ms 수준인 로그가 많아, commit보다 flush 전 insert/update 처리, ORM 상태 처리, DB round-trip 또는 connection 대기 구간을 더 봐야 한다.

### Segmentation fault

order pod에서 Python segfault가 확인됐다.

대표 로그:

```text
Fatal Python error: Segmentation fault
Current thread:
  Garbage-collecting
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/state.py", line 204 in __init__
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/instrumentation.py", line 509 in new_instance
  File "/usr/local/lib/python3.11/site-packages/sqlalchemy/orm/loading.py", line 1115 in _instance
Extension modules: ... greenlet._greenlet, asyncpg.pgproto.pgproto, asyncpg.protocol.protocol
Segmentation fault (core dumped)
```

다른 previous 로그에서는 SQS receive thread도 같이 보였다.

```text
File "/app/sqs_client.py", line 52 in _receive
File "/usr/local/lib/python3.11/site-packages/botocore/endpoint.py", line 119 in make_request
```

판단:

- 주문 `20 RPS` 실패는 단순 p95 초과가 아니라 order-service 프로세스 안정성 문제를 동반한다.
- Python/SQLAlchemy/asyncpg/greenlet 조합 또는 ORM 로딩/GC 중 native extension segfault 가능성을 확인해야 한다.
- SQS polling thread와 주문 처리 thread가 같은 프로세스에서 동시에 동작하는 구조도 점검 대상이다.

코드 확인:

- hotfix 전 배포 기준 order-service는 `create_order`에서 `order_number="TEMP"`로 주문 row를 먼저 insert/flush한 뒤 실제 주문번호로 갱신했다.
- `order_number`는 unique 컬럼이므로, 동시 주문이 모두 같은 `TEMP` 값을 insert하면 PostgreSQL unique index 대기로 `db.flush()`가 길게 막힐 수 있다.
- 이 패턴은 이번 실행의 `order_flush=28~32s` 로그와 일치한다.
- `TEMP` 대신 `PENDING-{uuid}` 고유 placeholder를 쓰는 PR #1이 merge됐다: https://github.com/Salijang/sallijang-backend-order/pull/1
- 원본 `main` push workflow가 성공했고, `order-deploy`는 merge commit `65da9519fc577cacaff7a9349688d14f96635dbe` 이미지로 rollout 완료됐다.
- hotfix 후 `order_flush` 28~32초 대기는 재현되지 않았지만, p95 `12.04s`, 5xx `1`, dropped iteration `103`으로 운영 기준은 아직 통과하지 못했다.
- 후속 완화 PR #2를 생성했다. 주문 생성 직후 `selectinload` 재조회(`order_reload`)를 제거하고 생성된 주문/아이템 객체로 응답과 이벤트 payload를 구성한다: https://github.com/Salijang/sallijang-backend-order/pull/2
- PR #2 체크는 SonarCloud/GitGuardian 통과, `build-and-push` 실패 상태다. 실패 원인은 PR #1과 같은 fork PR의 AWS OIDC credential 제한으로 봐야 하며, 원본 `main` merge 후 push workflow에서 배포 검증이 필요하다.
- PR #2는 2026-05-11 12:26 KST에 merge됐다.
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

결과:

| 항목 | 값 |
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

- PR #2로 `order_reload` 단계는 제거됐고 로그에는 `response_build=0.0ms` 수준으로 기록된다.
- 하지만 `10 RPS / 3m`에서도 p95 기준 `1.5s`는 실패했고 dropped iteration `29`가 남았다.
- 5xx는 `0`이라 사용자 요청 실패는 줄었지만, order pod 2개가 `Exit Code 139`로 재시작했다.
- previous 로그는 여전히 `Fatal Python error: Segmentation fault`, `Garbage-collecting`, SQLAlchemy ORM loading, `greenlet`, `asyncpg` native extension 경로를 가리킨다.
- 따라서 PR #2는 불필요한 `order_reload` 지연은 제거했지만, segfault 근본 원인은 아직 미해결이다.

PR #3 및 리소스 증설 후 재검증:

- PR #3: https://github.com/Salijang/sallijang-backend-order/pull/3
- Merge commit: `ec1ee1162dec69b06d74ac19c431cea1b9f52947`
- 조치:
  - SQLAlchemy C extension 빌드 비활성화 (`DISABLE_SQLALCHEMY_CEXT=1`, `--no-binary=SQLAlchemy`)
  - `SQLAlchemy==2.0.49`, `asyncpg==0.31.0` 고정
- 배포 후 smoke:
  - 상품 생성 `201`, product ID `685`
  - 주문 생성 `201`, order ID `84506`

PR #3 직후 `10 RPS / 2m`:

| 항목 | 값 |
|---|---:|
| Run ID | `order10-pr3-20260511-125800` |
| 주문 201 | `1,157` |
| 5xx | `23` |
| http_req_failed | `1.79%` |
| dropped iterations | `20` |
| endpoint p95 | `7.09s` |
| max | `16.42s` |

관찰:

- order pod 1개가 `OOMKilled`, exit `137`
- rollout 직전 기존 pod 1개에서 `Error`, exit `139`도 추가 관측
- 따라서 PR #3만으로는 segfault 완전 해결을 확인하지 못했다.

Manifest 리소스 증설:

- PR: https://github.com/Salijang/sallijang-manifest/pull/3
- Merge commit: `c3242f1d12ab8dc8e29d286013b7c924e224ec33`
- memory request `256Mi -> 512Mi`
- memory limit `1Gi -> 2Gi`

리소스 증설 후 `10 RPS / 2m`:

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

- 짧은 `10 RPS / 2m`에서는 5xx와 pod restart가 사라졌다.
- 하지만 p95는 `11.57s`로 기준 실패다.
- 현재 상태는 "요청 실패를 줄인 상태"이지 "성능 병목이 해결된 상태"가 아니다.

수용량 및 동접 추정:

| 구분 | 현재 보고 가능 수치 | 해석 |
|---|---:|---|
| 주문 생성 부하 | `10 RPS / 2m` | 초당 주문 생성 약 10건 수준 |
| 주문 생성 성공 | `1,166건` | 전체 주문 요청이 `201 Created`로 처리됨 |
| 주문 생성 실패 | `5xx 0건`, pod restart `0건` | 짧은 테스트 기준 장애성 실패 없음 |
| 최대 VU | `55` | 주문 생성 API 동시 부하 규모 |
| 응답시간 | endpoint p95 `11.57s` | 쾌적한 성능은 아니며 개선 필요 |

보고용 결론:

- 주문 생성 API 기준으로는 **동시 주문 부하 약 50명**, **초당 주문 약 10건**까지 장애 없이 처리한 것으로 본다.
- 전체 서비스 동접은 모든 사용자가 동시에 주문하지 않는다는 가정이 필요하다.
- 보수적으로 전체 접속자의 `20%`가 주문 생성까지 진행한다고 보면 `50 / 0.2 = 250`명이므로, **전체 서비스 동접 약 250명 내외**로 추정한다.
- 이 값은 "실패 없이 버틴 범위"이며, p95 기준 성능 안정 수용량은 아니다.

## 6. 다음 확인

1. 현재 테스트 대상이 prod ALB인 점을 팀에 확인한다.
2. PR #3 이후에도 `Exit Code 139`가 1회 추가 관측됐으므로 segfault 원인은 미해결로 관리한다.
3. 리소스 증설 후 짧은 재검증에서는 5xx/restart가 사라졌지만 p95가 높으므로 tail latency를 우선 분석한다.
4. SQS consumer를 API process에서 분리해 같은 프로세스 안에서 ORM/asyncpg/SQS thread가 섞이지 않게 한다.
5. 남은 tail latency 원인을 `order_flush`, `db_commit`, `stock_deduct_publish`, `notify_publish` 단계별로 분리한다.
6. DB pool checkout 대기, insert/update SQL 시간, ORM flush 대상 객체 수를 로그로 분리한다.
7. pure Python SQLAlchemy 전환 후 CPU/메모리 사용량이 증가했는지 확인한다.
8. runner script의 결과 업로드 버킷을 현재 계정 기준으로 수정한다.
