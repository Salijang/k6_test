# AWS k6 Runner Evolution

이 문서는 AWS 내부 k6 runner를 어떤 순서로 고도화했는지 남기는 기록이다.
현재 사용 절차는 [EC2_K6_RUNNER_RUNBOOK.md](EC2_K6_RUNNER_RUNBOOK.md)를 따른다.

## 1. 로컬 실행에서 AWS Runner 필요성 확인

2차 AWS 테스트는 처음에 로컬에서 `https://api.sallijang.shop`를 대상으로 실행했다.
이 방식은 빠르게 검증하기 좋지만, 테스트 트래픽이 로컬 네트워크와 PC 상태의 영향을 받는다.

확인된 한계:

- 로컬 runner의 네트워크/시간 오차가 결과에 섞일 수 있음
- 팀원마다 실행 환경이 달라 결과 재현성이 낮음
- AWS 내부 인프라 부하 테스트라는 기준과 실행 위치가 다름

그래서 테스트 실행 위치를 AWS 안의 전용 EC2 runner로 옮기는 방향으로 정했다.

## 2. Terraform 기반 Runner 설계

infra repo에 `modules/k6-runner`를 추가하는 PR을 정리했다.

- PR: `Salijang/sallijang-infra#16`
- dev는 `k6_runner_enabled = true`
- prod는 `k6_runner_enabled = false`
- SSH inbound 없이 AWS Systems Manager Session Manager 사용
- runner는 `Salijang/k6_test`의 `main` 브랜치를 pull해서 실행
- 결과는 기존 log bucket의 `k6-results/<env>/<RUN_ID>/`로 업로드

중요한 설계 기준:

- 테스트 스크립트 원본은 EC2 안이 아니라 GitHub repo
- runner는 실행 장비일 뿐이며, 매 실행마다 최신 main을 pull
- prod runner는 테스트 기간에만 켜고 평소에는 비활성화

## 3. 수동 Dev Runner로 먼저 검증

Terraform PR은 최신 main 기준으로 정리하되, 실제 실행 가능성은 수동 dev runner로 먼저 검증했다.

현재 수동 dev runner:

- instance id: `i-04a0a7d028c6b9156`
- private ip: `10.0.1.20`
- public ip: `43.203.196.15`
- result prefix: `s3://pickup-dev-logs/k6-results/dev/`
- repo path: `/opt/sallijang/k6_test`
- run script: `/opt/sallijang/run-k6.sh`

초기 user-data에서 k6 설치 URL이 오래되어 실패했고, 실제 runner에서 `https://dl.k6.io/rpm/repo.rpm` 설치 방식으로 보정했다.

## 4. Public API Base URL 고정

EC2 runner는 EKS Pod가 아니므로 Kubernetes Service DNS인 `product-service`, `order-service`를 해석할 수 없었다.

따라서 runner 실행 기준은 아래처럼 public ALB/Ingress 주소를 쓰도록 정했다.

```bash
K6_BASE_URL=https://api.sallijang.shop
```

Terraform runner에도 `k6_base_url` 변수를 추가해서 기본 실행 시 smoke가 바로 성공하도록 맞췄다.

## 5. SSM 긴 명령에서 Wrapper Script로 개선

처음에는 사용자가 아래처럼 긴 `aws ssm send-command`를 직접 실행해야 했다.

```bash
aws ssm send-command \
  --profile salijang \
  --region ap-northeast-2 \
  --instance-ids i-04a0a7d028c6b9156 \
  --document-name AWS-RunShellScript \
  --parameters commands='["sudo K6_BASE_URL=https://api.sallijang.shop SCENARIO=... RUN_ID=... /opt/sallijang/run-k6.sh"]'
```

이 방식은 동작은 하지만 팀원이 쓰기 어렵고, 줄바꿈이나 quoting 실수 가능성이 높다.
그래서 `tests/performance/run-aws-k6.sh` wrapper를 추가했다.

한 줄 실행 예:

```bash
tests/performance/run-aws-k6.sh read --rate 5 --duration 1m --run-id read-5rps --wait
```

Wrapper가 대신 처리하는 것:

- scenario alias를 실제 k6 파일 경로로 변환
- SSM command JSON 생성
- `RUN_ID`, `K6_TESTID`, `K6_BASE_URL` 설정
- rate, duration, token, store id 같은 가변값 전달
- S3 결과 위치 출력

## 6. 대화형 실행 모드 추가

잘 모르는 사용자도 쓸 수 있도록 인자 없이 실행하면 대화형 모드가 뜨게 했다.

```bash
tests/performance/run-aws-k6.sh
```

대화형 모드 흐름:

1. 가능한 테스트 목록 출력
2. 테스트 번호 선택
3. 선택한 테스트에 필요한 값만 질문
4. write 계열 테스트는 실제 데이터 변경 경고
5. 실행 전 최종 확인
6. AWS runner에 테스트 실행 요청

예를 들어 read 테스트는 RPS와 실행 시간만 묻고, order/create/remaining 테스트는 store id와 token 관련 값을 추가로 묻는다.

## 7. 한국어 UX 정리

처음 대화형 문구에는 영어가 섞여 있었다.
팀원이 쉽게 이해하도록 주요 문구를 한국어로 바꿨다.

예:

- `Available scenarios` -> `실행 가능한 테스트`
- `Select scenario` -> `테스트를 선택하세요`
- `Wait for completion?` -> `테스트가 끝날 때까지 기다릴까요?`
- `Execute now?` -> `지금 실행할까요?`

## 8. 결과 출력 정리

`--wait` 옵션을 쓰면 AWS CLI가 원래는 `get-command-invocation` JSON 전체를 그대로 출력했다.
이 출력은 k6 로그, SSM 상태, S3 업로드 로그가 한 JSON 문자열에 섞여 사람이 읽기 어렵다.

그래서 wrapper에서 결과를 아래 항목으로 요약 출력하도록 바꿨다.

- 상태
- 응답 코드
- Run ID
- SSM command id
- S3 결과 위치
- threshold 통과/실패
- 주요 지표
  - `checks_succeeded`
  - `http_req_duration`
  - `http_req_failed`
  - `http_reqs`
  - `iterations`
- 업로드된 S3 파일
- 참고 로그

검증된 출력 예:

```text
========== k6 테스트 결과 ==========
상태:          Success
응답 코드:     0
Run ID:        pretty-smoke-20260507
SSM command:   da583138-766d-47f6-a3ad-38010088522c
S3 결과 위치:  s3://pickup-dev-logs/k6-results/dev/pretty-smoke-20260507/

Threshold:
  ✓ 'rate==1' rate=100.00%
  ✓ 'p(95)<1000' p(95)=69.35ms
  ✓ 'rate==0' rate=0.00%

주요 지표:
  checks_succeeded: 100.00% 2 out of 2
  http_req_duration: avg=69.35ms min=69.35ms med=69.35ms max=69.35ms p(90)=69.35ms p(95)=69.35ms
  http_req_failed:   0.00%  0 out of 1
  http_reqs:         1      10.383114/s
  iterations:        1      10.383114/s
```

## 현재 상태

현재 팀원 사용 기준은 `tests/performance/run-aws-k6.sh`다.

- 초보 사용자: `tests/performance/run-aws-k6.sh`
- 숙련 사용자: `tests/performance/run-aws-k6.sh read --rate 5 --duration 1m --wait`
- 원본 SSM 명령 직접 실행은 디버깅용으로만 사용

수동 dev runner는 바로 사용할 수 있다.
장기적으로는 infra PR을 merge한 뒤 manual runner를 Terraform으로 import하거나 Terraform runner로 대체한다.
