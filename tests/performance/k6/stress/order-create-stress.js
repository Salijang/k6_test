// Salijang order-service 의 주문 생성 cross-service stress 스크립트.
// 의도된 부하: POST /orders 1건이 product GET (재고 조회) + product PATCH (재고 차감) +
//   notify POST (알림) 로 이어지는 흐름에서, 어느 dependency 가 먼저 무너지는지 본다.
// order RPS = N → product RPS 2N + notify RPS N (item 1개 기준).
// 자세한 설계는 docs/sallijang-load-plan/01-stress-scenarios.md §4.4,
// docs/sallijang-load-plan/04-salijang-api-mapping.md §4.1 참고.
//
// 실행 주의:
// - 본문 단계 default 는 prod 잠정값이다. dev 환경(replica 1, cpu limit 500m)에서는 과도하다.
//   dev default 후보는 docs/sallijang-load-plan/captured/api-mapping-verification-dev_yji-2026-04-30.md §4.3.
// - K6_BASE_URL_ORDER / K6_BASE_URL_PRODUCT 는 별도 host 일 수 있어 명시 분리한다.
//   외부 실행 시 두 변수 모두 주입 권장.
// - 본 스크립트는 product 풀만 teardown 한다. 생성된 order / order_item row 는 외부 cleanup 으로 정리한다.
//   현재 라우터 구조상 RUN_PREFIX 로 식별 가능한 필드가 마땅치 않아 자동 정리는 보류.
// - POOL_SIZE 는 분산 의도. 너무 작으면 (예: 5 미만) product PATCH 에서 race 가 강하게 발생해
//   409 폭증으로 cross-service 측정 신호가 섞인다. 권장 20 이상.
// - notify 는 timeout 3s 이고 실패해도 order 흐름이 무시한다. 즉 notify 가 느려지면 order 응답시간에 최대 3s 추가.
//   분리 측정이 필요하면 product / notify 각 서비스의 p95 를 같은 시간축에서 비교한다.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

// ---------- 기본 설정 ----------

const BASE_URL_ORDER = __ENV.K6_BASE_URL_ORDER || "http://order-service";
const BASE_URL_PRODUCT = __ENV.K6_BASE_URL_PRODUCT || "http://product-service";

// store 생성은 카카오 외부 API 호출이 들어가 측정 대상에서 제외한다 (04-salijang-api-mapping §5.1).
const STORE_ID = Number(__ENV.K6_STORE_ID ?? "0");
const STORE_NAME = __ENV.K6_STORE_NAME ?? "Stress Test Store";

// 풀 분산 의도. 작으면 product PATCH race 가 cross-service 측정과 섞인다.
const POOL_SIZE = Number(__ENV.K6_PRODUCT_POOL_SIZE ?? "20");
const PRODUCT_REMAINING_INIT = Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "100000");
const PRODUCT_CATEGORY = __ENV.K6_PRODUCT_CATEGORY ?? "베이커리";

const PAYMENT_METHOD = __ENV.K6_PAYMENT_METHOD ?? "toss";
const ITEM_QUANTITY = Number(__ENV.K6_ITEM_QUANTITY ?? "1");
const UNIT_PRICE = Number(__ENV.K6_UNIT_PRICE ?? "8000");
const PICKUP_EXPECTED_AT = __ENV.K6_PICKUP_EXPECTED_AT ?? "18:00";

const RUN_PREFIX = __ENV.K6_RUN_PREFIX ?? `${Date.now()}`;
const TESTID = __ENV.K6_TESTID ?? `order-create-stress-${RUN_PREFIX}`;

// ---------- 부하 단계 ----------

// docs/sallijang-load-plan/01-stress-scenarios.md §4.4 의 prod 잠정값.
// dev default 후보는 captured/api-mapping-verification-dev_yji-2026-04-30.md §4.3.
function buildStages() {
  const json = __ENV.K6_STAGES_JSON;
  if (json) {
    return JSON.parse(json);
  }
  return [
    { duration: "1m", target: 50 },
    { duration: "3m", target: 50 },
    { duration: "1m", target: 150 },
    { duration: "3m", target: 150 },
    { duration: "1m", target: 300 },
    { duration: "3m", target: 300 },
    { duration: "1m", target: 500 },
    { duration: "3m", target: 500 },
    { duration: "1m", target: 0 },
  ];
}

// cross-service 호출(GET + PATCH + notify) 로 응답시간이 길 가능성 큼.
// 500 RPS × 1s × 3 = 1500 default. 부족하면 K6_MAX_VUS 로 올린다.
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "200");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "1500");

// ---------- 메트릭 ----------

const status201 = new Counter("order_create_status_201");
const status409 = new Counter("order_create_status_409");
const status503 = new Counter("order_create_status_503");
const status5xx = new Counter("order_create_status_5xx");
const statusOther = new Counter("order_create_status_other");

// ---------- options ----------

export const options = {
  scenarios: {
    order_create_stress: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: buildStages(),
    },
  },
  tags: { testid: TESTID, scenario: "order-create-stress" },
};

// ---------- 헬퍼 ----------

function pickTokenFromCsv(csvValue) {
  const tokens = (csvValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens[(__VU - 1) % tokens.length];
}

function jsonHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Cookie = `access_token=${token}`;
    headers.Authorization = `Bearer ${token}`;
  }
  return { headers };
}

