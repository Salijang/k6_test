import http from "k6/http";
import { check, sleep } from "k6";

import { BASE_URL, STORE_ID, customerHeaders, listProducts, listSlots } from "./common.js";

export const options = {
  scenarios: {
    hot_slot_race: {
      executor: "constant-arrival-rate",
      rate: 15,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 30,
      maxVUs: 60,
    },
  },
};

export default function () {
  const products = listProducts();
  const slots = listSlots();
  const product = products[0];
  const slot = slots[0];

  const response = http.post(
    `${BASE_URL}/pickup-reservations`,
    JSON.stringify({
      storeId: STORE_ID,
      productId: product.id,
      slotId: slot.id,
      quantity: 1,
    }),
    customerHeaders(),
  );

  check(response, {
    "reservation status is 201 or 409": (res) => res.status === 201 || res.status === 409,
    "reservation never 500": (res) => res.status !== 500,
  });

  sleep(1);
}

