import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  BASE_URL,
  CUSTOMER_IDS,
  STORE_ID,
  customerHeaders,
  dayWithOffset,
  listSlotsForDate,
  sellerHeaders,
} from "./common.js";

const status201 = new Counter("hot_slot_status_201");
const status409 = new Counter("hot_slot_status_409");
const status5xx = new Counter("hot_slot_status_5xx");
const HOT_SLOT_OFFSET = Number(__ENV.K6_HOT_SLOT_OFFSET ?? "13");
const HOT_SLOT_PRODUCT_STOCK = Number(__ENV.K6_HOT_SLOT_PRODUCT_STOCK ?? "100");
const HOT_SLOT_QUANTITY = Number(__ENV.K6_HOT_SLOT_QUANTITY ?? "1");
const RUN_PREFIX = __ENV.K6_HOT_SLOT_RUN_PREFIX ?? `${Date.now()}`;

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

export function setup() {
  const slotDate = dayWithOffset(HOT_SLOT_OFFSET);
  const slots = listSlotsForDate(slotDate).filter((item) => item.remainingCapacity > 0);
  const slot = slots[0];

  if (!slot) {
    throw new Error(`no available pickup slots for ${slotDate}`);
  }

  const productResponse = http.post(
    `${BASE_URL}/stores/${STORE_ID}/products`,
    JSON.stringify({
      sku: `HOT-SLOT-${RUN_PREFIX}`,
      name: "Hot Slot Race Dedicated Product",
      description: "k6 dedicated product for reservation conflict race",
      price: 10000,
      stock: HOT_SLOT_PRODUCT_STOCK,
      status: "ACTIVE",
    }),
    sellerHeaders(),
  );

  check(productResponse, {
    "hot slot setup product status is 201": (res) => res.status === 201,
  });

  if (productResponse.status !== 201) {
    throw new Error(`failed to create dedicated hot slot product: ${productResponse.status}`);
  }

  return {
    product: productResponse.json(),
    slot,
    slotDate,
  };
}

export default function (setupData) {
  const customerId = CUSTOMER_IDS[(__ITER + __VU - 1) % CUSTOMER_IDS.length];
  const slots = listSlotsForDate(setupData.slotDate);

  check(slots, {
    "target hot slot is visible": (items) => items.some((item) => item.id === setupData.slot.id),
  });

  const response = http.post(
    `${BASE_URL}/pickup-reservations`,
    JSON.stringify({
      storeId: STORE_ID,
      productId: setupData.product.id,
      slotId: setupData.slot.id,
      quantity: HOT_SLOT_QUANTITY,
    }),
    customerHeaders(customerId),
  );

  if (response.status === 201) {
    status201.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  }

  check(response, {
    "reservation status is 201 or 409": (res) => res.status === 201 || res.status === 409,
    "reservation never 5xx": (res) => res.status < 500,
  });

  sleep(1);
}
