// Seller-side reservation lifecycle flow covering READY, PICKED_UP, and NO_SHOW transitions.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  BASE_URL,
  CUSTOMER_IDS,
  STORE_ID,
  customerHeaders,
  dayWithOffset,
  listReservationsForDate,
  listSlotsForDate,
  sellerHeaders,
} from "./common.js";

const STATUS_VUS = Number(__ENV.K6_STATUS_VUS ?? "10");
const STATUS_ITERATIONS = Number(__ENV.K6_STATUS_ITERATIONS ?? "10");
const MAX_DURATION = __ENV.K6_STATUS_MAX_DURATION ?? "1m";
const THINK_TIME_SECONDS = Number(__ENV.K6_STATUS_THINK_TIME ?? "1");
const RESERVATION_QUANTITY = Number(__ENV.K6_STATUS_RESERVATION_QUANTITY ?? "1");
const RUN_PREFIX = __ENV.K6_STATUS_RUN_PREFIX ?? `${Date.now()}`;
const INCLUDE_NO_SHOW = (__ENV.K6_STATUS_INCLUDE_NO_SHOW ?? "1") !== "0";

const create201 = new Counter("status_flow_create_201");
const ready200 = new Counter("status_flow_ready_200");
const picked200 = new Counter("status_flow_picked_200");
const noShow200 = new Counter("status_flow_no_show_200");
const status409 = new Counter("status_flow_status_409");
const status5xx = new Counter("status_flow_status_5xx");

export const options = {
  thresholds: {
    checks: ["rate==1"],
    status_flow_status_409: ["count==0"],
    status_flow_status_5xx: ["count==0"],
    http_req_duration: ["p(95)<2000"],
  },
  scenarios: {
    reservation_status_flow: {
      executor: "per-vu-iterations",
      vus: STATUS_VUS,
      iterations: STATUS_ITERATIONS,
      maxDuration: MAX_DURATION,
    },
  },
};

export function setup() {
  if (STATUS_VUS > 14) {
    throw new Error("reservation-status-flow requires 14 or fewer VUs to map one future date per VU.");
  }

  const products = Array.from({ length: STATUS_VUS }, (_, index) => {
    const response = http.post(
      `${BASE_URL}/stores/${STORE_ID}/products`,
      JSON.stringify({
        sku: `STATUS-FLOW-${RUN_PREFIX}-${index + 1}`,
        name: `Status Flow Product ${index + 1}`,
        description: "k6 dedicated product for reservation status flow",
        price: 12000 + index,
        stock: STATUS_ITERATIONS * RESERVATION_QUANTITY * 2,
        status: "ACTIVE",
      }),
      sellerHeaders(),
    );

    check(response, {
      "status flow setup product status is 201": (res) => res.status === 201,
    });

    if (response.status !== 201) {
      throw new Error(`failed to create dedicated status-flow product for VU ${index + 1}: ${response.status}`);
    }

    return response.json();
  });

  const slotAssignments = Array.from({ length: STATUS_VUS }, (_, index) => {
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
  const customerId = CUSTOMER_IDS[(__ITER + vuIndex) % CUSTOMER_IDS.length];
  const useNoShowBranch = INCLUDE_NO_SHOW && (__ITER + vuIndex) % 2 === 1;

  const created = http.post(
    `${BASE_URL}/pickup-reservations`,
    JSON.stringify({
      storeId: STORE_ID,
      productId: product.id,
      slotId: slot.id,
      quantity: RESERVATION_QUANTITY,
    }),
    customerHeaders(customerId),
  );

  if (created.status === 201) {
    create201.add(1);
  } else if (created.status === 409) {
    status409.add(1);
  } else if (created.status >= 500) {
    status5xx.add(1);
  }

  check(created, {
    "status flow create status is 201": (res) => res.status === 201,
  });

  if (created.status !== 201) {
    sleep(THINK_TIME_SECONDS);
    return;
  }

  const reservation = created.json();
  const reservationsAfterCreate = listReservationsForDate(slotAssignment.slotDate);

  check(reservationsAfterCreate, {
    "status flow reservation visible after create": (items) =>
      items.some((item) => item.id === reservation.id && item.status === "RESERVED"),
  });

  if (useNoShowBranch) {
    const noShow = http.patch(
      `${BASE_URL}/pickup-reservations/${reservation.id}/status`,
      JSON.stringify({ status: "NO_SHOW" }),
      sellerHeaders(),
    );

    if (noShow.status === 200) {
      noShow200.add(1);
    } else if (noShow.status >= 500) {
      status5xx.add(1);
    }

    check(noShow, {
      "status flow no show status is 200": (res) => res.status === 200,
      "status flow no show body is NO_SHOW": (res) => res.status === 200 && res.json().status === "NO_SHOW",
    });

    if (noShow.status !== 200) {
      sleep(THINK_TIME_SECONDS);
      return;
    }

    const reservationsAfterNoShow = listReservationsForDate(slotAssignment.slotDate);

    check(reservationsAfterNoShow, {
      "status flow reservation visible after no show": (items) =>
        items.some((item) => item.id === reservation.id && item.status === "NO_SHOW"),
    });

    sleep(THINK_TIME_SECONDS);
    return;
  }

  const ready = http.patch(
    `${BASE_URL}/pickup-reservations/${reservation.id}/status`,
    JSON.stringify({ status: "READY" }),
    sellerHeaders(),
  );

  if (ready.status === 200) {
    ready200.add(1);
  } else if (ready.status >= 500) {
    status5xx.add(1);
  }

  check(ready, {
    "status flow ready status is 200": (res) => res.status === 200,
    "status flow ready body is READY": (res) => res.status === 200 && res.json().status === "READY",
  });

  if (ready.status !== 200) {
    sleep(THINK_TIME_SECONDS);
    return;
  }

  const pickedUp = http.patch(
    `${BASE_URL}/pickup-reservations/${reservation.id}/status`,
    JSON.stringify({ status: "PICKED_UP" }),
    sellerHeaders(),
  );

  if (pickedUp.status === 200) {
    picked200.add(1);
  } else if (pickedUp.status >= 500) {
    status5xx.add(1);
  }

  check(pickedUp, {
    "status flow picked up status is 200": (res) => res.status === 200,
    "status flow picked up body is PICKED_UP": (res) => res.status === 200 && res.json().status === "PICKED_UP",
  });

  if (pickedUp.status !== 200) {
    sleep(THINK_TIME_SECONDS);
    return;
  }

  const reservationsAfterPickup = listReservationsForDate(slotAssignment.slotDate);

  check(reservationsAfterPickup, {
    "status flow reservation visible after pickup": (items) =>
      items.some((item) => item.id === reservation.id && item.status === "PICKED_UP"),
  });

  sleep(THINK_TIME_SECONDS);
}
