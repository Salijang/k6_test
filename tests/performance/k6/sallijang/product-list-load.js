import http from "k6/http";
import { check } from "k6";

import {
  PRODUCT_BASE_URL,
  PRODUCT_CATEGORIES,
  TESTID,
  addStatus,
  buildStatusCounters,
  pickCategory,
  productListUrl,
  requestOptions,
} from "./common.js";

const RATE = Number(__ENV.K6_READ_RATE ?? "20");
const DURATION = __ENV.K6_READ_DURATION ?? "2m";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "30");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "200");
const CATEGORY_FILTER_RATIO = Number(__ENV.K6_CATEGORY_FILTER_RATIO ?? "0.5");
const P95_THRESHOLD = __ENV.K6_READ_P95_THRESHOLD ?? "800";

const statusCounters = buildStatusCounters("product_list_load");

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${P95_THRESHOLD}`],
    "http_req_duration{endpoint:product_list}": [`p(95)<${P95_THRESHOLD}`],
  },
  scenarios: {
    product_list_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  tags: { testid: TESTID, scenario: "product-list-load" },
};

export function setup() {
  console.log(
    `product-list-load baseUrl=${PRODUCT_BASE_URL} testid=${TESTID} rate=${RATE}/s ` +
      `duration=${DURATION} preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} ` +
      `categories=[${PRODUCT_CATEGORIES.join(",")}]`,
  );
}

export default function () {
  const category = Math.random() < CATEGORY_FILTER_RATIO ? pickCategory() : null;
  const response = http.get(productListUrl({ category }), requestOptions("product_list"));

  addStatus(statusCounters, response);

  check(response, {
    "product list status is 200": (res) => res.status === 200,
    "product list body is array": (res) => res.status !== 200 || Array.isArray(res.json()),
  });
}
