import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  BASE_URL,
  CUSTOMER_IDS,
  STORE_ID,
  customerAuthHeaders,
  customerHeaders,
  dayWithOffset,
  listProducts,
  listSlotsForDate,
  sellerHeaders,
} from "./common.js";

const CANCEL_VUS = Number(__ENV.K6_CANCEL_VUS ?? "10");
const CANCEL_ITERATIONS = Number(__ENV.K6_CANCEL_ITERATIONS ?? "10");
const MAX_DURATION = __ENV.K6_CANCEL_MAX_DURATION ?? "1m";
const THINK_TIME_SECONDS = Number(__ENV.K6_CANCEL_THINK_TIME ?? "1");
const RESERVATION_QUANTITY = Number(__ENV.K6_CANCEL_RESERVATION_QUANTITY ?? "1");
const RUN_PREFIX = __ENV.K6_CANCEL_RUN_PREFIX ?? `${Date.now()}`;

const create201 = new Counter("cancel_flow_create_201");
const cancel200 = new Counter("cancel_flow_cancel_200");
const rereserve201 = new Counter("cancel_flow_rereserve_201");
const status409 = new Counter("cancel_flow_status_409");
const status5xx = new Counter("cancel_flow_status_5xx");

export const options = {
  scenarios: {
    cancel_and_rereserve: {
      executor: "per-vu-iterations",
      vus: CANCEL_VUS,
      iterations: CANCEL_ITERATIONS,
      maxDuration: MAX_DURATION,
    },
  },
};

function findProduct(products, productId) {
  return products.find((item) => item.id === productId);
}

function findSlot(slots, slotId) {
  return slots.find((item) => item.id === slotId);
}

export function setup() {
  if (CANCEL_VUS > 14) {
    throw new Error("cancel-and-rereserve requires 14 or fewer VUs to map one future date per VU.");
  }

  const products = Array.from({ length: CANCEL_VUS }, (_, index) => {
    const response = http.post(
      `${BASE_URL}/stores/${STORE_ID}/products`,
      JSON.stringify({
        sku: `CANCEL-LOAD-${RUN_PREFIX}-${index + 1}`,
        name: `Cancel Flow Product ${index + 1}`,
        description: "k6 cancel and rereserve dedicated product",
        price: 10000 + index,
        stock: CANCEL_ITERATIONS * RESERVATION_QUANTITY * 4,
        status: "ACTIVE",
      }),
      sellerHeaders(),
    );

    check(response, {
      "cancel setup product status is 201": (res) => res.status === 201,
    });

    if (response.status !== 201) {
      throw new Error(`failed to create dedicated product for VU ${index + 1}: ${response.status}`);
    }

    return response.json();
  });

  const slotAssignments = Array.from({ length: CANCEL_VUS }, (_, index) => {
    const slotDate = dayWithOffset(index + 1);
    const slots = listSlotsForDate(slotDate).filter((slot) => slot.remainingCapacity > 0);

    if (slots.length === 0) {
      throw new Error(`no available pickup slots for ${slotDate}`);
    }

    return {
      slotDate,
      slots,
    };
  });

  return {
    products,
    slotAssignments,
  };
}

export default function (setupData) {
  const vuIndex = (__VU - 1) % setupData.products.length;
  const product = setupData.products[vuIndex];
  const slotAssignment = setupData.slotAssignments[vuIndex];
  const slot = slotAssignment.slots[__ITER % slotAssignment.slots.length];
  const customerId = CUSTOMER_IDS[vuIndex % CUSTOMER_IDS.length];
  const headers = customerHeaders(customerId);
  const authHeaders = customerAuthHeaders(customerId);

  const beforeProduct = findProduct(listProducts(), product.id);
  const beforeSlot = findSlot(listSlotsForDate(slot.slotDate), slot.id);

  const payload = JSON.stringify({
    storeId: STORE_ID,
    productId: product.id,
    slotId: slot.id,
    quantity: RESERVATION_QUANTITY,
  });

  const created = http.post(`${BASE_URL}/pickup-reservations`, payload, headers);

  if (created.status === 201) {
    create201.add(1);
  } else if (created.status === 409) {
    status409.add(1);
  } else if (created.status >= 500) {
    status5xx.add(1);
  }

  check(created, {
    "create status is 201": (res) => res.status === 201,
  });

  if (created.status !== 201 || !beforeProduct || !beforeSlot) {
    sleep(THINK_TIME_SECONDS);
    return;
  }

  const afterCreateProduct = findProduct(listProducts(), product.id);
  const afterCreateSlot = findSlot(listSlotsForDate(slot.slotDate), slot.id);

  check(afterCreateProduct, {
    "product stock decremented on create": (item) =>
      Boolean(item) && item.stock === beforeProduct.stock - RESERVATION_QUANTITY,
  });
  check(afterCreateSlot, {
    "slot capacity decremented on create": (item) =>
      Boolean(item) && item.remainingCapacity === beforeSlot.remainingCapacity - 1,
  });

  const reservation = created.json();
  const cancelled = http.post(`${BASE_URL}/pickup-reservations/${reservation.id}/cancel`, null, authHeaders);

  if (cancelled.status === 200) {
    cancel200.add(1);
  } else if (cancelled.status >= 500) {
    status5xx.add(1);
  }

  check(cancelled, {
    "cancel status is 200": (res) => res.status === 200,
  });

  if (cancelled.status !== 200) {
    sleep(THINK_TIME_SECONDS);
    return;
  }

  const afterCancelProduct = findProduct(listProducts(), product.id);
  const afterCancelSlot = findSlot(listSlotsForDate(slot.slotDate), slot.id);

  check(afterCancelProduct, {
    "product stock restored on cancel": (item) => Boolean(item) && item.stock === beforeProduct.stock,
  });
  check(afterCancelSlot, {
    "slot capacity restored on cancel": (item) =>
      Boolean(item) && item.remainingCapacity === beforeSlot.remainingCapacity,
  });

  const rereserved = http.post(`${BASE_URL}/pickup-reservations`, payload, headers);

  if (rereserved.status === 201) {
    rereserve201.add(1);
  } else if (rereserved.status === 409) {
    status409.add(1);
  } else if (rereserved.status >= 500) {
    status5xx.add(1);
  }

  check(rereserved, {
    "rereserve status is 201": (res) => res.status === 201,
  });

  if (rereserved.status === 201) {
    const rereservation = rereserved.json();
    const finalCancel = http.post(`${BASE_URL}/pickup-reservations/${rereservation.id}/cancel`, null, authHeaders);

    if (finalCancel.status === 200) {
      cancel200.add(1);
    } else if (finalCancel.status >= 500) {
      status5xx.add(1);
    }

    check(finalCancel, {
      "final cancel status is 200": (res) => res.status === 200,
    });
  }

  sleep(THINK_TIME_SECONDS);
}
