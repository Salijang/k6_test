import type { DemoUser, PickupReservation, PickupSlot, Product, Store } from "./types.js";

export interface SeedData {
  stores: Store[];
  users: DemoUser[];
  products: Product[];
  slots: PickupSlot[];
  reservations: PickupReservation[];
}

const stores: Store[] = [
  {
    id: "store-seoul-central",
    name: "서울 중앙점",
    city: "서울",
    address: "서울 중구 을지로 101",
  },
  {
    id: "store-busan-harbor",
    name: "부산 항만점",
    city: "부산",
    address: "부산 중구 중앙대로 88",
  },
  {
    id: "store-incheon-terminal",
    name: "인천 터미널점",
    city: "인천",
    address: "인천 연수구 터미널대로 24",
  },
  {
    id: "store-daegu-station",
    name: "대구 역세권점",
    city: "대구",
    address: "대구 중구 동성로 17",
  },
];

const users: DemoUser[] = [
  { id: "seller-seoul-central", name: "서울점 판매자", role: "seller", storeId: "store-seoul-central" },
  { id: "seller-busan-harbor", name: "부산점 판매자", role: "seller", storeId: "store-busan-harbor" },
  { id: "seller-incheon-terminal", name: "인천점 판매자", role: "seller", storeId: "store-incheon-terminal" },
  { id: "seller-daegu-station", name: "대구점 판매자", role: "seller", storeId: "store-daegu-station" },
  { id: "customer-minji", name: "민지", role: "customer", storeId: null },
  { id: "customer-jisoo", name: "지수", role: "customer", storeId: null },
  { id: "customer-junho", name: "준호", role: "customer", storeId: null },
  { id: "customer-seoyeon", name: "서연", role: "customer", storeId: null },
];

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(base: Date, offset: number): Date {
  const value = new Date(base);
  value.setUTCDate(value.getUTCDate() + offset);
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildProducts(): Product[] {
  const timestamp = nowIso();
  const catalog = [
    { sku: "FRESH-BOX", name: "신선 꾸러미", description: "제철 농산물을 담은 픽업 전용 구성입니다.", price: 25000, stock: 30 },
    { sku: "MEAL-KIT", name: "밀키트 세트", description: "저녁 식사용 간편 조리 세트입니다.", price: 18000, stock: 24 },
    { sku: "COFFEE-BEAN", name: "원두 패키지", description: "싱글 오리진 원두 500g 패키지입니다.", price: 16000, stock: 40 },
  ];

  return stores.flatMap((store, storeIndex) =>
    catalog.map((item, productIndex) => ({
      id: `${store.id}-product-${productIndex + 1}`,
      storeId: store.id,
      sku: `${item.sku}-${storeIndex + 1}`,
      name: `${store.city} ${item.name}`,
      description: item.description,
      price: item.price + storeIndex * 1000,
      stock: item.stock + storeIndex * 5,
      status: "ACTIVE" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  );
}

function buildSlots(): PickupSlot[] {
  const baseDate = new Date();
  const slotHours = [
    ["10:00", "11:00"],
    ["11:00", "12:00"],
    ["13:00", "14:00"],
    ["15:00", "16:00"],
    ["17:00", "18:00"],
    ["19:00", "20:00"],
  ] as const;

  return stores.flatMap((store) =>
    Array.from({ length: 14 }, (_, offset) => shiftDays(baseDate, offset)).flatMap((date) => {
      const slotDate = isoDay(date);
      return slotHours.map(([startTime, endTime], index) => ({
        id: `${store.id}-${slotDate}-${index + 1}`,
        storeId: store.id,
        slotDate,
        startTime,
        endTime,
        capacity: 6,
        remainingCapacity: 6,
      }));
    }),
  );
}

export function buildSeedData(): SeedData {
  const products = buildProducts();
  const slots = buildSlots();

  return {
    stores: structuredClone(stores),
    users: structuredClone(users),
    products,
    slots,
    reservations: [],
  };
}
