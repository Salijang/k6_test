import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Gauge } from "k6/metrics";

import {
  ORDER_BASE_URL,
  PRODUCT_BASE_URL,
  RUN_PREFIX,
  STORE_ID,
  STORE_NAME,
  TESTID,
  buildOrderPayload,
  buyerRequestOptions,
  createProductPool,
  deleteProductsBestEffort,
  getProduct,
  listStoreOrders,
  parseProductIdsFromEnv,
  requireStoreId,
} from "./common.js";

const RATE = Number(__ENV.K6_HOT_ORDER_RATE ?? "20");
const DURATION = __ENV.K6_HOT_ORDER_DURATION ?? "2m";
const PREALLOCATED_VUS = Number(__ENV.K6_PREALLOCATED_VUS ?? "80");
const MAX_VUS = Number(__ENV.K6_MAX_VUS ?? "500");
const POOL_SIZE = Number(__ENV.K6_HOT_PRODUCT_POOL_SIZE ?? "1");
const HOT_PRODUCT_STOCK = Number(__ENV.K6_HOT_PRODUCT_STOCK ?? "300");
const ITEM_QUANTITY = Number(__ENV.K6_ITEM_QUANTITY ?? "1");
const P95_THRESHOLD = __ENV.K6_HOT_ORDER_P95_THRESHOLD ?? "3000";
const SAGA_SETTLE_SECONDS = Number(__ENV.K6_HOT_ORDER_SAGA_SETTLE_SECONDS ?? "10");

const status201 = new Counter("order_hot_product_status_201");
const status409 = new Counter("order_hot_product_status_409");
const status4xx = new Counter("order_hot_product_status_4xx");
const status503 = new Counter("order_hot_product_status_503");
const status5xx = new Counter("order_hot_product_status_5xx");
const statusOther = new Counter("order_hot_product_status_other");
const createdOrders = new Counter("order_hot_product_created_orders");
const finalRemaining = new Gauge("order_hot_product_final_remaining");
const activeOrderCount = new Gauge("order_hot_product_active_order_count");

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

export const options = {
  thresholds: {
    checks: ["rate>0.99"],
    "http_req_failed{endpoint:order_create_hot_product}": ["rate<0.01"],
    "http_req_duration{endpoint:order_create_hot_product}": [`p(95)<${P95_THRESHOLD}`],
    order_hot_product_status_5xx: ["count==0"],
  },
  scenarios: {
    order_hot_product_race: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  tags: { testid: TESTID, scenario: "order-hot-product-race" },
};

function productDataFromEnv() {
  return parseProductIdsFromEnv().map((id) => ({
    id,
    name: `k6-hot-product-${id}`,
  }));
}

function productIds(products) {
  return products.map((product) => product.id);
}

function orderHasHotProduct(order, hotProductIds) {
  return (order.items ?? []).some((item) => hotProductIds.includes(item.product_id));
}

export function setup() {
  requireStoreId();

  const configuredProducts = productDataFromEnv();
  const products =
    configuredProducts.length > 0
      ? configuredProducts
      : createProductPool(POOL_SIZE, {
          namePrefix: "hot-order-product",
          remaining: HOT_PRODUCT_STOCK,
        });

  console.log(
    `order-hot-product-race orderBase=${ORDER_BASE_URL} productBase=${PRODUCT_BASE_URL} testid=${TESTID} ` +
      `storeId=${STORE_ID} storeName="${STORE_NAME}" rate=${RATE}/s duration=${DURATION} ` +
      `productPool=${products.length} stockPerProduct=${HOT_PRODUCT_STOCK} itemQuantity=${ITEM_QUANTITY} ` +
      `preAllocatedVUs=${PREALLOCATED_VUS} maxVUs=${MAX_VUS} externalProducts=${configuredProducts.length > 0}`,
  );

  return {
    products,
    shouldCleanupProducts: configuredProducts.length === 0,
    initialStockPerProduct: HOT_PRODUCT_STOCK,
  };
}

export default function (data) {
  const product = data.products[Math.floor(Math.random() * data.products.length)];
  const response = http.post(
    `${ORDER_BASE_URL}/api/v1/orders/`,
    JSON.stringify(
      buildOrderPayload({
        productId: product.id,
        productName: product.name,
      }),
    ),
    buyerRequestOptions("order_create_hot_product"),
  );

  if (response.status === 201) {
    status201.add(1);
    createdOrders.add(1);
  } else if (response.status === 409) {
    status409.add(1);
  } else if (response.status === 503) {
    status503.add(1);
  } else if (response.status >= 500) {
    status5xx.add(1);
  } else if (response.status >= 400) {
    status4xx.add(1);
  } else {
    statusOther.add(1);
  }

  check(response, {
    "hot order status is expected": (res) => [201, 409, 503].includes(res.status) || res.status >= 500,
    "hot order has order number when created": (res) =>
      res.status !== 201 || ((res.json() ?? {}).order_number ?? "").length > 0,
    "hot order never 5xx": (res) => res.status < 500,
  });
}

export function teardown(data) {
  if (!data || !Array.isArray(data.products)) {
    return;
  }

  if (SAGA_SETTLE_SECONDS > 0) {
    sleep(SAGA_SETTLE_SECONDS);
  }

  const ids = productIds(data.products);
  let totalRemaining = 0;

  for (const product of data.products) {
    const latest = getProduct(product.id);
    totalRemaining += latest.remaining ?? 0;
    check(latest, {
      "hot product remaining is never negative": (item) => (item.remaining ?? -1) >= 0,
      "hot product remaining does not exceed initial stock": (item) =>
        (item.remaining ?? Number.POSITIVE_INFINITY) <= data.initialStockPerProduct,
    });
  }

  finalRemaining.add(totalRemaining);

  const orders = listStoreOrders();
  const activeOrders = orders.filter(
    (order) => order.status !== "cancelled" && orderHasHotProduct(order, ids),
  );
  const activeQuantity = activeOrders.reduce(
    (sum, order) =>
      sum +
      (order.items ?? [])
        .filter((item) => ids.includes(item.product_id))
        .reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const maxReservableQuantity = data.initialStockPerProduct * data.products.length;

  activeOrderCount.add(activeOrders.length);

  check(activeOrders, {
    "active hot product orders do not exceed stock": () => activeQuantity <= maxReservableQuantity,
  });

  if (data.shouldCleanupProducts) {
    deleteProductsBestEffort(ids, "hot order cleanup");
  } else {
    console.log("외부 주입 상품을 사용했으므로 상품 정리는 건너뜁니다.");
  }
}
