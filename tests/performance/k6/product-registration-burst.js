import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import { BASE_URL, SELLER_ID, STORE_ID, sellerHeaders } from "./common.js";

const REGISTRATION_SKU_POOL_SIZE = Number(__ENV.K6_REGISTRATION_SKU_POOL_SIZE ?? "20");
const THINK_TIME_SECONDS = Number(__ENV.K6_REGISTRATION_THINK_TIME ?? "1");
const RUN_PREFIX = __ENV.K6_REGISTRATION_RUN_PREFIX ?? `${Date.now()}`;

const status201 = new Counter("registration_status_201");
const status409 = new Counter("registration_status_409");
const status5xx = new Counter("registration_status_5xx");

export const options = {
  scenarios: {
    registration_burst: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "15s", target: 10 },
        { duration: "30s", target: 30 },
        { duration: "10s", target: 0 },
      ],
    },
  },
};

export default function () {
  const skuIndex = (__ITER + __VU - 1) % REGISTRATION_SKU_POOL_SIZE;
  const sharedSku = `LOAD-${RUN_PREFIX}-${skuIndex}`;
  const payload = JSON.stringify({
    sku: sharedSku,
    name: `Load Product ${sharedSku}`,
    description: "k6 registration burst collision demo",
    price: 10000 + __ITER,
    stock: 10,
    status: "ACTIVE",
  });

  const response = http.post(
    `${BASE_URL}/stores/${STORE_ID}/products`,
    payload,
    sellerHeaders(),
  );

  if (response.status === 201) {
    status201.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  }

  check(response, {
    "registration status is 201 or 409": (res) => res.status === 201 || res.status === 409,
    "registration never unauthorized": (res) => res.status !== 401 && res.status !== 403,
    "registration never 5xx": (res) => res.status < 500,
  });

  sleep(THINK_TIME_SECONDS);
}
