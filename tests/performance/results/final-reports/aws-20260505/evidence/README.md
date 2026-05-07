# Evidence Index

이 폴더는 최종 보고서 수치를 검증하기 위한 상세 요약 자료 모음이다.

## 포함 자료

- `20260505-public-api-write-scenarios-report.md`: 쓰기 API 상세 결과와 해석
- `20260505-sequential-test-report.md`: 테스트 진행 순서별 상세 기록

## 해석 주의

- 보고서의 RPS는 k6 target iteration/s 기준이다.
- 상품 생성/삭제는 한 iteration에서 create와 delete를 모두 호출하므로 HTTP request/s는 target RPS의 약 2배다.
- DB/RDS/connection pool은 확인 대상이지만, 현재 증거만으로 단독 원인으로 확정하지 않는다.
