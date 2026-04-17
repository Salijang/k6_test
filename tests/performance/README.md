# Performance Tests

이 디렉토리는 성능 테스트 자산을 관리하기 위한 공간이다.

## 구조

- `shared/`
  - `scenarios.md`: 공통 성능 테스트 시나리오 정의
  - `env/`: 환경별 설정값
  - `data/`: 테스트 데이터 파일
- `k6/`
  - k6 전용 스크립트
- `ngrinder/`
  - nGrinder 전용 스크립트

## 목적

- 공통 시나리오를 기준으로 성능 테스트를 수행한다.
- k6와 nGrinder를 동일한 시나리오 기준으로 비교한다.
- 테스트 조건, 데이터, 실행 방법을 문서화한다.

## 기본 원칙

1. 공통 시나리오는 `shared/scenarios.md`를 기준으로 한다.
2. 도구별 실행 스크립트는 `k6/`, `ngrinder/`에 따로 둔다.
3. 테스트 환경값은 코드에 하드코딩하지 않고 `shared/env/`에서 관리한다.
4. 테스트 데이터는 재현 가능해야 한다.
5. 성능 테스트 결과는 실행 일시, 환경, 조건과 함께 기록한다.

## 실행 전 체크

- 테스트 대상 환경이 준비되었는지 확인
- 테스트 계정/토큰 준비 여부 확인
- 테스트 데이터 초기화 여부 확인
- 외부 연동(mock/sandbox) 여부 확인
- 부하테스트 중 로그/메트릭 수집 가능한지 확인

## 추후 추가 예정

- k6 실행 방법
- nGrinder 실행 방법
- 환경별 변수 파일 예시
- 결과 기록 양식

## k6 실행 예시

사전 조건

- `docker compose -f docker-compose.stack.yml up --build -d` 로 전체 스택을 띄운 경우 API는 `http://localhost:14000` 에서 응답한다.
- `npm run dev:api` 로 API만 띄운 경우 기본 포트는 `http://localhost:4000` 이다. 이 경우 `K6_BASE_URL` 을 명시해서 실행한다.
- PostgreSQL 연결로 실행하면 예약/재고 경합 시나리오가 더 현실적임

공통 환경 파일은 [shared/env/local.example.json](/home/system/workspace/k6testDemo/tests/performance/shared/env/local.example.json) 를 참고한다.

```bash
k6 run tests/performance/k6/product-registration-burst.js
k6 run tests/performance/k6/product-list-read.js
k6 run tests/performance/k6/hot-slot-race.js
k6 run tests/performance/k6/cancel-and-rereserve.js
```

로컬 dev API(`http://localhost:4000`)를 대상으로 돌릴 때는 아래처럼 환경변수를 덮어쓴다.

```bash
K6_BASE_URL=http://localhost:4000 K6_STORE_ID=store-seoul-central K6_SELLER_ID=seller-seoul-central K6_CUSTOMER_ID=customer-minji k6 run tests/performance/k6/hot-slot-race.js
```

## Prometheus / Grafana로 메트릭 보기

모니터링 스택만 먼저 띄운다.

```bash
npm run monitoring:start
```

접속 주소:

- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`

Grafana 기본 계정:

- ID: `admin`
- PW: `admin`

k6를 Prometheus remote write 출력으로 실행한다.

```bash
npm run k6:run:prometheus -- tests/performance/k6/product-list-read.js
```

API를 `npm run dev:api` 로 띄운 상태라면 `K6_BASE_URL` 만 덮어쓰면 된다.

```bash
K6_BASE_URL=http://localhost:4000 npm run k6:run:prometheus -- tests/performance/k6/hot-slot-race.js
```

각 테스트 런에는 기본으로 `testid=<timestamp>` 태그가 붙는다. 필요하면 `K6_TESTID` 로 직접 지정할 수 있다.

```bash
K6_TESTID=burst-20260417 npm run k6:run:prometheus -- tests/performance/k6/product-registration-burst.js
```

참고: 각 k6 스크립트가 `options.scenarios` 를 직접 정의하고 있으면 `--vus`, `--duration` 같은 CLI 플래그보다 스크립트 설정이 우선한다. 부하 조건을 바꾸려면 해당 스크립트의 옵션을 수정하거나 별도 시나리오 파일을 쓰는 편이 안전하다.

Grafana에 들어가면 `k6 / k6 Load Test Overview` 대시보드가 자동으로 올라온다.

전체 앱 스택과 모니터링을 한 번에 올리려면 아래처럼 compose 파일을 같이 사용한다.

```bash
docker compose -f docker-compose.stack.yml -f docker-compose.monitoring.yml up --build -d
```

종료:

```bash
npm run monitoring:stop
```
