import http from "k6/http";
import { check } from "k6";

export const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:14000";
export const STORE_ID = __ENV.K6_STORE_ID || "store-seoul-central";
export const SELLER_ID = __ENV.K6_SELLER_ID || "seller-seoul-central";
export const CUSTOMER_ID = __ENV.K6_CUSTOMER_ID || "customer-minji";
export const CUSTOMER_IDS = (__ENV.K6_CUSTOMER_IDS ??
  "customer-minji,customer-jisoo,customer-junho,customer-seoyeon")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export function today() {
  return dayWithOffset(0);
}

export function dayWithOffset(offsetDays = 0) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

export function sellerHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": SELLER_ID,
    },
  };
}

export function customerHeaders(customerId = CUSTOMER_ID) {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": customerId,
    },
  };
}

export function customerAuthHeaders(customerId = CUSTOMER_ID) {
  return {
    headers: {
      "x-user-id": customerId,
    },
  };
}

export function listProducts() {
  const response = http.get(`${BASE_URL}/stores/${STORE_ID}/products`);
  check(response, {
    "list products status is 200": (res) => res.status === 200,
  });
  return response.json();
}

export function listSlotsForDate(date) {
  const response = http.get(`${BASE_URL}/stores/${STORE_ID}/pickup-slots?date=${date}`);
  check(response, {
    "list slots status is 200": (res) => res.status === 200,
  });
  return response.json();
}

export function listSlots() {
  return listSlotsForDate(today());
}
