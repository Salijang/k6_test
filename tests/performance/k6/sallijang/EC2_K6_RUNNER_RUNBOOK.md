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

접속 후 기본 확인:

```bash
k6 version
git -C /opt/sallijang/k6_test status --short
ls /opt/sallijang/k6_test/tests/performance/k6/sallijang
```

## 기본 실행

기본 smoke:

```bash
sudo /opt/sallijang/run-k6.sh
```

특정 시나리오 실행:

```bash
SCENARIO=tests/performance/k6/sallijang/product-list-load.js sudo -E /opt/sallijang/run-k6.sh
```

주문 생성 한계 테스트 예시:

```bash
SCENARIO=tests/performance/k6/sallijang/order-create-load.js \
K6_STORE_ID=1 \
K6_ORDER_RATE=20 \
K6_ORDER_DURATION=2m \
sudo -E /opt/sallijang/run-k6.sh
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

AWS CLI 확인 예시:

```bash
aws s3 ls s3://<log-bucket>/k6-results/dev/
```

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
