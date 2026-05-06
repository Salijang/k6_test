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

const TARGETS = (__ENV.K6_STEP_TARGETS ?? "5,10,20,40,80")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);
const RAMP_DURATION = __ENV.K6_STEP_RAMP_DURATION ?? "30s";
const HOLD_DURATION = __ENV.K6_STEP_HOLD_DURATION ?? "2m";
const COOLDOWN_DURATION = __ENV.K6_STEP_COOLDOWN_DURATION ?? "30s";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "50");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "500");
const CATEGORY_FILTER_RATIO = Number(__ENV.K6_CATEGORY_FILTER_RATIO ?? "0.5");
const ENFORCE_THRESHOLDS = __ENV.K6_ENFORCE_THRESHOLDS === "1";
const P95_THRESHOLD = __ENV.K6_STEP_P95_THRESHOLD ?? "1200";

const statusCounters = buildStatusCounters("product_list_step_load");

function defaultStages() {
  const stages = [];
  for (const target of TARGETS) {
    stages.push({ duration: RAMP_DURATION, target });
    stages.push({ duration: HOLD_DURATION, target });
  }
  stages.push({ duration: COOLDOWN_DURATION, target: 0 });
  return stages;
}

export const options = {
  thresholds: ENFORCE_THRESHOLDS
    ? {
        checks: ["rate>0.99"],
        http_req_failed: ["rate<0.01"],
        "http_req_duration{endpoint:product_list}": [`p(95)<${P95_THRESHOLD}`],
      }
    : {},
  scenarios: {
    product_list_step_load: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: parseStages(defaultStages()),
    },
  },
  tags: { testid: TESTID, scenario: "product-list-step-load" },
};

export function setup() {
  console.log(
    `product-list-step-load baseUrl=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `targets=[${TARGETS.join(",")}] ramp=${RAMP_DURATION} hold=${HOLD_DURATION} cooldown=${COOLDOWN_DURATION} ` +
      `preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} enforceThresholds=${ENFORCE_THRESHOLDS}`,
  );
}

export default function () {
  const category = Math.random() < CATEGORY_FILTER_RATIO ? pickCategory() : null;
  const response = http.get(productListUrl({ category }), requestOptions("product_list"));

  addStatus(statusCounters, response);

  check(response, {
    "product list status is 2xx": (res) => res.status >= 200 && res.status < 300,
    "product list 200 body is array": (res) => res.status !== 200 || Array.isArray(res.json()),
  });
}
