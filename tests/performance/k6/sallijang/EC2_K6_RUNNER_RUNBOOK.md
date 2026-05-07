# EC2 k6 Runner Runbook

Terraform PR로 생성하는 k6 runner는 테스트 스크립트를 로컬에서 직접 복사해서 쓰는 장비가 아니다.
공식 실행 기준은 `Salijang/k6_test` 레포의 `main` 브랜치다.

## 역할 분리

- 로컬 PC: k6 스크립트 작성, 수정, 커밋, push
- GitHub `Salijang/k6_test`: 공식 k6 스크립트 저장소
- EC2 k6 runner: GitHub에서 스크립트를 받아 실행하는 장비
- S3 log bucket: 실행 로그와 `summary.json` 저장소

로컬에만 있는 스크립트는 EC2 runner에서 실행할 수 없다. runner에서 실행해야 하는 변경은 반드시 `Salijang/k6_test`에 push한다.

## Terraform 구성

infra repo의 `modules/k6-runner`가 runner EC2를 만든다.

- dev: `k6_runner_enabled = true`
- prod: `k6_runner_enabled = false`

prod는 운영 부하테스트 일정이 잡힌 시점에만 `true`로 변경하고 apply한다. 테스트가 끝나면 다시 `false`로 되돌려 EC2를 제거한다.

## Runner 생성 후 자동 작업

EC2가 부팅되면 user-data가 아래 작업을 수행한다.

1. `git`, `awscli`, `k6` 설치
2. `/opt/sallijang/k6_test`에 `https://github.com/Salijang/k6_test.git` clone
3. `/opt/sallijang/run-k6.sh` 실행 스크립트 생성

`run-k6.sh`는 실행할 때마다 `git pull --ff-only`로 최신 스크립트를 가져온다.

## 실행 전 로컬 작업

스크립트를 수정한 뒤 반드시 커밋하고 push한다.

```bash
git status --short
git add tests/performance/k6/sallijang
git commit -m "update sallijang k6 scenarios"
git push origin main
```

테스트 결과, 보고서 이미지, env 파일은 커밋 대상인지 먼저 확인한다. 실제 token/cookie가 들어간 파일은 커밋하지 않는다.

## Runner 접속

runner는 SSH 인바운드를 열지 않는다. AWS Systems Manager Session Manager로 접속한다.

현재 dev 수동 runner:

- instance id: `i-04a0a7d028c6b9156`
- private ip: `10.0.1.20`
- public ip: `43.203.196.15`
- result bucket prefix: `s3://pickup-dev-logs/k6-results/dev/`
- repository path: `/opt/sallijang/k6_test`

접속 후 기본 확인:

```bash
k6 version
git -C /opt/sallijang/k6_test status --short
ls /opt/sallijang/k6_test/tests/performance/k6/sallijang
```

로컬 AWS CLI에서 wrapper script로 실행한다.
긴 `aws ssm send-command`를 직접 치는 방식은 디버깅용으로만 남겨두고, 일반 사용자는 wrapper를 사용한다.

```bash
tests/performance/run-aws-k6.sh
tests/performance/run-aws-k6.sh interactive
tests/performance/run-aws-k6.sh smoke --wait
tests/performance/run-aws-k6.sh read --rate 5 --duration 1m --run-id read-5rps --wait
tests/performance/run-aws-k6.sh step --targets 5,10,20 --hold 1m --run-id step-5-20
```

아무 인자 없이 실행하거나 `interactive`로 실행하면 가능한 테스트 목록을 보여주고, 선택한 테스트에 필요한 값을 차례로 입력받는다.
익숙한 사용자는 한 줄 명령으로 바로 실행하고, 처음 사용하는 사람은 대화형 모드를 사용한다.

대화형 모드에서 `테스트가 끝날 때까지 기다릴까요? y/n [y]:`가 나오면:

- Enter 또는 `y`: 테스트가 끝날 때까지 기다리고 요약 결과를 터미널에 출력한다.
- `n`: AWS runner에 실행만 요청하고 바로 종료한다. 결과는 S3에서 확인한다.

지원 시나리오:

- `smoke`: 기본 연결 확인
- `read`: 상품 목록 조회 고정 RPS
- `step`: 상품 목록 조회 단계 상승
- `spike`: 순간 트래픽 급증
- `order`: 주문 생성
- `create`: 상품 생성/삭제
- `remaining`: 재고 변경
- `soak`: 구매자 여정 장시간 테스트

설정값은 옵션이나 환경변수로 바꿀 수 있다.

```bash
tests/performance/run-aws-k6.sh read \
  --rate 20 \
  --duration 2m \
  --run-id read-20rps

K6_RUNNER_INSTANCE_ID=i-04a0a7d028c6b9156 \
K6_BASE_URL=https://api.sallijang.shop \
tests/performance/run-aws-k6.sh spike \
  --base-rate 5 \
  --spike-rate 50
```

토큰이나 아직 wrapper에 별도 옵션이 없는 k6 변수는 `--env KEY=VALUE`로 넘긴다.

```bash
tests/performance/run-aws-k6.sh order \
  --store-id 1 \
  --rate 2 \
  --duration 1m \
  --buyer-token "$K6_BUYER_ACCESS_TOKEN" \
  --env K6_PRODUCT_POOL_SIZE=10
```

`--wait`를 사용하면 AWS CLI 원본 JSON 대신 사람이 읽기 쉬운 요약 결과를 출력한다.

