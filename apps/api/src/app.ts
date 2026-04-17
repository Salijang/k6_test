import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";

import { AppError, badRequest, unauthorized } from "./errors.js";
import type { MarketplaceStore } from "./store.js";
import type {
  CreateProductInput,
  CreateReservationInput,
  DemoUser,
  ProductStatus,
  UpdateProductInput,
  UpdateReservationStatusInput,
} from "./types.js";

interface AppOptions {
  store: MarketplaceStore;
}

const fieldLabels: Record<string, string> = {
  sku: "SKU",
  name: "상품명",
  description: "설명",
  price: "가격",
  stock: "재고",
  status: "상태",
  storeId: "매장",
  productId: "상품",
  slotId: "픽업 슬롯",
  quantity: "수량",
  date: "날짜",
};

function fieldLabel(field: string): string {
  return fieldLabels[field] ?? field;
}

function isProductStatus(value: string): value is ProductStatus {
  return value === "ACTIVE" || value === "INACTIVE";
}

function isReservationStatus(value: string): value is UpdateReservationStatusInput["status"] {
  return value === "READY" || value === "PICKED_UP" || value === "NO_SHOW";
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${fieldLabel(field)} 항목은 필수입니다.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw badRequest(`${fieldLabel(field)} 항목은 숫자여야 합니다.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNumber(value, field);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`${fieldLabel(field)} 항목은 1 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const parsed = requireNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`${fieldLabel(field)} 항목은 0 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function requireDate(value: unknown): string {
  const date = requireString(value, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  }
  return date;
}

async function resolveActor(request: FastifyRequest, store: MarketplaceStore): Promise<DemoUser> {
  const actorId = request.headers["x-user-id"];
  const id = Array.isArray(actorId) ? actorId[0] : actorId;
  if (!id) {
    throw unauthorized("x-user-id 헤더가 필요합니다.");
  }
  const actor = await store.getUserById(id);
  if (!actor) {
    throw unauthorized("사용자 정보를 찾을 수 없습니다.");
  }
  return actor;
}

function parseCreateProduct(body: unknown): CreateProductInput {
  const payload = body as Record<string, unknown>;
  const status = requireString(payload.status, "status");
  if (!isProductStatus(status)) {
    throw badRequest("상품 상태 값이 올바르지 않습니다.");
  }

  return {
    sku: requireString(payload.sku, "sku"),
    name: requireString(payload.name, "name"),
    description: requireString(payload.description, "description"),
    price: requireNonNegativeInteger(payload.price, "price"),
    stock: requireNonNegativeInteger(payload.stock, "stock"),
    status,
  };
}

function parseUpdateProduct(body: unknown): UpdateProductInput {
  const payload = body as Record<string, unknown>;
  const patch: UpdateProductInput = {};

  if (payload.name !== undefined) {
    patch.name = requireString(payload.name, "name");
  }
  if (payload.description !== undefined) {
    patch.description = requireString(payload.description, "description");
  }
  if (payload.price !== undefined) {
    patch.price = requireNonNegativeInteger(payload.price, "price");
  }
  if (payload.stock !== undefined) {
    patch.stock = requireNonNegativeInteger(payload.stock, "stock");
  }
  if (payload.status !== undefined) {
    const status = requireString(payload.status, "status");
    if (!isProductStatus(status)) {
      throw badRequest("상품 상태 값이 올바르지 않습니다.");
    }
    patch.status = status;
  }

  return patch;
}

function parseCreateReservation(body: unknown): CreateReservationInput {
  const payload = body as Record<string, unknown>;
  return {
    storeId: requireString(payload.storeId, "storeId"),
    productId: requireString(payload.productId, "productId"),
    slotId: requireString(payload.slotId, "slotId"),
    quantity: requirePositiveInteger(payload.quantity, "quantity"),
  };
}

function parseUpdateReservation(body: unknown): UpdateReservationStatusInput {
  const payload = body as Record<string, unknown>;
  const status = requireString(payload.status, "status");
  if (!isReservationStatus(status)) {
    throw badRequest("예약 상태 값이 올바르지 않습니다.");
  }
  return { status };
}

export function createApp({ store }: AppOptions) {
  const app = Fastify({
    logger: false,
  });

  app.register(cors, {
    origin: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ message: error.message });
      return;
    }

    requestLogError(reply, error);
    reply.status(500).send({ message: "예상하지 못한 서버 오류가 발생했습니다." });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "k6-demo-api",
  }));

  app.get("/stores", async () => store.listStores());
  app.get("/demo-users", async () => store.listDemoUsers());

  app.get("/stores/:storeId/products", async (request) => {
    const { storeId } = request.params as { storeId: string };
    return store.listProducts(storeId);
  });

  app.post("/stores/:storeId/products", async (request, reply) => {
    const actor = await resolveActor(request, store);
    const { storeId } = request.params as { storeId: string };
    const product = await store.createProduct(actor, storeId, parseCreateProduct(request.body));
    reply.status(201).send(product);
  });

  app.patch("/stores/:storeId/products/:productId", async (request) => {
    const actor = await resolveActor(request, store);
    const { storeId, productId } = request.params as { storeId: string; productId: string };
    return store.updateProduct(actor, storeId, productId, parseUpdateProduct(request.body));
  });

  app.get("/stores/:storeId/pickup-slots", async (request) => {
    const { storeId } = request.params as { storeId: string };
    const { date } = request.query as { date?: string };
    return store.listPickupSlots(storeId, requireDate(date));
  });

  app.post("/pickup-reservations", async (request, reply) => {
    const actor = await resolveActor(request, store);
    const reservation = await store.createReservation(actor, parseCreateReservation(request.body));
    reply.status(201).send(reservation);
  });

  app.get("/stores/:storeId/reservations", async (request) => {
    const actor = await resolveActor(request, store);
    const { storeId } = request.params as { storeId: string };
    const { date } = request.query as { date?: string };
    return store.listReservations(actor, storeId, date ? requireDate(date) : undefined);
  });

  app.patch("/pickup-reservations/:id/status", async (request) => {
    const actor = await resolveActor(request, store);
    const { id } = request.params as { id: string };
    return store.updateReservationStatus(actor, id, parseUpdateReservation(request.body));
  });

  app.post("/pickup-reservations/:id/cancel", async (request) => {
    const actor = await resolveActor(request, store);
    const { id } = request.params as { id: string };
    return store.cancelReservation(actor, id);
  });

  return app;
}

function requestLogError(reply: FastifyReply, error: unknown) {
  reply.log.error(error);
}
