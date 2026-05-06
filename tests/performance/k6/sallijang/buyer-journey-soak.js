import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  ORDER_BASE_URL,
  PRODUCT_BASE_URL,
  STORE_ID,
  STORE_NAME,
  TESTID,
  buildOrderPayload,
  buyerRequestOptions,
  createProductPool,
  deleteProductsBestEffort,
  parseProductIdsFromEnv,
  pickCategory,
  productListUrl,
  requireStoreId,
} from "./common.js";

const VUS = Number(__ENV.K6_SOAK_VUS ?? "5");
const DURATION = __ENV.K6_SOAK_DURATION ?? "30m";
const ORDER_PROBABILITY = Number(__ENV.K6_SOAK_ORDER_PROBABILITY ?? "0.2");
const THINK_TIME_SECONDS = Number(__ENV.K6_THINK_TIME_SECONDS ?? "1");
const POOL_SIZE = Number(__ENV.K6_PRODUCT_POOL_SIZE ?? "20");
const CATEGORY_FILTER_RATIO = Number(__ENV.K6_CATEGORY_FILTER_RATIO ?? "0.5");
const READ_P95_THRESHOLD = __ENV.K6_SOAK_READ_P95_THRESHOLD ?? "1000";
const ORDER_P95_THRESHOLD = __ENV.K6_SOAK_ORDER_P95_THRESHOLD ?? "2000";

const read2xx = new Counter("buyer_journey_read_status_2xx");
const read5xx = new Counter("buyer_journey_read_status_5xx");
const order201 = new Counter("buyer_journey_order_status_201");
const order409 = new Counter("buyer_journey_order_status_409");
const order5xx = new Counter("buyer_journey_order_status_5xx");

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:product_list}": [`p(95)<${READ_P95_THRESHOLD}`],
    "http_req_duration{endpoint:order_create}": [`p(95)<${ORDER_P95_THRESHOLD}`],
    buyer_journey_read_status_5xx: ["count==0"],
    buyer_journey_order_status_5xx: ["count==0"],
  },
  scenarios: {
    buyer_journey_soak: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  tags: { testid: TESTID, scenario: "buyer-journey-soak" },
};

function productDataFromEnv() {
  return parseProductIdsFromEnv().map((id) => ({
    id,
    name: `k6-product-${id}`,
  }));
}

export function setup() {
  if (ORDER_PROBABILITY > 0) {
    requireStoreId();
  }

  const configuredProducts = productDataFromEnv();
  const products =
    ORDER_PROBABILITY <= 0 || configuredProducts.length > 0
      ? configuredProducts
      : createProductPool(POOL_SIZE, {
          namePrefix: "soak-product",
          remaining: Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "100000"),
        });

  console.log(
      `buyer-journey-soak productBase=${PRODUCT_BASE_URL} orderBase=${ORDER_BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} storeName="${STORE_NAME}" vus=${VUS} duration=${DURATION} ` +
      `orderProbability=${ORDER_PROBABILITY} productPool=${products.length} ` +
      `externalProducts=${configuredProducts.length > 0}`,
  );

  return {
    products,
    shouldCleanupProducts: ORDER_PROBABILITY > 0 && configuredProducts.length === 0,
  };
}

export function teardown(data) {
  if (!data || !data.shouldCleanupProducts) {
    return;
  }

  deleteProductsBestEffort(
    data.products.map((product) => product.id),
    "soak cleanup",
  );
}

export default function (data) {
  const category = Math.random() < CATEGORY_FILTER_RATIO ? pickCategory() : null;
  const listResponse = http.get(productListUrl({ category }), requestOptions("product_list"));

  if (listResponse.status >= 200 && listResponse.status < 300) {
    read2xx.add(1);
  } else if (listResponse.status >= 500) {
    read5xx.add(1);
  }

  check(listResponse, {
    "journey product list status is 200": (res) => res.status === 200,
    "journey product list body is array": (res) => res.status !== 200 || Array.isArray(res.json()),
  });

  sleep(THINK_TIME_SECONDS);

  if (ORDER_PROBABILITY <= 0 || Math.random() >= ORDER_PROBABILITY || data.products.length === 0) {
    return;
  }

  const product = data.products[Math.floor(Math.random() * data.products.length)];
  const orderResponse = http.post(
    `${ORDER_BASE_URL}/api/v1/orders/`,
    JSON.stringify(
      buildOrderPayload({
        productId: product.id,
        productName: product.name,
      }),
    ),
    buyerRequestOptions("order_create"),
  );

  if (orderResponse.status === 201) {
    order201.add(1);
  } else if (orderResponse.status === 409) {
    order409.add(1);
  } else if (orderResponse.status >= 500) {
    order5xx.add(1);
  }

  check(orderResponse, {
    "journey order create status is 201": (res) => res.status === 201,
    "journey order create has order number": (res) =>
      res.status !== 201 || ((res.json() ?? {}).order_number ?? "").length > 0,
  });

  sleep(THINK_TIME_SECONDS);
}
