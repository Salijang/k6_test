import http from "k6/http";
import { check } from "k6";

import {
  ORDER_BASE_URL,
  PRODUCT_BASE_URL,
  RUN_PREFIX,
  STORE_ID,
  TESTID,
  buildOrderPayload,
  buyerRequestOptions,
  createProduct,
  deleteProductsBestEffort,
  productListUrl,
  requestOptions,
} from "./common.js";

const RUN_WRITE_SMOKE = __ENV.K6_SMOKE_WRITE === "1";
const RUN_ORDER_SMOKE = __ENV.K6_SMOKE_ORDER === "1";
const PRODUCT_HEALTH_PATH = __ENV.K6_PRODUCT_HEALTH_PATH ?? "";
const ORDER_HEALTH_PATH = __ENV.K6_ORDER_HEALTH_PATH ?? "";

export const options = {
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<1000"],
  },
  scenarios: {
    smoke: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "30s",
    },
  },
  tags: { testid: TESTID, scenario: "sallijang-smoke" },
};

function checkOptionalHealth(baseUrl, path, label) {
  if (!path) {
    return;
  }

  const response = http.get(`${baseUrl}${path}`, requestOptions(`${label}_health`));
  check(response, {
    [`${label} health is 2xx`]: (res) => res.status >= 200 && res.status < 300,
  });
}

export default function () {
  console.log(
    `sallijang-smoke testid=${TESTID} productBase=${PRODUCT_BASE_URL} orderBase=${ORDER_BASE_URL} ` +
      `writeSmoke=${RUN_WRITE_SMOKE} orderSmoke=${RUN_ORDER_SMOKE}`,
  );

  checkOptionalHealth(PRODUCT_BASE_URL, PRODUCT_HEALTH_PATH, "product");
  checkOptionalHealth(ORDER_BASE_URL, ORDER_HEALTH_PATH, "order");

  const listResponse = http.get(productListUrl({ offset: 0 }), requestOptions("product_list"));
  check(listResponse, {
    "product list returns 200": (res) => res.status === 200,
    "product list body is array": (res) => res.status !== 200 || Array.isArray(res.json()),
  });

  if (!RUN_WRITE_SMOKE) {
    return;
  }

  const product = createProduct(0, {
    namePrefix: "smoke-product",
    remaining: Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "1000"),
  });

  check(product, {
    "write smoke product created": (value) => typeof value.id === "number" && value.id > 0,
  });

  if (RUN_ORDER_SMOKE) {
    const orderResponse = http.post(
      `${ORDER_BASE_URL}/api/v1/orders/`,
      JSON.stringify(
        buildOrderPayload({
          productId: product.id,
          productName: product.name ?? `smoke-product-${RUN_PREFIX}`,
        }),
      ),
      buyerRequestOptions("order_create"),
    );

    check(orderResponse, {
      "order smoke returns 201": (res) => res.status === 201,
      "order smoke has order number": (res) =>
        res.status !== 201 || ((res.json() ?? {}).order_number ?? "").length > 0,
    });
  }

  if (STORE_ID > 0) {
    deleteProductsBestEffort([product.id], "smoke cleanup");
  }
}
