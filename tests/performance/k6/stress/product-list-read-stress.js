// Salijang product-service 의 buyer 상품 목록 조회 한계 측정용 stress 스크립트.
// 의도된 부하: ramping-arrival-rate 기반 RPS 강제 유지로 cliff 시점 식별.
// 회귀가 아니라 한계 탐색이므로 threshold 는 두지 않는다.
// 자세한 설계 근거는 docs/sallijang-load-plan/01-stress-scenarios.md §4.2 참고.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

// ---------- 기본 설정 ----------

// 클러스터 외부에서 실행 시 ingress / port-forward URL 로 덮어쓴다.
// 클러스터 내부 k6 pod 에서 실행 시 default(`http://product-service`) 가 적용된다.
const BASE_URL = __ENV.K6_BASE_URL || "http://product-service";

const LIMIT = Number(__ENV.K6_PRODUCT_LIMIT ?? "20");
const MAX_OFFSET = Number(__ENV.K6_PRODUCT_MAX_OFFSET ?? "60");

// 50% 확률로 카테고리 필터를 붙인다. 실제 buyer 트래픽이 카테고리 필터와 미지정을 모두 사용한다는 가정.
const CATEGORY_FILTER_RATIO = Number(__ENV.K6_CATEGORY_FILTER_RATIO ?? "0.5");
const CATEGORIES = (__ENV.K6_PRODUCT_CATEGORIES ?? "베이커리,과일,채소,반찬,한식,분식")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// 서울 중심 좌표를 기준으로 정사각 분산. PG plan cache hit 회피보다는 Haversine 정렬 자체를 매번 실행시키는 데 의의가 있다.
const GEO_CENTER_LAT = Number(__ENV.K6_GEO_CENTER_LAT ?? "37.5665");
const GEO_CENTER_LNG = Number(__ENV.K6_GEO_CENTER_LNG ?? "126.9780");
const GEO_RADIUS = Number(__ENV.K6_GEO_RADIUS ?? "0.1");

const RUN_PREFIX = __ENV.K6_RUN_PREFIX ?? `${Date.now()}`;
const TESTID = __ENV.K6_TESTID ?? `read-stress-${RUN_PREFIX}`;

// ---------- 부하 단계 ----------

// 본문 default 는 docs/sallijang-load-plan/01-stress-scenarios.md §4.2 의 prod 잠정값.
// dev 환경에서는 자원이 작아 그대로 쓰면 안 된다. dev default 는
// docs/sallijang-load-plan/captured/api-mapping-verification-dev_yji-2026-04-30.md §4.1 참고.
// 단계를 통째로 덮어쓰려면 K6_STAGES_JSON 환경변수에 JSON 배열 전달.
function buildStages() {
  const json = __ENV.K6_STAGES_JSON;
  if (json) {
    return JSON.parse(json);
  }
  return [
    { duration: "1m", target: 100 },
    { duration: "3m", target: 100 },
    { duration: "1m", target: 300 },
    { duration: "3m", target: 300 },
    { duration: "1m", target: 600 },
    { duration: "3m", target: 600 },
    { duration: "1m", target: 1000 },
    { duration: "3m", target: 1000 },
    { duration: "1m", target: 1500 },
    { duration: "3m", target: 1500 },
    { duration: "1m", target: 0 },
  ];
}

// preAllocatedVUs / maxVUs 산정식: maxVUs ≈ 목표 RPS × 가정한 최악 응답시간(s) × 안전계수(2~3).
// 1500 RPS × 1s × 2 = 3000 을 기본값으로 둔다. 부족하면 K6_MAX_VUS 로 올린다.
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "100");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "3000");

// ---------- 메트릭 ----------

const status2xx = new Counter("read_stress_status_2xx");
const status4xx = new Counter("read_stress_status_4xx");
const status5xx = new Counter("read_stress_status_5xx");

// ---------- k6 options ----------

// 한계 측정 시나리오: threshold 두지 않는다. abort 가 cliff 측정을 가린다.
// 관측은 docs/sallijang-load-plan/05-observability.md 의 패널과 카운터로 한다.
export const options = {
  scenarios: {
    product_list_read_stress: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: buildStages(),
    },
  },
  tags: { testid: TESTID, scenario: "product-list-read-stress" },
};

// ---------- 헬퍼 ----------

function pickCategory() {
  if (CATEGORIES.length === 0) {
    return null;
  }
  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

function pickGeo() {
  const dLat = (Math.random() * 2 - 1) * GEO_RADIUS;
  const dLng = (Math.random() * 2 - 1) * GEO_RADIUS;
  return {
    lat: GEO_CENTER_LAT + dLat,
    lng: GEO_CENTER_LNG + dLng,
  };
}

function pickOffset() {
  const stepCount = Math.floor(MAX_OFFSET / LIMIT) + 1;
  return Math.floor(Math.random() * stepCount) * LIMIT;
}

function buildQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

// ---------- 실행 ----------

export function setup() {
  const stages = buildStages();
  const peakRps = stages.reduce((max, stage) => Math.max(max, stage.target ?? 0), 0);
  console.log(
    `product-list-read-stress baseUrl=${BASE_URL} testid=${TESTID} ` +
      `peakRps=${peakRps} preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} ` +
      `categories=[${CATEGORIES.join(",")}] geo=${GEO_CENTER_LAT},${GEO_CENTER_LNG}±${GEO_RADIUS}`,
  );
}

export default function () {
  // FastAPI 라우터가 prefix `/api/v1/products` + endpoint `/` 라 끝 슬래시가 붙어야 307 redirect 를 피한다.
  const { lat, lng } = pickGeo();
  const params = {
    user_lat: lat.toFixed(6),
    user_lng: lng.toFixed(6),
    limit: LIMIT,
    offset: pickOffset(),
  };
  if (Math.random() < CATEGORY_FILTER_RATIO) {
    const category = pickCategory();
    if (category) {
      params.category = category;
    }
  }

  const url = `${BASE_URL}/api/v1/products/?${buildQuery(params)}`;
  const response = http.get(url);

  if (response.status >= 200 && response.status < 300) {
    status2xx.add(1);
  } else if (response.status >= 400 && response.status < 500) {
    status4xx.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  }

  // check 는 두되 threshold 와 연결하지 않는다. 한계 측정 중 abort 가 일어나면 cliff 가 가려진다.
  check(response, {
    "no 5xx": (res) => res.status < 500,
    "200 body is array": (res) => res.status !== 200 || Array.isArray(res.json()),
  });
}
