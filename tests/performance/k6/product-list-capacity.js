import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import { BASE_URL, STORE_ID } from "./common.js";

const STAGE_TARGETS = (__ENV.K6_CAPACITY_STAGE_TARGETS ?? "10,25,50,100,150,200")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const RAMP_DURATION = __ENV.K6_CAPACITY_RAMP_DURATION ?? "20s";
const HOLD_DURATION = __ENV.K6_CAPACITY_HOLD_DURATION ?? "1m";
const COOLDOWN_DURATION = __ENV.K6_CAPACITY_COOLDOWN_DURATION ?? "20s";
const THINK_TIME_SECONDS = Number(__ENV.K6_CAPACITY_THINK_TIME ?? "0.5");

const status2xx = new Counter("capacity_status_2xx");
const status4xx = new Counter("capacity_status_4xx");
const status5xx = new Counter("capacity_status_5xx");

function buildStages(targets) {
  return [
    ...targets.flatMap((target) => [
      { duration: RAMP_DURATION, target },
      { duration: HOLD_DURATION, target },
    ]),
    { duration: COOLDOWN_DURATION, target: 0 },
  ];
}

export const options = {
  scenarios: {
    product_list_capacity: {
      executor: "ramping-vus",
      startVUs: 1,
      gracefulRampDown: "10s",
      stages: buildStages(STAGE_TARGETS),
    },
  },
};

export function setup() {
  console.log(
    `product-list-capacity stages=${STAGE_TARGETS.join(",")} ramp=${RAMP_DURATION} hold=${HOLD_DURATION} cooldown=${COOLDOWN_DURATION} baseUrl=${BASE_URL}`,
  );
}

export default function () {
  const response = http.get(`${BASE_URL}/stores/${STORE_ID}/products`);

  if (response.status >= 200 && response.status < 300) {
    status2xx.add(1);
  } else if (response.status >= 400 && response.status < 500) {
    status4xx.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  }

  check(response, {
    "capacity list status is 200": (res) => res.status === 200,
    "capacity product list returned array": (res) => Array.isArray(res.json()),
  });

  sleep(THINK_TIME_SECONDS);
}
