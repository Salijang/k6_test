export type UserRole = "seller" | "customer";
export type ProductStatus = "ACTIVE" | "INACTIVE";
export type ReservationStatus =
  | "RESERVED"
  | "READY"
  | "PICKED_UP"
  | "CANCELLED"
  | "NO_SHOW";

export interface Store {
  id: string;
  name: string;
  city: string;
  address: string;
}

export interface DemoUser {
  id: string;
  name: string;
  role: UserRole;
  storeId: string | null;
}

export interface Product {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PickupSlot {
  id: string;
  storeId: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  capacity: number;
  remainingCapacity: number;
}

export interface PickupReservation {
  id: string;
  storeId: string;
  productId: string;
  slotId: string;
  customerId: string;
  quantity: number;
  pickupCode: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
  storeName: string;
  productName: string;
  customerName: string;
  slotDate: string;
  startTime: string;
  endTime: string;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  status: ProductStatus;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  price?: number;
  stock?: number;
  status?: ProductStatus;
}

export interface CreateReservationInput {
  storeId: string;
  productId: string;
  slotId: string;
  quantity: number;
}

export interface UpdateReservationStatusInput {
  status: Extract<ReservationStatus, "READY" | "PICKED_UP" | "NO_SHOW">;
}

