# Sallijang k6 Test Suite

Salijang public API를 대상으로 k6 부하 테스트 시나리오, 실행 스크립트, 최종 보고서를 관리하는 레포다.

## 구성

- `tests/performance/k6/sallijang/`: Salijang 전용 k6 시나리오
- `tests/performance/shared/env/sallijang.example.env`: 실행 환경 변수 예시
- `tests/performance/prepare-sallijang-test-env.sh`: 테스트 seller/buyer/store 준비 스크립트
- `tests/performance/run-sallijang-suite.sh`: smoke/read 중심 suite 실행 스크립트
- `tests/performance/results/final-reports/local-20260423/`: 2026-04-23 로컬 테스트 최종 보고서
- `tests/performance/results/final-reports/aws-20260505/`: 2026-05-05 1차 AWS/public API 최종 보고서 패키지
- `tests/performance/results/final-reports/aws-2nd-test-plan.md`: 2차 AWS 부하 테스트 계획서
- `tests/performance/results/final-reports/aws-2nd-test-report.md`: 2026-05-07 2차 AWS 테스트 결과 보고서

## 빠른 시작

```bash
git pull origin main
cp tests/performance/shared/env/sallijang.example.env .env.sallijang
```

필요한 값을 확인한 뒤 환경 변수를 불러온다.

```bash
source .env.sallijang
```

읽기 smoke부터 실행한다.

```bash
k6 run tests/performance/k6/sallijang/smoke.js
```

테스트 계정과 store를 새로 만들 수 있는 환경이면 준비 스크립트를 사용할 수 있다.

```bash
K6_BASE_URL=https://api.sallijang.shop \
bash tests/performance/prepare-sallijang-test-env.sh
```

출력된 env 파일을 source 한 뒤 suite를 실행한다.

```bash
source tests/performance/results/prepare-YYYYMMDDHHMMSS/sallijang-k6.env
K6_USE_PROMETHEUS=0 bash tests/performance/run-sallijang-suite.sh
```

## 주요 시나리오

```bash
k6 run tests/performance/k6/sallijang/product-list-load.js
k6 run tests/performance/k6/sallijang/order-create-load.js
k6 run tests/performance/k6/sallijang/product-create-load.js
k6 run tests/performance/k6/sallijang/product-remaining-load.js
```

write 계열 테스트는 실제 상품/주문 데이터를 생성한다. 실행 전 대상 환경이 dev인지 prod인지, RPS가 적절한지 반드시 확인한다.

## EC2 k6 Runner

AWS에서 실행하는 k6 runner는 로컬 파일을 직접 복사해서 쓰지 않는다. 로컬에서 스크립트를 수정한 뒤 `Salijang/k6_test` 레포에 push하면, EC2 runner가 실행 시점에 GitHub에서 최신 스크립트를 pull해서 실행한다.

운영 흐름은 아래 기준이다.

1. 로컬에서 k6 스크립트 수정
2. `Salijang/k6_test`에 커밋/push
3. Terraform으로 dev 또는 prod runner 생성
4. SSM Session Manager로 runner 접속
5. `/opt/sallijang/run-k6.sh`로 시나리오 실행
6. 결과를 runner 내부와 S3에서 확인

상세 절차는 [EC2 k6 Runner Runbook](tests/performance/k6/sallijang/EC2_K6_RUNNER_RUNBOOK.md)에 정리한다.

## 문서

- Salijang 실행 가이드: [tests/performance/k6/sallijang/README.md](tests/performance/k6/sallijang/README.md)
- EC2 k6 runner 런북: [tests/performance/k6/sallijang/EC2_K6_RUNNER_RUNBOOK.md](tests/performance/k6/sallijang/EC2_K6_RUNNER_RUNBOOK.md)
- API 매핑: [tests/performance/k6/sallijang/API_MAPPING.md](tests/performance/k6/sallijang/API_MAPPING.md)
- 사용자 역할별 API 호출: [tests/performance/k6/sallijang/USER_ROLE_API_CALLS.md](tests/performance/k6/sallijang/USER_ROLE_API_CALLS.md)
- dev 테스트 계획: [tests/performance/k6/sallijang/DEV_TEST_PLAN.md](tests/performance/k6/sallijang/DEV_TEST_PLAN.md)
- 라우팅 런북: [tests/performance/k6/sallijang/DEV_API_ROUTING_RUNBOOK.md](tests/performance/k6/sallijang/DEV_API_ROUTING_RUNBOOK.md)
- 로컬 테스트 최종 보고서: [tests/performance/results/final-reports/local-20260423/final-report.md](tests/performance/results/final-reports/local-20260423/final-report.md)
- 1차 AWS/public API 최종 보고서 패키지: [tests/performance/results/final-reports/aws-20260505/README.md](tests/performance/results/final-reports/aws-20260505/README.md)
- 2차 AWS 부하 테스트 계획서: [tests/performance/results/final-reports/aws-2nd-test-plan.md](tests/performance/results/final-reports/aws-2nd-test-plan.md)
- 2차 AWS 테스트 결과 보고서: [tests/performance/results/final-reports/aws-2nd-test-report.md](tests/performance/results/final-reports/aws-2nd-test-report.md)

## 주의

- 실제 token/cookie/env 파일은 커밋하지 않는다.
- `tests/performance/results/`는 기본적으로 ignore 대상이며, 최종 제출 패키지만 명시적으로 추적한다.
- 2026-05-06 확인 기준 `api.sallijang.shop` TLS는 wildcard 인증서로 정상 검증된다.
