import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

import {
  PRODUCT_BASE_URL,
  STORE_ID,
  TESTID,
  createProductPool,
  deleteProductsBestEffort,
  parseProductIdsFromEnv,
  requireStoreId,
  sellerRequestOptions,
} from "./common.js";

const RATE = Number(__ENV.K6_REMAINING_RATE ?? "5");
const DURATION = __ENV.K6_REMAINING_DURATION ?? "1m";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "100");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "1000");
const POOL_SIZE = Number(__ENV.K6_PRODUCT_POOL_SIZE ?? "50");
const DELTA = Number(__ENV.K6_REMAINING_DELTA ?? "-1");
const P95_THRESHOLD = __ENV.K6_REMAINING_P95_THRESHOLD ?? "1000";

const status200 = new Counter("product_remaining_load_status_200");
const status409 = new Counter("product_remaining_load_status_409");
const status4xx = new Counter("product_remaining_load_status_4xx");
const status5xx = new Counter("product_remaining_load_status_5xx");
const statusOther = new Counter("product_remaining_load_status_other");

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    "http_req_failed{endpoint:product_remaining}": ["rate<0.01"],
    "http_req_duration{endpoint:product_remaining}": [`p(95)<${P95_THRESHOLD}`],
    product_remaining_load_status_5xx: ["count==0"],
  },
  scenarios: {
    product_remaining_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  tags: { testid: TESTID, scenario: "product-remaining-load" },
};

function productDataFromEnv() {
  return parseProductIdsFromEnv().map((id) => ({ id }));
}

export function setup() {
  requireStoreId();

  const configuredProducts = productDataFromEnv();
  const products =
    configuredProducts.length > 0
      ? configuredProducts
      : createProductPool(POOL_SIZE, {
          namePrefix: "remaining-load-product",
          remaining: Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "100000"),
        });

  console.log(
    `product-remaining-load baseUrl=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} rate=${RATE}/s duration=${DURATION} productPool=${products.length} ` +
      `delta=${DELTA} preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} ` +
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
    "remaining load cleanup",
  );
}

export default function (data) {
  const product = data.products[Math.floor(Math.random() * data.products.length)];
  const response = http.patch(
    `${PRODUCT_BASE_URL}/api/v1/products/${product.id}/remaining?delta=${DELTA}`,
    null,
    sellerRequestOptions("product_remaining"),
  );

  if (response.status === 200) {
    status200.add(1);
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
    "remaining patch status is 200": (res) => res.status === 200,
    "remaining patch has remaining": (res) =>
      res.status !== 200 || typeof ((res.json() ?? {}).remaining) === "number",
  });
}
