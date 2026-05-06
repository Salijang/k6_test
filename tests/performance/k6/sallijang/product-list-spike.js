import http from "k6/http";
import { check } from "k6";

import {
  PRODUCT_BASE_URL,
  TESTID,
  addStatus,
  buildStatusCounters,
  parseStages,
  pickCategory,
  productListUrl,
  requestOptions,
} from "./common.js";

const BASE_RATE = Number(__ENV.K6_SPIKE_BASE_RATE ?? "5");
const SPIKE_RATE = Number(__ENV.K6_SPIKE_RATE ?? "50");
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "80");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "500");
const CATEGORY_FILTER_RATIO = Number(__ENV.K6_CATEGORY_FILTER_RATIO ?? "0.5");
const P95_THRESHOLD = __ENV.K6_SPIKE_P95_THRESHOLD ?? "1500";

const statusCounters = buildStatusCounters("product_list_spike");

const defaultStages = [
  { duration: "30s", target: BASE_RATE },
  { duration: "1m", target: BASE_RATE },
  { duration: "10s", target: SPIKE_RATE },
  { duration: "30s", target: SPIKE_RATE },
  { duration: "10s", target: BASE_RATE },
  { duration: "1m", target: BASE_RATE },
  { duration: "20s", target: 0 },
];

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:product_list}": [`p(95)<${P95_THRESHOLD}`],
  },
  scenarios: {
    product_list_spike: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: parseStages(defaultStages),
    },
  },
  tags: { testid: TESTID, scenario: "product-list-spike" },
};

export function setup() {
  console.log(
    `product-list-spike baseUrl=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `baseRate=${BASE_RATE}/s spikeRate=${SPIKE_RATE}/s preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS}`,
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
