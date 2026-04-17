import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { MemoryMarketplaceStore } from "./memory-store.js";

const storeId = "store-seoul-central";
const sellerId = "seller-seoul-central";
const customerId = "customer-minji";

function today() {
  return new Date().toISOString().slice(0, 10);
}

describe("pickup marketplace API", () => {
  let store: MemoryMarketplaceStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new MemoryMarketplaceStore();
    app = createApp({ store });
  });

  afterEach(async () => {
    await app.close();
  });

  it("prevents duplicate SKUs within the same store", async () => {
    const payload = {
      sku: "SEOUL-DUP-001",
      name: "Duplicate Test Product",
      description: "Created once",
      price: 10000,
      stock: 5,
      status: "ACTIVE",
    };

    const first = await app.inject({
      method: "POST",
      url: `/stores/${storeId}/products`,
      headers: { "x-user-id": sellerId },
      payload,
    });

    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/stores/${storeId}/products`,
      headers: { "x-user-id": sellerId },
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ message: "이 매장에는 이미 같은 SKU가 있습니다." });
  });

  it("stops reservations when a slot is fully booked", async () => {
    const products = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/products`,
    });
    const [product] = products.json();

    const slotsResponse = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/pickup-slots?date=${today()}`,
    });
    const [slot] = slotsResponse.json();

    for (let count = 0; count < slot.capacity; count += 1) {
      const reservation = await app.inject({
        method: "POST",
        url: "/pickup-reservations",
        headers: { "x-user-id": customerId },
        payload: {
          storeId,
          productId: product.id,
          slotId: slot.id,
          quantity: 1,
        },
      });

      expect(reservation.statusCode).toBe(201);
    }

    const overflow = await app.inject({
      method: "POST",
      url: "/pickup-reservations",
      headers: { "x-user-id": customerId },
      payload: {
        storeId,
        productId: product.id,
        slotId: slot.id,
        quantity: 1,
      },
    });

    expect(overflow.statusCode).toBe(409);
    expect(overflow.json()).toEqual({ message: "선택한 픽업 슬롯은 마감되었습니다." });
  });

  it("restores stock and slot capacity on cancellation", async () => {
    const products = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/products`,
    });
    const [product] = products.json();

    const slotsResponse = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/pickup-slots?date=${today()}`,
    });
    const [slot] = slotsResponse.json();

    const created = await app.inject({
      method: "POST",
      url: "/pickup-reservations",
      headers: { "x-user-id": customerId },
      payload: {
        storeId,
        productId: product.id,
        slotId: slot.id,
        quantity: 2,
      },
    });

    expect(created.statusCode).toBe(201);
    const reservation = created.json();

    const cancelled = await app.inject({
      method: "POST",
      url: `/pickup-reservations/${reservation.id}/cancel`,
      headers: { "x-user-id": customerId },
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("CANCELLED");

    const nextProducts = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/products`,
    });
    const restoredProduct = nextProducts.json().find((item: { id: string }) => item.id === product.id);
    expect(restoredProduct.stock).toBe(product.stock);

    const nextSlots = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/pickup-slots?date=${today()}`,
    });
    const restoredSlot = nextSlots.json().find((item: { id: string }) => item.id === slot.id);
    expect(restoredSlot.remainingCapacity).toBe(slot.remainingCapacity);
  });

  it("enforces seller status transitions", async () => {
    const products = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/products`,
    });
    const [product] = products.json();

    const slotsResponse = await app.inject({
      method: "GET",
      url: `/stores/${storeId}/pickup-slots?date=${today()}`,
    });
    const [slot] = slotsResponse.json();

    const created = await app.inject({
      method: "POST",
      url: "/pickup-reservations",
      headers: { "x-user-id": customerId },
      payload: {
        storeId,
        productId: product.id,
        slotId: slot.id,
        quantity: 1,
      },
    });
    const reservation = created.json();

    const ready = await app.inject({
      method: "PATCH",
      url: `/pickup-reservations/${reservation.id}/status`,
      headers: { "x-user-id": sellerId },
      payload: { status: "READY" },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("READY");

    const pickedUp = await app.inject({
      method: "PATCH",
      url: `/pickup-reservations/${reservation.id}/status`,
      headers: { "x-user-id": sellerId },
      payload: { status: "PICKED_UP" },
    });
    expect(pickedUp.statusCode).toBe(200);
    expect(pickedUp.json().status).toBe("PICKED_UP");

    const invalid = await app.inject({
      method: "PATCH",
      url: `/pickup-reservations/${reservation.id}/status`,
      headers: { "x-user-id": sellerId },
      payload: { status: "READY" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ message: "예약 상태를 수령 완료에서 픽업 준비(으)로 변경할 수 없습니다." });
  });
});
