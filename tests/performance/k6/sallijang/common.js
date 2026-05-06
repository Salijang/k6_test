import http from "k6/http";
import { Counter } from "k6/metrics";

export const RUN_PREFIX = __ENV.K6_RUN_PREFIX ?? `${Date.now()}`;
export const TESTID = __ENV.K6_TESTID ?? `sallijang-${RUN_PREFIX}`;

export const PRODUCT_BASE_URL =
  __ENV.K6_BASE_URL_PRODUCT || __ENV.K6_BASE_URL || "http://product-service";
export const ORDER_BASE_URL =
  __ENV.K6_BASE_URL_ORDER || __ENV.K6_BASE_URL || "http://order-service";

export const STORE_ID = Number(__ENV.K6_STORE_ID ?? "0");
export const STORE_NAME = __ENV.K6_STORE_NAME ?? "Stress Test Store";

export const GEO_CENTER_LAT = Number(__ENV.K6_GEO_CENTER_LAT ?? "37.5665");
export const GEO_CENTER_LNG = Number(__ENV.K6_GEO_CENTER_LNG ?? "126.9780");
export const GEO_RADIUS = Number(__ENV.K6_GEO_RADIUS ?? "0.1");

export const PRODUCT_LIMIT = Number(__ENV.K6_PRODUCT_LIMIT ?? "20");
export const PRODUCT_MAX_OFFSET = Number(__ENV.K6_PRODUCT_MAX_OFFSET ?? "60");
export const PRODUCT_CATEGORIES = (__ENV.K6_PRODUCT_CATEGORIES ?? "베이커리,과일,채소,반찬,한식,분식")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export function requireStoreId() {
  if (!STORE_ID || STORE_ID <= 0) {
    throw new Error("K6_STORE_ID 환경변수가 필수다. 양의 정수 store id 를 넣어야 한다.");
  }
}

export function jsonHeaders(extra = {}) {
  return headersWithAccessToken(extra, pickAccessToken());
}

