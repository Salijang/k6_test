# k6 성능 테스트 보완 보고서 (2차)

## 1. 문서 개요

- 작성일: `YYYY-MM-DD`
- 작성자: `이름`
- 대상 프로젝트: `k6 Pickup Market Demo`
- 문서 목적:
  1차 성능 테스트 보고서의 한계였던 최대 수용 동접 사용자 수 미측정과 로컬 자원 제한 baseline 미정리 문제를 보완하기 위해 step-load 기반 capacity 테스트를 수행하고 결과를 정리한다.

## 테스트 환경 구성 및 한계

### 환경 구성

- 본 보고서는 자원 제한이 적용된 Docker Compose 스택을 로컬 자원 제한 baseline 환경으로 두고 수행한 capacity 테스트를 정리한다.
- 앱/DB/모니터링은 컨테이너로 실행하고, `docker-compose.capacity.yml` 에서 CPU/메모리 제한을 적용한다.
- 부하 생성기인 `k6`는 컨테이너 내부가 아니라 호스트에서 실행해 앱 자원을 같이 점유하지 않도록 분리한다.
- 테스트 경로는 `로컬 호스트 k6 -> localhost:14000 API -> PostgreSQL/Monitoring 컨테이너` 구조다.

### 한계

- 본 구성은 단일 호스트 기반 로컬 자원 제한 baseline이며, 실제 운영 인프라의 네트워크 토폴로지와 배포 구조를 그대로 반영하지 않는다.
- `k6`가 로컬 호스트 단일 실행기이므로 분산 부하 생성, 다중 source IP, 리전 간 네트워크 지연, 클러스터 내부 east-west 트래픽은 검증 범위에 포함되지 않는다.
- EKS 기반 `k6 operator` 또는 별도 클라우드 load generator를 사용한 실무형 분산 테스트와 달리, 본 결과는 단일 로드 제너레이터 기준의 용량 추정치다.
- 따라서 이 보고서는 `현재 자원 제한 조건에서 성능 저하가 시작되는 구간`과 `상대적인 수용 한계`를 파악하는 데는 유효하지만, 실제 운영 전체 시스템의 절대 capacity 보증 자료로 해석하면 과장될 수 있다.

## 2. 1차 보고서 한계

1. 기존 시나리오는 고정 부하 또는 짧은 burst 중심이라 단계별 수용 한계를 직접 측정하지 못했다.
2. 최대 수용 동접 사용자 수를 수치로 제시하지 못했다.
3. 성능 저하가 시작되는 구간과 실제 장애 구간을 분리해 설명하지 못했다.
4. 로컬 개발 서버 기준 결과라 CPU/메모리 제한이 적용된 baseline 결과로 보기 어려웠다.

## 3. 보완 테스트 설계

### 3.1 대상 시나리오

- 스크립트: `tests/performance/k6/product-list-capacity.js`
- 목적: 상품 목록 조회 API를 기준으로 단계별 동시 사용자 수를 올리면서 응답시간과 오류 증가 시점을 확인한다.
- 선택 이유:
  - 조회 API는 데이터 변형이 없어 반복 실행 재현성이 높다.
  - 자원 제한된 3-tier 로컬 환경에서 가장 안정적으로 capacity baseline을 잡을 수 있다.

### 3.2 부하 방식

- 방식: `Step Load`
- Executor: `ramping-vus`
- 기본 단계:
  - `10 VUs`
  - `25 VUs`
  - `50 VUs`
  - `100 VUs`
  - `150 VUs`
  - `200 VUs`
- 기본 프로필:
  - 각 단계 진입 램프업 `20s`
  - 각 단계 유지 `1m`
  - 종료 쿨다운 `20s`

### 3.3 판단 기준 예시

| 항목 | 기준 |
| --- | --- |
| 상태코드 | `200` 유지 |
| p95 응답시간 | `500ms 이하` |
| `500` 오류 | `0건` |
| 체크 통과율 | `99% 이상` |

## 4. 실행 환경

| 항목 | 값 |
| --- | --- |
| DB | PostgreSQL container |
| API | Fastify API container |
| Web | Nginx container |
| Monitoring | Prometheus, Grafana containers |
| Base URL | `http://localhost:14000` |

### 4.1 자원 제한 설정

| 구성요소 | CPU 제한 | 메모리 제한 |
| --- | --- | --- |
| API | `1.0` | `768MB` |
| PostgreSQL | `1.0` | `1024MB` |
| Web | `0.5` | `256MB` |
| Prometheus | `0.5` | `512MB` |
| Grafana | `0.5` | `384MB` |

## 5. 실행 방법

### 5.1 사전 준비

```bash
bash tests/performance/start-capacity-stack.sh
```

