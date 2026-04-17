import type {
  DemoUser,
  PickupReservation,
  PickupSlot,
  Product,
  ProductStatus,
  Store,
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ message: "요청 처리에 실패했습니다." }))) as {
      message?: string;
    };
    throw new Error(payload.message ?? "요청 처리에 실패했습니다.");
  }

  return response.json() as Promise<T>;
}

export const api = {
  listStores: () => request<Store[]>("/stores"),
  listDemoUsers: () => request<DemoUser[]>("/demo-users"),
  listProducts: (storeId: string) => request<Product[]>(`/stores/${storeId}/products`),
  createProduct: (storeId: string, actorId: string, payload: {
    sku: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    status: ProductStatus;
  }) =>
    request<Product>(`/stores/${storeId}/products`, {
      method: "POST",
      headers: { "x-user-id": actorId },
      body: JSON.stringify(payload),
    }),
  updateProduct: (
    storeId: string,
    productId: string,
    actorId: string,
    payload: Partial<{
      name: string;
      description: string;
      price: number;
      stock: number;
      status: ProductStatus;
    }>,
  ) =>
    request<Product>(`/stores/${storeId}/products/${productId}`, {
      method: "PATCH",
      headers: { "x-user-id": actorId },
      body: JSON.stringify(payload),
    }),
  listPickupSlots: (storeId: string, date: string) =>
    request<PickupSlot[]>(`/stores/${storeId}/pickup-slots?date=${date}`),
  createReservation: (
    actorId: string,
    payload: {
      storeId: string;
      productId: string;
      slotId: string;
      quantity: number;
    },
  ) =>
    request<PickupReservation>("/pickup-reservations", {
      method: "POST",
      headers: { "x-user-id": actorId },
      body: JSON.stringify(payload),
    }),
  listReservations: (storeId: string, actorId: string, date: string) =>
    request<PickupReservation[]>(`/stores/${storeId}/reservations?date=${date}`, {
      headers: { "x-user-id": actorId },
    }),
  updateReservationStatus: (
    reservationId: string,
    actorId: string,
    status: "READY" | "PICKED_UP" | "NO_SHOW",
  ) =>
    request<PickupReservation>(`/pickup-reservations/${reservationId}/status`, {
      method: "PATCH",
      headers: { "x-user-id": actorId },
      body: JSON.stringify({ status }),
    }),
  cancelReservation: (reservationId: string, actorId: string) =>
    request<PickupReservation>(`/pickup-reservations/${reservationId}/cancel`, {
      method: "POST",
      headers: { "x-user-id": actorId },
    }),
};
