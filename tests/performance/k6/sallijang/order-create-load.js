import http from "k6/http";
import { check } from "k6";
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
  requireStoreId,
} from "./common.js";

const RATE = Number(__ENV.K6_ORDER_RATE ?? "10");
const DURATION = __ENV.K6_ORDER_DURATION ?? "2m";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "30");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "300");
const POOL_SIZE = Number(__ENV.K6_PRODUCT_POOL_SIZE ?? "10");
const P95_THRESHOLD = __ENV.K6_ORDER_P95_THRESHOLD ?? "1500";

const status201 = new Counter("order_create_load_status_201");
const status409 = new Counter("order_create_load_status_409");
const status4xx = new Counter("order_create_load_status_4xx");
const status5xx = new Counter("order_create_load_status_5xx");
const statusOther = new Counter("order_create_load_status_other");

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    "http_req_failed{endpoint:order_create}": ["rate<0.01"],
    http_req_duration: [`p(95)<${P95_THRESHOLD}`],
    "http_req_duration{endpoint:order_create}": [`p(95)<${P95_THRESHOLD}`],
    order_create_load_status_5xx: ["count==0"],
  },
  scenarios: {
    order_create_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  tags: { testid: TESTID, scenario: "order-create-load" },
};

function productDataFromEnv() {
  return parseProductIdsFromEnv().map((id) => ({
    id,
    name: `k6-product-${id}`,
  }));
}

export function setup() {
  requireStoreId();

  const configuredProducts = productDataFromEnv();
  const products =
    configuredProducts.length > 0
      ? configuredProducts
      : createProductPool(POOL_SIZE, {
          namePrefix: "order-load-product",
          remaining: Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "100000"),
        });

  console.log(
      `order-create-load orderBase=${ORDER_BASE_URL} productBase=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} storeName="${STORE_NAME}" rate=${RATE}/s duration=${DURATION} ` +
      `productPool=${products.length} preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} ` +
      `externalProducts=${configuredProducts.length > 0}`,
  );

  return {
    products,
    shouldCleanupProducts: configuredProducts.length === 0,
  };
}

export function teardown(data) {
  if (!data || !data.shouldCleanupProducts) {
    return;
  }

  deleteProductsBestEffort(
    data.products.map((product) => product.id),
    "order load cleanup",
  );
}

export default function (data) {
  const product = data.products[Math.floor(Math.random() * data.products.length)];
  const response = http.post(
    `${ORDER_BASE_URL}/api/v1/orders/`,
    JSON.stringify(
      buildOrderPayload({
        productId: product.id,
        productName: product.name,
      }),
    ),
    buyerRequestOptions("order_create"),
  );

  if (response.status === 201) {
    status201.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status >= 400 && response.status < 500) {
    status4xx.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  } else {
    statusOther.add(1);
  }

  check(response, {
    "order create status is 201": (res) => res.status === 201,
    "order create has order number": (res) =>
      res.status !== 201 || ((res.json() ?? {}).order_number ?? "").length > 0,
  });
}
