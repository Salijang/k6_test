import http from "k6/http";
import { check } from "k6";

export const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:4000";
export const STORE_ID = __ENV.K6_STORE_ID || "store-seoul-central";
export const SELLER_ID = __ENV.K6_SELLER_ID || "seller-seoul-central";
export const CUSTOMER_ID = __ENV.K6_CUSTOMER_ID || "customer-minji";

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function sellerHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": SELLER_ID,
    },
  };
}

export function customerHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": CUSTOMER_ID,
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

export function listSlots() {
  const response = http.get(`${BASE_URL}/stores/${STORE_ID}/pickup-slots?date=${today()}`);
  check(response, {
    "list slots status is 200": (res) => res.status === 200,
  });
  return response.json();
}