export function headersWithAccessToken(extra = {}, accessToken = "") {
  const headers = {
    "Content-Type": "application/json",
    ...extra,
  };

  if (__ENV.K6_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${__ENV.K6_AUTH_TOKEN}`;
  }

  if (accessToken) {
    headers.Cookie = `access_token=${accessToken}`;
  }

  if (__ENV.K6_AUTH_HEADER_NAME && __ENV.K6_AUTH_HEADER_VALUE) {
    headers[__ENV.K6_AUTH_HEADER_NAME] = __ENV.K6_AUTH_HEADER_VALUE;
  }

  return { headers };
}

function pickTokenFromCsv(csvValue) {
  const tokens = (csvValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return "";
  }

  return tokens[(__VU - 1) % tokens.length];
}

export function pickAccessToken() {
  const tokenFromPool = pickTokenFromCsv(__ENV.K6_ACCESS_TOKENS);
  if (tokenFromPool) {
    return tokenFromPool;
  }
  return __ENV.K6_ACCESS_TOKEN || __ENV.K6_AUTH_TOKEN || "";
}

export function pickSellerAccessToken() {
  return __ENV.K6_SELLER_ACCESS_TOKEN || pickAccessToken();
}

export function pickBuyerAccessToken() {
  const tokenFromPool = pickTokenFromCsv(__ENV.K6_BUYER_ACCESS_TOKENS);
  if (tokenFromPool) {
    return tokenFromPool;
  }
  return __ENV.K6_BUYER_ACCESS_TOKEN || pickAccessToken();
}

export function requestOptions(endpoint, extraHeaders = {}, accessToken = pickAccessToken()) {
  const params = headersWithAccessToken(extraHeaders, accessToken);
  if (endpoint) {
    params.tags = { endpoint };
  }
  return params;
}

export function sellerRequestOptions(endpoint, extraHeaders = {}) {
  return requestOptions(endpoint, extraHeaders, pickSellerAccessToken());
}

export function buyerRequestOptions(endpoint, extraHeaders = {}) {
  return requestOptions(endpoint, extraHeaders, pickBuyerAccessToken());
}

export function buildQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

export function pickGeo() {
  const dLat = (Math.random() * 2 - 1) * GEO_RADIUS;
  const dLng = (Math.random() * 2 - 1) * GEO_RADIUS;
  return {
    lat: GEO_CENTER_LAT + dLat,
    lng: GEO_CENTER_LNG + dLng,
  };
}

export function pickOffset(limit = PRODUCT_LIMIT, maxOffset = PRODUCT_MAX_OFFSET) {
  const stepCount = Math.floor(maxOffset / limit) + 1;
  return Math.floor(Math.random() * stepCount) * limit;
}

export function pickCategory(categories = PRODUCT_CATEGORIES) {
  if (categories.length === 0) {
    return null;
  }
  return categories[Math.floor(Math.random() * categories.length)];
}

export function productListUrl({
  category,
  limit = PRODUCT_LIMIT,
  offset = pickOffset(limit),
  lat,
  lng,
} = {}) {
  const geo = lat === undefined || lng === undefined ? pickGeo() : { lat, lng };
  const query = buildQuery({
    user_lat: Number(geo.lat).toFixed(6),
    user_lng: Number(geo.lng).toFixed(6),
    limit,
    offset,
    category,
  });

  return `${PRODUCT_BASE_URL}/api/v1/products/?${query}`;
}

export function buildProductPayload({
  index,
  namePrefix = "k6-product",
  remaining = Number(__ENV.K6_PRODUCT_REMAINING_INIT ?? "100000"),
  unitPrice = Number(__ENV.K6_UNIT_PRICE ?? "8000"),
  category = __ENV.K6_PRODUCT_CATEGORY ?? "베이커리",
} = {}) {
  return {
    name: `${namePrefix}-${RUN_PREFIX}-${index}`,
    original_price: 10000,
    discount_price: unitPrice,
    remaining,
    total_quantity: remaining,
    expiry_minutes: 60,
    pickup_deadline: null,
    category,
    image_url: null,
    weight: null,
    description: "k6 generated product",
    is_deleted: false,
  };
}

export function createProduct(index, options = {}) {
  requireStoreId();

  const response = http.post(
    `${PRODUCT_BASE_URL}/api/v1/products/?store_id=${STORE_ID}`,
    JSON.stringify(buildProductPayload({ index, ...options })),
    sellerRequestOptions("product_create"),
  );

  if (response.status !== 201) {
    throw new Error(`상품 생성 실패: index=${index} status=${response.status} body=${response.body}`);
  }

  const product = response.json();
  if (!product || typeof product.id !== "number") {
    throw new Error(`상품 생성 응답 파싱 실패: index=${index} body=${response.body}`);
  }

  return product;
}

export function createProductPool(size, options = {}) {
  const products = [];

  try {
    for (let i = 0; i < size; i += 1) {
      products.push(createProduct(i, options));
    }
  } catch (error) {
    deleteProductsBestEffort(products.map((product) => product.id), "setup rollback");
    throw error;
  }

  return products;
}

export function deleteProductsBestEffort(productIds, reason = "cleanup") {
  for (const productId of productIds) {
    const response = http.del(
      `${PRODUCT_BASE_URL}/api/v1/products/${productId}`,
      null,
      sellerRequestOptions("product_delete"),
    );
    if (response.status !== 204 && response.status !== 404) {
      console.warn(`${reason} 실패: productId=${productId} status=${response.status}`);
    }
  }
}

export function parseProductIdsFromEnv() {
  return (__ENV.K6_PRODUCT_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function buildOrderPayload({ productId, productName }) {
  const itemQuantity = Number(__ENV.K6_ITEM_QUANTITY ?? "1");
  const unitPrice = Number(__ENV.K6_UNIT_PRICE ?? "8000");

  return {
    store_id: STORE_ID,
    store_name: STORE_NAME,
    payment_method: __ENV.K6_PAYMENT_METHOD ?? "toss",
    total_price: unitPrice * itemQuantity,
    pickup_expected_at: __ENV.K6_PICKUP_EXPECTED_AT ?? "18:00",
    items: [
      {
        product_id: productId,
        product_name: productName,
        quantity: itemQuantity,
        unit_price: unitPrice,
      },
    ],
  };
}

export function buildStatusCounters(prefix) {
  return {
    status2xx: new Counter(`${prefix}_status_2xx`),
    status4xx: new Counter(`${prefix}_status_4xx`),
    status5xx: new Counter(`${prefix}_status_5xx`),
    statusOther: new Counter(`${prefix}_status_other`),
  };
}

export function addStatus(counters, response) {
  if (response.status >= 200 && response.status < 300) {
    counters.status2xx.add(1);
  } else if (response.status >= 400 && response.status < 500) {
    counters.status4xx.add(1);
  } else if (response.status >= 500) {
    counters.status5xx.add(1);
  } else {
    counters.statusOther.add(1);
  }
}

export function parseStages(defaultStages) {
  if (!__ENV.K6_STAGES_JSON) {
    return defaultStages;
  }
  return JSON.parse(__ENV.K6_STAGES_JSON);
}
