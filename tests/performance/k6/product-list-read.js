import { sleep } from "k6";
import http from "k6/http";
import { check } from "k6";

import { BASE_URL, STORE_ID } from "./common.js";

export const options = {
  scenarios: {
    product_read: {
      executor: "constant-vus",
      vus: 25,
      duration: "45s",
    },
  },
};

export default function () {
  const response = http.get(`${BASE_URL}/stores/${STORE_ID}/products`);

  check(response, {
    "list status is 200": (res) => res.status === 200,
    "product list returned array": (res) => Array.isArray(res.json()),
  });

  sleep(0.5);
}

