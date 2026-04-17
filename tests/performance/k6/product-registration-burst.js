import http from "k6/http";
import { check, sleep } from "k6";

import { BASE_URL, SELLER_ID, STORE_ID, sellerHeaders } from "./common.js";

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
  const suffix = `${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    sku: `LOAD-${suffix}`,
    name: `Load Product ${suffix}`,
    description: "k6 registration burst demo",
    price: 10000 + __ITER,
    stock: 10,
    status: "ACTIVE",
  });

  const response = http.post(
    `${BASE_URL}/stores/${STORE_ID}/products`,
    payload,
    sellerHeaders(),
  );

  check(response, {
    "registration status is 201 or 409": (res) => res.status === 201 || res.status === 409,
    "registration never unauthorized": (res) => res.status !== 401 && res.status !== 403,
  });

  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        script: "product-registration-burst",
        sellerId: SELLER_ID,
        metrics: data.metrics,
      },
      null,
      2,
    ),
  };
}

