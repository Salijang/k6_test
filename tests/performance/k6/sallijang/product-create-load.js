import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

import {
  PRODUCT_BASE_URL,
  STORE_ID,
  TESTID,
  buildProductPayload,
  requireStoreId,
  sellerRequestOptions,
} from "./common.js";

const RATE = Number(__ENV.K6_PRODUCT_CREATE_RATE ?? "5");
const DURATION = __ENV.K6_PRODUCT_CREATE_DURATION ?? "1m";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "100");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "1000");
const P95_THRESHOLD = __ENV.K6_PRODUCT_CREATE_P95_THRESHOLD ?? "2000";

const create201 = new Counter("product_create_load_status_201");
const create4xx = new Counter("product_create_load_status_4xx");
const create5xx = new Counter("product_create_load_status_5xx");
const createOther = new Counter("product_create_load_status_other");
const delete204 = new Counter("product_create_load_delete_status_204");
const deleteOther = new Counter("product_create_load_delete_status_other");

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:product_create}": [`p(95)<${P95_THRESHOLD}`],
    product_create_load_status_5xx: ["count==0"],
  },
  scenarios: {
    product_create_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  tags: { testid: TESTID, scenario: "product-create-load" },
};

export function setup() {
  requireStoreId();
  console.log(
    `product-create-load baseUrl=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} rate=${RATE}/s duration=${DURATION} ` +
      `preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS}`,
  );
}

export default function () {
  const createResponse = http.post(
    `${PRODUCT_BASE_URL}/api/v1/products/?store_id=${STORE_ID}`,
    JSON.stringify(
      buildProductPayload({
        index: `${__VU}-${__ITER}`,
        namePrefix: "create-load-product",
        remaining: Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "1000"),
      }),
    ),
    sellerRequestOptions("product_create"),
  );

  if (createResponse.status === 201) {
    create201.add(1);
  } else if (createResponse.status >= 400 && createResponse.status < 500) {
    create4xx.add(1);
  } else if (createResponse.status >= 500) {
    create5xx.add(1);
  } else {
    createOther.add(1);
  }

  check(createResponse, {
    "product create status is 201": (res) => res.status === 201,
    "product create has id": (res) =>
      res.status !== 201 || typeof ((res.json() ?? {}).id) === "number",
  });

  if (createResponse.status !== 201) {
    return;
  }

  const productId = createResponse.json().id;
  const deleteResponse = http.del(
    `${PRODUCT_BASE_URL}/api/v1/products/${productId}`,
    null,
    sellerRequestOptions("product_delete"),
  );

  if (deleteResponse.status === 204) {
    delete204.add(1);
  } else {
    deleteOther.add(1);
  }

  check(deleteResponse, {
    "product cleanup delete status is 204": (res) => res.status === 204,
  });
}
