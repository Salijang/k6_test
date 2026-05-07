# 상품 목록 조회 Capacity 보완 보고서

## 개요

- 작성일: 2026-04-23
- Run ID: 20260423-final-report
- Test ID: 20260423-final-report-product-list-capacity
- 대상 스크립트: tests/performance/k6/product-list-capacity.js
- Base URL: http://localhost:14000

## 핵심 결론

- 10~200 VUs 전 구간에서 200 OK만 관찰됐다.
- 5xx와 check 실패는 발생하지 않았다.
- 현재 constrained baseline 기준으로 상품 목록 조회 API는 최소 200 VUs 이상 수용 가능한 것으로 해석할 수 있다.

## 실행 조건

- 단계: 10, 25, 50, 100, 150, 200 VUs
- 램프업: 각 단계 20초
- 유지: 각 단계 1분
- 쿨다운: 20초

## 결과 요약

항목	결과
총 HTTP 요청	85120
Check Pass Rate	100%
2xx 응답 수	85120
5xx 응답 수	0
평균 응답시간	2.5ms
p90 응답시간	3.9ms
p95 응답시간	4.82ms
최대 응답시간	715.43ms
처리량	159.33 req/s
최대 관찰 동접	200 VUs

## 판단

구간	판단
10~50 VUs	안정
100 VUs	안정
150 VUs	안정
200 VUs	안정
성능 저하 시작 구간	미관찰
명확한 한계 구간	미관찰

## 최종 판단

이번 보완 실행에서는 테스트 범위 안에서 병목 구간이 드러나지 않았다. 따라서 다음 단계는 250, 300, 400 VUs까지 확장해 실제 한계 구간을 직접 찾는 것이다.