클린 상태로 다시 시작하려면:

```bash
RESET_STACK_DATA=1 bash tests/performance/start-capacity-stack.sh
```

### 5.2 실행 명령

```bash
K6_BASE_URL=http://localhost:14000 bash tests/performance/run-capacity-report.sh
```

또는 직접 실행:

```bash
K6_BASE_URL=http://localhost:14000 npm run k6:run:prometheus -- tests/performance/k6/product-list-capacity.js
```

### 5.3 단계 조정 예시

```bash
K6_BASE_URL=http://localhost:14000 \
K6_CAPACITY_STAGE_TARGETS=10,25,50,100,200,300 \
K6_CAPACITY_HOLD_DURATION=2m \
bash tests/performance/run-capacity-report.sh
```

### 5.4 종료

```bash
bash tests/performance/stop-capacity-stack.sh
```

## 6. 결과 요약

### 6.1 단계별 결과 표

| 단계 | 목표 동접 | 평균 응답시간 | p95 응답시간 | 최대 응답시간 | 체크 통과율 | `500` 발생 여부 | 판단 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `10` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 2 | `25` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 3 | `50` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 4 | `100` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 5 | `150` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |
| 6 | `200` | `기입` | `기입` | `기입` | `기입` | `기입` | `기입` |

### 6.2 종합 지표

| 항목 | 값 |
| --- | --- |
| 총 요청 수 | `기입` |
| 평균 응답시간 | `기입` |
| p95 응답시간 | `기입` |
| 최대 응답시간 | `기입` |
| 체크 통과율 | `기입` |
| `2xx` 건수 | `기입` |
| `4xx` 건수 | `기입` |
| `5xx` 건수 | `기입` |

## 7. 1차 보고서 한계 보완 결과

### 7.1 보완 내용

- 1차 보고서는 고정 부하 검증 중심이었고, 이번 2차 보고서에서는 단계별 동접 증가 시나리오를 추가했다.
- 또한 API와 DB에 CPU/메모리 제한을 적용해 로컬 baseline 조건에서 측정했다.
- 이를 통해 성능 저하 시작 구간과 안정 운영 가능 구간을 구분할 수 있게 되었다.

### 7.2 해석 예시

- `100 VUs`까지는 p95 응답시간과 오류율이 안정적으로 유지되어 수용 가능 구간으로 판단했다.
- `150 VUs`부터 p95 응답시간이 빠르게 증가해 성능 저하 시작 구간으로 판단했다.
- `200 VUs`에서 `500` 오류 또는 체크 실패가 증가했다면 해당 단계는 안정 운영 범위를 초과한 것으로 해석한다.

## 8. 최종 결론

### 8.1 수용 가능 동접 사용자 수

- 안정 운영 가능 동접: `기입`
- 성능 저하 시작 구간: `기입`
- 명확한 한계 구간: `기입`

### 8.2 최종 서술 예시

- 이번 보완 테스트를 통해 기존 1차 보고서의 한계였던 최대 수용 동접 사용자 수 미측정 문제를 보완했다.
- 또한 컨테이너 자원 제한을 적용해 무제한 로컬 개발환경보다 비교 가능한 baseline 값을 확보했다.
- 상품 목록 조회 기준으로 `기입 VUs`까지는 안정적으로 처리 가능했으며, `기입 VUs`부터 응답시간 증가 또는 오류 증가가 관찰되었다.
- 따라서 현재 로컬 3-tier 환경에서의 보수적 수용 가능 동접은 `기입`으로 판단한다.

## 9. 개선 방안

1. 조회 capacity 결과를 기준으로 쓰기 API capacity 시나리오를 별도 추가한다.
2. 예약 경쟁 API에도 step-load capacity를 적용해 읽기/쓰기/경합 한계를 분리 측정한다.
3. DB CPU, 메모리, 커넥션 수를 함께 수집해 병목 지점을 더 명확히 식별한다.
4. 임계 단계 진입 시 서버 로그와 DB 상태를 함께 수집한다.

## 10. 참고 자료

- [tests/performance/k6/product-list-capacity.js](/home/system/workspace/k6testDemo/tests/performance/k6/product-list-capacity.js)
- [tests/performance/run-capacity-report.sh](/home/system/workspace/k6testDemo/tests/performance/run-capacity-report.sh)
- [tests/performance/start-capacity-stack.sh](/home/system/workspace/k6testDemo/tests/performance/start-capacity-stack.sh)
- [docker-compose.capacity.yml](/home/system/workspace/k6testDemo/docker-compose.capacity.yml)
- [tests/performance/report-template.md](/home/system/workspace/k6testDemo/tests/performance/report-template.md)
