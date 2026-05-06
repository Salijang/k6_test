// Salijang product-service 의 재고 차감 API 의 race 한계 측정용 stress 스크립트.
// 의도된 부하: 작은 product_id 풀에 동시 PATCH 가 몰려 row exclusive lock 직렬화 →
//   응답시간 cliff / DB connection pool 고갈이 진짜 한계 신호.
// 자세한 설계 근거는 docs/sallijang-load-plan/01-stress-scenarios.md §4.3,
// docs/sallijang-load-plan/04-salijang-api-mapping.md §3.3 참고.
//
// 실행 주의:
// - 본문 단계 default 는 prod 잠정값이다. dev 환경(cpu limit 500m, replica 1)에서는 과도하다.
//   dev default 후보는 docs/sallijang-load-plan/captured/api-mapping-verification-dev_yji-2026-04-30.md §4.2.
// - K6_REMAINING_DELTA 는 race 의도상 음수(차감) 권장. 양수(복원)로 두면 같은 row 동시 UPDATE 라도
//   409 가 발생하지 않아 race 의도가 달라진다.
// - 측정 도중 재고가 고갈되면 라우터의 fallback SELECT 가 추가 부하로 들어가 lock 측정이 흐려진다.
//   K6_PRODUCT_REMAINING_INIT 를 충분히 크게 잡거나 보고서 해석 시 분리한다.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

// ---------- 기본 설정 ----------

const BASE_URL = __ENV.K6_BASE_URL || "http://product-service";

// store 생성은 카카오 외부 API 호출이 들어가 측정 대상에서 제외한다 (04-salijang-api-mapping §5.1).
// 따라서 K6_STORE_ID 는 외부에서 반드시 주입해야 한다.
const STORE_ID = Number(__ENV.K6_STORE_ID ?? "0");

// contention 강도 조절용. 권장 범위 3 ~ 10. 너무 크면 lock 효과가 약해지고, 1 이면 직렬화가 극단으로 가서
// 시스템 한계 보다 단일 row write throughput 측정에 가까워진다.
const POOL_SIZE = Number(__ENV.K6_PRODUCT_POOL_SIZE ?? "5");
const PRODUCT_REMAINING_INIT = Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "50000");
const DELTA = Number(__ENV.K6_REMAINING_DELTA ?? "-1");
const PRODUCT_CATEGORY = __ENV.K6_PRODUCT_CATEGORY ?? "베이커리";

const RUN_PREFIX = __ENV.K6_RUN_PREFIX ?? `${Date.now()}`;
const TESTID = __ENV.K6_TESTID ?? `remaining-race-stress-${RUN_PREFIX}`;

// ---------- 부하 단계 ----------

// docs/sallijang-load-plan/01-stress-scenarios.md §4.3 의 prod 잠정값.
// dev default 후보는 captured/api-mapping-verification-dev_yji-2026-04-30.md §4.2.
function buildStages() {
  const json = __ENV.K6_STAGES_JSON;
  if (json) {
    return JSON.parse(json);
  }
  return [
    { duration: "30s", target: 50 },
    { duration: "2m", target: 50 },
    { duration: "30s", target: 100 },
    { duration: "2m", target: 100 },
    { duration: "30s", target: 200 },
    { duration: "2m", target: 200 },
    { duration: "30s", target: 400 },
    { duration: "2m", target: 400 },
    { duration: "30s", target: 0 },
  ];
}

// lock 대기로 응답시간이 길어질 수 있어 read stress 보다 안전계수를 크게 잡는다.
// 400 RPS × 1s × 3 = 1200 default. lock 누적이 심하면 K6_MAX_VUS 로 올린다.
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "100");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "1200");

// ---------- 메트릭 ----------

const status200 = new Counter("remaining_race_status_200");
const status404 = new Counter("remaining_race_status_404");
const status409 = new Counter("remaining_race_status_409");
const status5xx = new Counter("remaining_race_status_5xx");
const statusOther = new Counter("remaining_race_status_other");

// ---------- k6 options ----------

