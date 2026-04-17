import { randomUUID } from "node:crypto";

import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { buildSeedData } from "./mock-data.js";
import type { MarketplaceStore } from "./store.js";
import type {
  CreateProductInput,
  CreateReservationInput,
  DemoUser,
  PickupReservation,
  PickupSlot,
  Product,
  ReservationStatus,
  UpdateProductInput,
  UpdateReservationStatusInput,
} from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertSeller(actor: DemoUser, storeId: string): void {
  if (actor.role !== "seller") {
    throw forbidden("판매자 계정이 필요합니다.");
  }
  if (actor.storeId !== storeId) {
    throw forbidden("판매자는 자신의 매장만 접근할 수 있습니다.");
  }
}

function assertCustomer(actor: DemoUser): void {
  if (actor.role !== "customer") {
    throw forbidden("고객 계정이 필요합니다.");
  }
}

function reservationStatusLabel(status: ReservationStatus): string {
  const labels: Record<ReservationStatus, string> = {
    RESERVED: "예약 완료",
    READY: "픽업 준비",
    PICKED_UP: "수령 완료",
    CANCELLED: "예약 취소",
    NO_SHOW: "미수령",
  };

  return labels[status];
}

function assertProductStatusTransition(current: ReservationStatus, next: UpdateReservationStatusInput["status"]): void {
  const allowed: Record<ReservationStatus, UpdateReservationStatusInput["status"][]> = {
    RESERVED: ["READY", "NO_SHOW"],
    READY: ["PICKED_UP", "NO_SHOW"],
    PICKED_UP: [],
    CANCELLED: [],
    NO_SHOW: [],
  };

  if (!allowed[current].includes(next)) {
    throw badRequest(`예약 상태를 ${reservationStatusLabel(current)}에서 ${reservationStatusLabel(next)}(으)로 변경할 수 없습니다.`);
  }
}

function buildReservationDetails(
  reservation: Omit<PickupReservation, "storeName" | "productName" | "customerName" | "slotDate" | "startTime" | "endTime">,
  products: Product[],
  slots: PickupSlot[],
  users: DemoUser[],
) {
  const product = products.find((item) => item.id === reservation.productId);
  const slot = slots.find((item) => item.id === reservation.slotId);
  const customer = users.find((item) => item.id === reservation.customerId);
  const storeId = reservation.storeId;

  if (!product || !slot || !customer) {
    throw notFound("예약에 연결된 데이터를 찾을 수 없습니다.");
  }

  return {
    ...reservation,
    storeName: storeId,
    productName: product.name,
    customerName: customer.name,
    slotDate: slot.slotDate,
    startTime: slot.startTime,
    endTime: slot.endTime,
  } satisfies PickupReservation;
}

export class MemoryMarketplaceStore implements MarketplaceStore {
  private readonly stores;
  private readonly users;
  private readonly products;
  private readonly slots;
  private readonly reservations;

  constructor() {
    const seed = buildSeedData();
    this.stores = seed.stores;
    this.users = seed.users;
    this.products = seed.products;
    this.slots = seed.slots;
    this.reservations = seed.reservations.map((reservation) => {
      const store = this.stores.find((item) => item.id === reservation.storeId);
      return {
        ...reservation,
        storeName: store?.name ?? reservation.storeId,
      };
    });

    for (const reservation of this.reservations) {
      const slot = this.slots.find((item) => item.id === reservation.slotId);
      if (slot) {
        slot.remainingCapacity -= 1;
      }
      const product = this.products.find((item) => item.id === reservation.productId);
      if (product) {
        product.stock -= reservation.quantity;
      }
    }
  }

  async listStores() {
    return clone(this.stores);
  }

  async listDemoUsers() {
    return clone(this.users);
  }

  async getUserById(id: string) {
    return clone(this.users.find((user) => user.id === id) ?? null);
  }