function sellerJsonHeaders() {
  return jsonHeaders(__ENV.K6_SELLER_ACCESS_TOKEN || __ENV.K6_ACCESS_TOKEN || __ENV.K6_AUTH_TOKEN || "");
}

function buyerJsonHeaders() {
  const tokenFromPool = pickTokenFromCsv(__ENV.K6_BUYER_ACCESS_TOKENS);
  return jsonHeaders(
    tokenFromPool || __ENV.K6_BUYER_ACCESS_TOKEN || __ENV.K6_ACCESS_TOKEN || __ENV.K6_AUTH_TOKEN || "",
  );
}

function buildProductPayload(index) {
  return {
    name: `stress-order-${RUN_PREFIX}-${index}`,
    original_price: 10000,
    discount_price: UNIT_PRICE,
    remaining: PRODUCT_REMAINING_INIT,
    total_quantity: PRODUCT_REMAINING_INIT,
    expiry_minutes: 60,
    pickup_deadline: null,
    category: PRODUCT_CATEGORY,
    image_url: null,
    weight: null,
    description: "k6 order-create-stress dedicated product",
    is_deleted: false,
  };
}

function softDeleteProductsBestEffort(productIds, reason) {
  for (const productId of productIds) {
    const response = http.del(`${BASE_URL_PRODUCT}/api/v1/products/${productId}`, null, sellerJsonHeaders());
    if (response.status !== 204 && response.status !== 404) {
      console.warn(
        `${reason} 정리 실패 (계속 진행): productId=${productId} status=${response.status}`,
      );
    }
  }
}

// ---------- setup / teardown ----------

export function setup() {
  if (!STORE_ID || STORE_ID <= 0) {
    throw new Error("K6_STORE_ID 환경변수가 필수다 (양의 정수). store 생성은 측정 대상이 아니다.");
  }

  const productIds = [];
  const productNames = {};
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const payload = JSON.stringify(buildProductPayload(i));
    const url = `${BASE_URL_PRODUCT}/api/v1/products/?store_id=${STORE_ID}`;
    const response = http.post(url, payload, sellerJsonHeaders());
    if (response.status !== 201) {
      softDeleteProductsBestEffort(productIds, "setup POST 실패");
      throw new Error(
        `setup 상품 생성 실패: index=${i} status=${response.status} body=${response.body}`,
      );
    }
    const product = response.json();
    if (!product || typeof product.id !== "number") {
      softDeleteProductsBestEffort(productIds, "setup 응답 파싱 실패");
      throw new Error(`setup 상품 응답 파싱 실패: index=${i} body=${response.body}`);
    }
    productIds.push(product.id);
    productNames[product.id] = product.name;
  }

  const stages = buildStages();
  const peakRps = stages.reduce((max, stage) => Math.max(max, stage.target ?? 0), 0);
  console.log(
    `order-create-stress baseUrlOrder=${BASE_URL_ORDER} baseUrlProduct=${BASE_URL_PRODUCT} ` +
      `testid=${TESTID} storeId=${STORE_ID} storeName="${STORE_NAME}" poolSize=${POOL_SIZE} ` +
      `initialRemaining=${PRODUCT_REMAINING_INIT} ` +
      `peakOrderRps=${peakRps} expectedProductGetRps=${peakRps} expectedProductPatchRps=${peakRps} expectedNotifyRps=${peakRps} ` +
      `preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS}`,
  );

  return { productIds, productNames };
}

export function teardown(data) {
  if (!data || !Array.isArray(data.productIds)) {
    return;
  }
  softDeleteProductsBestEffort(data.productIds, "teardown");
  console.log(
    "본 스크립트는 product 풀만 정리한다. 생성된 order / order_item row 는 외부 cleanup 으로 처리.",
  );
}

// ---------- 실행 ----------

export default function (data) {
  const productId = data.productIds[Math.floor(Math.random() * data.productIds.length)];
  const productName = data.productNames[productId] ?? `stress-order-${productId}`;

  const payload = JSON.stringify({
    store_id: STORE_ID,
    store_name: STORE_NAME,
    payment_method: PAYMENT_METHOD,
    total_price: UNIT_PRICE * ITEM_QUANTITY,
    pickup_expected_at: PICKUP_EXPECTED_AT,
    items: [
      {
        product_id: productId,
        product_name: productName,
        quantity: ITEM_QUANTITY,
        unit_price: UNIT_PRICE,
      },
    ],
  });

  // FastAPI 라우터가 prefix `/api/v1/orders` + endpoint `/` 라 끝 슬래시가 붙어야 307 redirect 를 피한다.
  const response = http.post(`${BASE_URL_ORDER}/api/v1/orders/`, payload, buyerJsonHeaders());

  if (response.status === 201) {
    status201.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status === 503) {
    status503.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  } else {
    statusOther.add(1);
  }

  // threshold 와 연결하지 않는다. 한계 측정 중 abort 가 cliff 를 가린다.
  // 503 = product-service 응답 None (cross-service 신호), 409 = 재고 부족 (race),
  // 5xx = order-service 자체 한계, other = 422 등 검증 오류.
  check(response, {
    "no 5xx (order-service 자체)": (res) => res.status < 500,
    "201 body has order_number": (res) =>
      res.status !== 201 || ((res.json() ?? {}).order_number ?? "").length > 0,
  });
}