export const options = {
  scenarios: {
    product_remaining_race_stress: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: buildStages(),
    },
  },
  tags: { testid: TESTID, scenario: "product-remaining-race-stress" },
};

// ---------- setup / teardown ----------

function sellerJsonHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = __ENV.K6_SELLER_ACCESS_TOKEN || __ENV.K6_ACCESS_TOKEN || __ENV.K6_AUTH_TOKEN || "";
  if (token) {
    headers.Cookie = `access_token=${token}`;
    headers.Authorization = `Bearer ${token}`;
  }
  return { headers };
}

function buildProductPayload(index) {
  return {
    name: `stress-race-${RUN_PREFIX}-${index}`,
    original_price: 10000,
    discount_price: 8000,
    remaining: PRODUCT_REMAINING_INIT,
    total_quantity: PRODUCT_REMAINING_INIT,
    expiry_minutes: 60,
    pickup_deadline: null,
    category: PRODUCT_CATEGORY,
    image_url: null,
    weight: null,
    description: "k6 stress race dedicated product",
    is_deleted: false,
  };
}

function softDeleteProductsBestEffort(productIds, reason) {
  for (const productId of productIds) {
    const response = http.del(`${BASE_URL}/api/v1/products/${productId}`, null, sellerJsonHeaders());
    if (response.status !== 204 && response.status !== 404) {
      console.warn(
        `setup ${reason} 정리 실패 (계속 진행): productId=${productId} status=${response.status}`,
      );
    }
  }
}

export function setup() {
  if (!STORE_ID || STORE_ID <= 0) {
    throw new Error("K6_STORE_ID 환경변수가 필수다 (양의 정수). store 생성은 측정 대상이 아니다.");
  }

  const productIds = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const payload = JSON.stringify(buildProductPayload(i));
    const url = `${BASE_URL}/api/v1/products/?store_id=${STORE_ID}`;
    const response = http.post(url, payload, sellerJsonHeaders());
    if (response.status !== 201) {
      // 이미 만든 상품은 누수 방지를 위해 정리한 뒤 abort.
      softDeleteProductsBestEffort(productIds, "POST 실패");
      throw new Error(
        `setup 상품 생성 실패: index=${i} status=${response.status} body=${response.body}`,
      );
    }
    const product = response.json();
    if (!product || typeof product.id !== "number") {
      softDeleteProductsBestEffort(productIds, "응답 파싱 실패");
      throw new Error(`setup 상품 응답 파싱 실패: index=${i} body=${response.body}`);
    }
    productIds.push(product.id);
  }

  const stages = buildStages();
  const peakRps = stages.reduce((max, stage) => Math.max(max, stage.target ?? 0), 0);
  console.log(
    `product-remaining-race-stress baseUrl=${BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} poolSize=${POOL_SIZE} initialRemaining=${PRODUCT_REMAINING_INIT} ` +
      `delta=${DELTA} peakRps=${peakRps} preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} ` +
      `productIds=[${productIds.join(",")}]`,
  );

  return { productIds };
}

export function teardown(data) {
  if (!data || !Array.isArray(data.productIds)) {
    return;
  }
  softDeleteProductsBestEffort(data.productIds, "teardown");
}

// ---------- 실행 ----------

export default function (data) {
  // 풀 안에서 균등 분포로 의도적 contention 을 만든다.
  const productId = data.productIds[Math.floor(Math.random() * data.productIds.length)];
  const url = `${BASE_URL}/api/v1/products/${productId}/remaining?delta=${DELTA}`;
  const response = http.patch(url, null);

  if (response.status === 200) {
    status200.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status === 404) {
    status404.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  } else {
    statusOther.add(1);
  }

  // threshold 와 연결하지 않는다. 한계 측정 중 abort 가 cliff 를 가린다.
  // 200 / 409 는 정상 흐름, 404 는 setup 누락 신호, 5xx 는 시스템 한계 신호로 분리해서 본다.
  check(response, {
    "no 5xx": (res) => res.status < 500,
    "no 404 (pool 유지)": (res) => res.status !== 404,
  });
}