  async listProducts(storeId: string) {
    return clone(
      this.products
        .filter((product) => product.storeId === storeId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async createProduct(actor: DemoUser, storeId: string, input: CreateProductInput) {
    assertSeller(actor, storeId);

    if (this.products.some((product) => product.storeId === storeId && product.sku === input.sku)) {
      throw conflict("이 매장에는 이미 같은 SKU가 있습니다.");
    }

    const timestamp = new Date().toISOString();
    const product: Product = {
      id: randomUUID(),
      storeId,
      sku: input.sku,
      name: input.name,
      description: input.description,
      price: input.price,
      stock: input.stock,
      status: input.status,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.products.push(product);
    return clone(product);
  }

  async updateProduct(actor: DemoUser, storeId: string, productId: string, input: UpdateProductInput) {
    assertSeller(actor, storeId);

    const product = this.products.find((item) => item.id === productId && item.storeId === storeId);
    if (!product) {
      throw notFound("상품 정보를 찾을 수 없습니다.");
    }

    Object.assign(product, input, { updatedAt: new Date().toISOString() });
    return clone(product);
  }

  async listPickupSlots(storeId: string, date: string) {
    return clone(
      this.slots
        .filter((slot) => slot.storeId === storeId && slot.slotDate === date)
        .sort((left, right) => left.startTime.localeCompare(right.startTime)),
    );
  }

  async createReservation(actor: DemoUser, input: CreateReservationInput) {
    assertCustomer(actor);

    const product = this.products.find((item) => item.id === input.productId);
    if (!product || product.storeId !== input.storeId) {
      throw notFound("해당 매장에서 상품 정보를 찾을 수 없습니다.");
    }
    if (product.status !== "ACTIVE") {
      throw badRequest("판매중인 상품만 예약할 수 있습니다.");
    }
    if (product.stock < input.quantity) {
      throw conflict("예약 가능한 재고가 부족합니다.");
    }

    const slot = this.slots.find((item) => item.id === input.slotId);
    if (!slot || slot.storeId !== input.storeId) {
      throw notFound("해당 매장에서 픽업 슬롯을 찾을 수 없습니다.");
    }
    if (slot.remainingCapacity < 1) {
      throw conflict("선택한 픽업 슬롯은 마감되었습니다.");
    }

    product.stock -= input.quantity;
    slot.remainingCapacity -= 1;

    const store = this.stores.find((item) => item.id === input.storeId);
    if (!store) {
      throw notFound("매장 정보를 찾을 수 없습니다.");
    }

    const timestamp = new Date().toISOString();
    const reservation: PickupReservation = {
      id: randomUUID(),
      storeId: input.storeId,
      productId: input.productId,
      slotId: input.slotId,
      customerId: actor.id,
      quantity: input.quantity,
      pickupCode: `PK-${Math.floor(Math.random() * 9000) + 1000}`,
      status: "RESERVED",
      createdAt: timestamp,
      updatedAt: timestamp,
      storeName: store.name,
      productName: product.name,
      customerName: actor.name,
      slotDate: slot.slotDate,
      startTime: slot.startTime,
      endTime: slot.endTime,
    };

    this.reservations.push(reservation);
    return clone(reservation);
  }

  async listReservations(actor: DemoUser, storeId: string, date?: string) {
    assertSeller(actor, storeId);

    return clone(
      this.reservations
        .filter((reservation) => reservation.storeId === storeId && (!date || reservation.slotDate === date))
        .sort((left, right) => left.slotDate.localeCompare(right.slotDate) || left.startTime.localeCompare(right.startTime)),
    );
  }

  async updateReservationStatus(actor: DemoUser, reservationId: string, input: UpdateReservationStatusInput) {
    const reservation = this.reservations.find((item) => item.id === reservationId);
    if (!reservation) {
      throw notFound("예약 정보를 찾을 수 없습니다.");
    }
    assertSeller(actor, reservation.storeId);

    assertProductStatusTransition(reservation.status, input.status);
    reservation.status = input.status;
    reservation.updatedAt = new Date().toISOString();

    return clone(reservation);
  }

  async cancelReservation(actor: DemoUser, reservationId: string) {
    assertCustomer(actor);

    const reservation = this.reservations.find((item) => item.id === reservationId);
    if (!reservation) {
      throw notFound("예약 정보를 찾을 수 없습니다.");
    }
    if (reservation.customerId !== actor.id) {
      throw forbidden("고객은 본인 예약만 취소할 수 있습니다.");
    }
    if (!["RESERVED", "READY"].includes(reservation.status)) {
      throw badRequest("예약 완료 또는 픽업 준비 상태에서만 취소할 수 있습니다.");
    }

    const product = this.products.find((item) => item.id === reservation.productId);
    const slot = this.slots.find((item) => item.id === reservation.slotId);
    if (!product || !slot) {
      throw notFound("예약에 연결된 데이터를 찾을 수 없습니다.");
    }

    product.stock += reservation.quantity;
    slot.remainingCapacity += 1;
    reservation.status = "CANCELLED";
    reservation.updatedAt = new Date().toISOString();

    return clone(reservation);
  }

  async disconnect() {}
}
