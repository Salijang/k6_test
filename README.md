# Sallijang k6 Test Suite

Salijang API 부하테스트 시나리오, AWS k6 runner 실행 도구, 결과 보고서를 관리하는 레포다.

팀 공용 AWS 부하테스트 표준 실행 명령은 repo 루트의 `./k6aws`다.

## 빠른 시작

대화형으로 실행:

```bash
git pull origin main
./k6aws
```

한 줄로 실행:

```bash
./k6aws smoke --wait
./k6aws read --rate 5 --duration 1m --run-id read-5rps --wait
./k6aws step --targets 5,10,20 --hold 1m --run-id step-5-20 --wait
```

`./k6aws`는 로컬에서 실행하지만 k6 자체는 로컬에서 돌지 않는다.
내부적으로 AWS SSM `send-command`를 사용해서 EC2 k6 runner에서 k6를 실행한다.

```text
로컬 터미널
  -> AWS SSM send-command
  -> EC2 k6 runner
  -> /opt/sallijang/run-k6.sh
  -> EC2 안에서 k6 실행
  -> S3에 결과 업로드
```

## 현재 Runner

- dev runner instance id: `i-04a0a7d028c6b9156`
- 기본 API: `https://api.sallijang.shop`
- S3 결과 위치: `s3://pickup-dev-logs/k6-results/dev/<RUN_ID>/`
- runner 내부 repo: `/opt/sallijang/k6_test`
- runner 내부 실행 스크립트: `/opt/sallijang/run-k6.sh`

`./k6aws`는 실행 전에 EC2가 `running`인지, SSM 상태가 `Online`인지 확인한다.
runner가 꺼져 있으면 테스트를 실행하지 않고 원인을 출력한다.

## 실행 방식 차이

| 명령 | 실제 k6 실행 위치 | 용도 |
| --- | --- | --- |
| `./k6aws ...` | EC2 k6 runner | 팀 공용 AWS 부하테스트 표준 |
| `tests/performance/run-aws-k6.sh ...` | EC2 k6 runner | `./k6aws`의 원본 긴 경로 |
| `tests/performance/run-sallijang-suite.sh` | 명령을 친 현재 환경 | 로컬/현재 shell에서 여러 시나리오 순차 실행 |
| `k6 run ...` | 로컬 PC | 스크립트 빠른 개발/문법 확인 |
| `aws ssm start-session ...` | EC2 접속 세션 | EC2 안에 직접 들어가서 디버깅 |

`aws ssm start-session`은 Session Manager Plugin이 필요하다.
`./k6aws`는 `send-command`를 쓰므로 Session Manager Plugin이 없어도 테스트 실행이 가능하다.

## 테스트 종류

`./k6aws`에서 선택 가능한 시나리오:

- `smoke`: 기본 연결 확인
- `read`: 상품 목록 조회 고정 RPS
- `step`: 상품 목록 조회 단계 상승
- `spike`: 순간 트래픽 급증
- `order`: 주문 생성 부하
- `create`: 상품 생성/삭제 부하
- `remaining`: 상품 재고 변경 부하
- `soak`: 구매자 여정 장시간 테스트

예시:

```bash
./k6aws read --rate 20 --duration 2m --run-id read-20rps --wait
./k6aws spike --base-rate 5 --spike-rate 50 --run-id spike-50rps --wait
./k6aws order --store-id 1 --rate 2 --duration 1m --buyer-token "$K6_BUYER_ACCESS_TOKEN" --wait
```

write 계열 테스트인 `order`, `create`, `remaining`, `soak`는 실제 상품/주문/재고 데이터를 변경할 수 있다.
실행 전 대상 환경, store id, token, RPS를 확인한다.

## 결과 확인

`--wait`를 붙이면 터미널에 사람이 읽기 쉬운 요약 결과가 출력된다.

```text
========== k6 테스트 결과 ==========
상태:          Success
응답 코드:     0
Run ID:        smoke-20260507-124455
S3 결과 위치:  s3://pickup-dev-logs/k6-results/dev/smoke-20260507-124455/

Threshold:
  ✓ 'rate==1' rate=100.00%
  ✓ 'p(95)<1000' p(95)=56.59ms
  ✓ 'rate==0' rate=0.00%

주요 지표:
  checks_succeeded: 100.00% 2 out of 2
  http_req_duration: avg=56.59ms ... p(95)=56.59ms
  http_req_failed:   0.00%  0 out of 1
```

S3에서 직접 확인:

```bash
aws s3 ls s3://pickup-dev-logs/k6-results/dev/ \
  --profile salijang \
  --region ap-northeast-2
```

## 구성

- `k6aws`: 짧은 AWS k6 runner 실행 명령
- `tests/performance/run-aws-k6.sh`: `k6aws`가 호출하는 원본 wrapper
- `tests/performance/run-sallijang-suite.sh`: 현재 환경에서 여러 시나리오를 순차 실행하는 suite
- `tests/performance/k6/sallijang/`: Salijang 전용 k6 시나리오
- `tests/performance/shared/env/sallijang.example.env`: 실행 환경 변수 예시
- `tests/performance/prepare-sallijang-test-env.sh`: 테스트 seller/buyer/store 준비 스크립트
- `tests/performance/results/final-reports/`: 최종 보고서 패키지

## 문서

- 최신 AWS runner 런북: [EC2_K6_RUNNER_RUNBOOK.md](tests/performance/k6/sallijang/EC2_K6_RUNNER_RUNBOOK.md)
- AWS runner 고도화 기록: [AWS_K6_RUNNER_EVOLUTION.md](tests/performance/k6/sallijang/AWS_K6_RUNNER_EVOLUTION.md)
- Salijang 시나리오 가이드: [tests/performance/k6/sallijang/README.md](tests/performance/k6/sallijang/README.md)
- API 매핑: [API_MAPPING.md](tests/performance/k6/sallijang/API_MAPPING.md)
- 사용자 역할별 API 호출: [USER_ROLE_API_CALLS.md](tests/performance/k6/sallijang/USER_ROLE_API_CALLS.md)
- dev 테스트 계획: [DEV_TEST_PLAN.md](tests/performance/k6/sallijang/DEV_TEST_PLAN.md)
- 라우팅 런북: [DEV_API_ROUTING_RUNBOOK.md](tests/performance/k6/sallijang/DEV_API_ROUTING_RUNBOOK.md)
- 로컬 테스트 최종 보고서: [local-20260423/final-report.md](tests/performance/results/final-reports/local-20260423/final-report.md)
- 1차 AWS 테스트 최종 보고서: [aws-20260505/README.md](tests/performance/results/final-reports/aws-20260505/README.md)
- 2차 AWS 테스트 계획서: [aws-2nd-test-plan.md](tests/performance/results/final-reports/aws-2nd-test-plan.md)
- 2차 AWS 테스트 결과 보고서: [aws-2nd-test-report.md](tests/performance/results/final-reports/aws-2nd-test-report.md)

## 주의

- 실제 token/cookie/env 파일은 커밋하지 않는다.
- EC2 runner에서 실행할 스크립트 변경은 반드시 `main`에 push한다.
- `tests/performance/results/`는 기본적으로 ignore 대상이며, 최종 제출 패키지만 명시적으로 추적한다.
- 2026-05-06 확인 기준 `api.sallijang.shop` TLS는 wildcard 인증서로 정상 검증된다.
