import type {
  CreateProductInput,
  CreateReservationInput,
  DemoUser,
  PickupReservation,
  PickupSlot,
  Product,
  Store,
  UpdateProductInput,
  UpdateReservationStatusInput,
} from "./types.js";

export interface MarketplaceStore {
  listStores(): Promise<Store[]>;
  listDemoUsers(): Promise<DemoUser[]>;
  getUserById(id: string): Promise<DemoUser | null>;
  listProducts(storeId: string): Promise<Product[]>;
  createProduct(actor: DemoUser, storeId: string, input: CreateProductInput): Promise<Product>;
  updateProduct(actor: DemoUser, storeId: string, productId: string, input: UpdateProductInput): Promise<Product>;
  listPickupSlots(storeId: string, date: string): Promise<PickupSlot[]>;
  createReservation(actor: DemoUser, input: CreateReservationInput): Promise<PickupReservation>;
  listReservations(actor: DemoUser, storeId: string, date?: string): Promise<PickupReservation[]>;
  updateReservationStatus(
    actor: DemoUser,
    reservationId: string,
    input: UpdateReservationStatusInput,
  ): Promise<PickupReservation>;
  cancelReservation(actor: DemoUser, reservationId: string): Promise<PickupReservation>;
  disconnect(): Promise<void>;
}