```text
========== k6 테스트 결과 ==========
상태:          Success
응답 코드:     0
Run ID:        smoke-20260507-124455
SSM command:   <command-id>
S3 결과 위치:  s3://pickup-dev-logs/k6-results/dev/smoke-20260507-124455/

Threshold:
  ✓ 'rate==1' rate=100.00%
  ✓ 'p(95)<1000' p(95)=56.59ms
  ✓ 'rate==0' rate=0.00%

주요 지표:
  checks_succeeded: 100.00% 2 out of 2
  http_req_duration: avg=56.59ms min=56.59ms med=56.59ms max=56.59ms p(90)=56.59ms p(95)=56.59ms
  http_req_failed:   0.00%  0 out of 1
  http_reqs:         1      13.195691/s
  iterations:        1      13.195691/s

업로드된 파일:
  s3://pickup-dev-logs/k6-results/dev/smoke-20260507-124455/summary.json
  s3://pickup-dev-logs/k6-results/dev/smoke-20260507-124455/run.log
```

아래처럼 긴 SSM 명령을 직접 실행할 수도 있지만, 일반 사용자는 wrapper script를 우선 사용한다.

```bash
aws ssm send-command \
  --profile salijang \
  --region ap-northeast-2 \
  --instance-ids i-04a0a7d028c6b9156 \
  --document-name AWS-RunShellScript \
  --parameters commands='["sudo K6_BASE_URL=https://api.sallijang.shop RUN_ID=aws-runner-smoke /opt/sallijang/run-k6.sh"]'
```

## Runner 내부 직접 실행

SSM session으로 runner에 직접 접속한 경우에만 아래 명령을 사용한다.
일반 테스트 실행은 앞의 wrapper script를 우선 사용한다.

기본 smoke:

```bash
sudo K6_BASE_URL=https://api.sallijang.shop /opt/sallijang/run-k6.sh
```

특정 시나리오 실행:

```bash
sudo K6_BASE_URL=https://api.sallijang.shop \
  SCENARIO=tests/performance/k6/sallijang/product-list-load.js \
  /opt/sallijang/run-k6.sh
```

주문 생성 한계 테스트 예시:

```bash
sudo K6_BASE_URL=https://api.sallijang.shop \
  SCENARIO=tests/performance/k6/sallijang/order-create-load.js \
  K6_STORE_ID=1 \
  K6_ORDER_RATE=20 \
  K6_ORDER_DURATION=2m \
  /opt/sallijang/run-k6.sh
```

EC2 runner는 EKS Pod가 아니므로 Kubernetes Service DNS인 `product-service`, `order-service`를 직접 해석할 수 없다.
현재 runner에서는 `K6_BASE_URL=https://api.sallijang.shop`을 명시해서 public ALB 경로로 테스트한다.

짧은 read 부하 테스트 예시:

```bash
aws ssm send-command \
  --profile salijang \
  --region ap-northeast-2 \
  --instance-ids i-04a0a7d028c6b9156 \
  --document-name AWS-RunShellScript \
  --parameters commands='["sudo K6_BASE_URL=https://api.sallijang.shop SCENARIO=tests/performance/k6/sallijang/product-list-load.js K6_READ_RATE=5 K6_READ_DURATION=1m RUN_ID=aws-runner-read-5rps /opt/sallijang/run-k6.sh"]'
```

## 결과 확인

runner 내부 결과:

```bash
ls /opt/sallijang/results
```

각 실행은 `RUN_ID` 기준 디렉토리를 만들고 아래 파일을 남긴다.

- `summary.json`
- `run.log`

S3 업로드 위치:

- dev: `s3://<log-bucket>/k6-results/dev/<RUN_ID>/`
- prod: `s3://<log-bucket>/k6-results/prod/<RUN_ID>/`
- current dev runner: `s3://pickup-dev-logs/k6-results/dev/<RUN_ID>/`

AWS CLI 확인 예시:

```bash
aws s3 ls s3://<log-bucket>/k6-results/dev/
```

현재 dev runner 결과 확인:

```bash
aws s3 ls s3://pickup-dev-logs/k6-results/dev/ --profile salijang --region ap-northeast-2
```

검증된 실행 결과:

- `aws-runner-public-smoke-20260507-031049`: p95 `94.24ms`, failed `0`
- `aws-runner-read-5rps-20260507-031322`: p95 `28.01ms`, failed `0`
- `wrapper-read-1rps-20260507`: p95 `92.69ms`, failed `0`
- `pretty-smoke-20260507`: p95 `69.35ms`, failed `0`

## 운영 순서

1. 로컬에서 k6 스크립트 수정
2. `Salijang/k6_test`에 push
3. dev runner apply 및 SSM 접속
4. smoke 실행으로 API, 인증, env, S3 업로드 확인
5. dev에서 낮은 RPS로 시나리오 검증
6. prod 테스트 일정 확정
7. prod `k6_runner_enabled = true`로 apply
8. prod runner에서 한계 테스트 실행
9. 결과를 S3, Grafana, CloudWatch 기준으로 정리
10. prod `k6_runner_enabled = false`로 apply해서 runner 제거

## 주의

- prod runner는 기본 비활성화 상태로 둔다.
- write 계열 테스트는 실제 상품/주문 데이터를 만든다.
- 한계 테스트는 RPS를 단계적으로 올리고, 실패 구간과 인프라 지표를 같이 기록한다.
- runner는 테스트 실행 장비일 뿐이다. 스크립트 원본은 GitHub `Salijang/k6_test`다.
