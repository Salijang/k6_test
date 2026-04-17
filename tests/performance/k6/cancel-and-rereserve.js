import http from "k6/http";
import { check, sleep } from "k6";

import { BASE_URL, STORE_ID, customerHeaders, listProducts, listSlots } from "./common.js";

export const options = {
  scenarios: {
    cancel_and_rereserve: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 10,
      maxDuration: "1m",
    },
  },
};

export default function () {
  const products = listProducts();
  const slots = listSlots();
  const product = products[0];
  const slot = slots[0];

  const created = http.post(
    `${BASE_URL}/pickup-reservations`,
    JSON.stringify({
      storeId: STORE_ID,
      productId: product.id,
      slotId: slot.id,
      quantity: 1,
    }),
    customerHeaders(),
  );

  check(created, {
    "create status is 201 or 409": (res) => res.status === 201 || res.status === 409,
  });

  if (created.status === 201) {
    const reservation = created.json();
    const cancelled = http.post(
      `${BASE_URL}/pickup-reservations/${reservation.id}/cancel`,
      null,
      customerHeaders(),
    );

    check(cancelled, {
      "cancel status is 200": (res) => res.status === 200,
    });
  }

  sleep(1);
}
