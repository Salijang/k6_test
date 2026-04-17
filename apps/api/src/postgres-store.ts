import { randomUUID } from "node:crypto";

import pg, { type Pool, type PoolClient } from "pg";

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
  Store,
  UpdateProductInput,
  UpdateReservationStatusInput,
} from "./types.js";

const { Pool: PgPool } = pg;

type DbUserRow = {
  id: string;
  name: string;
  role: DemoUser["role"];
  store_id: string | null;
};

type DbProductRow = {
  id: string;
  store_id: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  status: Product["status"];
  created_at: Date;
  updated_at: Date;
};

type DbSlotRow = {
  id: string;
  store_id: string;
  slot_date: string;
  start_time: string;
  end_time: string;
  capacity: number;
  remaining_capacity: number;
};

type DbReservationRow = {
  id: string;
  store_id: string;
  product_id: string;
  slot_id: string;
  customer_id: string;
  quantity: number;
  pickup_code: string;
  status: ReservationStatus;
  created_at: Date;
  updated_at: Date;
  store_name: string;
  product_name: string;
  customer_name: string;
  slot_date: string;
  start_time: string;
  end_time: string;
};

function mapUser(row: DbUserRow): DemoUser {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    storeId: row.store_id,
  };
}

function mapProduct(row: DbProductRow): Product {
  return {
    id: row.id,
    storeId: row.store_id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    price: row.price,
    stock: row.stock,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSlot(row: DbSlotRow): PickupSlot {
  return {
    id: row.id,
    storeId: row.store_id,
    slotDate: row.slot_date,
    startTime: row.start_time,
    endTime: row.end_time,
    capacity: row.capacity,
    remainingCapacity: row.remaining_capacity,
  };
}

function mapReservation(row: DbReservationRow): PickupReservation {
  return {
    id: row.id,
    storeId: row.store_id,
    productId: row.product_id,
    slotId: row.slot_id,
    customerId: row.customer_id,
    quantity: row.quantity,
    pickupCode: row.pickup_code,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    storeName: row.store_name,
    productName: row.product_name,
    customerName: row.customer_name,
    slotDate: row.slot_date,
    startTime: row.start_time,
    endTime: row.end_time,
  };
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

function assertStatusTransition(current: ReservationStatus, next: UpdateReservationStatusInput["status"]): void {
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

export class PostgresMarketplaceStore implements MarketplaceStore {
  constructor(private readonly pool: Pool) {}

  static async create(connectionString: string) {
    const pool = new PgPool({
      connectionString,
    });
    const store = new PostgresMarketplaceStore(pool);
    await store.initialize();
    return store;
  }

  private async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        address TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('seller', 'customer')),
        store_id TEXT REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id),
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price INTEGER NOT NULL CHECK (price >= 0),
        stock INTEGER NOT NULL CHECK (stock >= 0),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (store_id, sku)
      );

      CREATE TABLE IF NOT EXISTS pickup_slots (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id),
        slot_date DATE NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        remaining_capacity INTEGER NOT NULL CHECK (remaining_capacity >= 0),
        UNIQUE (store_id, slot_date, start_time)
      );

      CREATE TABLE IF NOT EXISTS pickup_reservations (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        slot_id TEXT NOT NULL REFERENCES pickup_slots(id),
        customer_id TEXT NOT NULL REFERENCES app_users(id),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        pickup_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('RESERVED', 'READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
      CREATE INDEX IF NOT EXISTS idx_pickup_slots_store_date ON pickup_slots(store_id, slot_date);
      CREATE INDEX IF NOT EXISTS idx_pickup_reservations_store_id ON pickup_reservations(store_id);
      CREATE INDEX IF NOT EXISTS idx_pickup_reservations_slot_id ON pickup_reservations(slot_id);
    `);

    await this.seed();
  }

  private async seed() {
    const seed = buildSeedData();
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      for (const store of seed.stores) {
        await client.query(
          `
            INSERT INTO stores (id, name, city, address)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
          `,
          [store.id, store.name, store.city, store.address],
        );
      }

      for (const user of seed.users) {
        await client.query(
          `
            INSERT INTO app_users (id, name, role, store_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
          `,
          [user.id, user.name, user.role, user.storeId],
        );
      }

      for (const product of seed.products) {
        await client.query(
          `
            INSERT INTO products (
              id,
              store_id,
              sku,
              name,
              description,
              price,
              stock,
              status,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            product.id,
            product.storeId,
            product.sku,
            product.name,
            product.description,
            product.price,
            product.stock,
            product.status,
            product.createdAt,
            product.updatedAt,
          ],
        );
      }

      for (const slot of seed.slots) {
        await client.query(
          `
            INSERT INTO pickup_slots (
              id,
              store_id,
              slot_date,
              start_time,
              end_time,
              capacity,
              remaining_capacity
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            slot.id,
            slot.storeId,
            slot.slotDate,
            slot.startTime,
            slot.endTime,
            slot.capacity,
            slot.remainingCapacity,
          ],
        );
      }

      for (const reservation of seed.reservations) {
        await client.query(
          `
            INSERT INTO pickup_reservations (
              id,
              store_id,
              product_id,
              slot_id,
              customer_id,
              quantity,
              pickup_code,
              status,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            reservation.id,
            reservation.storeId,
            reservation.productId,
            reservation.slotId,
            reservation.customerId,
            reservation.quantity,
            reservation.pickupCode,
            reservation.status,
            reservation.createdAt,
            reservation.updatedAt,
          ],
        );
      }

      await client.query(`
        UPDATE pickup_slots slot
        SET remaining_capacity = GREATEST(slot.capacity - counts.used_count, 0)
        FROM (
          SELECT slot_id, COUNT(*)::INTEGER AS used_count
          FROM pickup_reservations
          WHERE status IN ('RESERVED', 'READY', 'PICKED_UP', 'NO_SHOW')
          GROUP BY slot_id
        ) counts
        WHERE slot.id = counts.slot_id
      `);

      await client.query(`
        UPDATE products product
        SET stock = GREATEST(product.stock - counts.used_count, 0)
        FROM (
          SELECT product_id, COALESCE(SUM(quantity), 0)::INTEGER AS used_count
          FROM pickup_reservations
          WHERE status IN ('RESERVED', 'READY', 'PICKED_UP', 'NO_SHOW')
          GROUP BY product_id
        ) counts
        WHERE product.id = counts.product_id
      `);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listStores() {
    const { rows } = await this.pool.query<Store>("SELECT id, name, city, address FROM stores ORDER BY name ASC");
    return rows;
  }

  async listDemoUsers() {
    const { rows } = await this.pool.query<DbUserRow>(
      "SELECT id, name, role, store_id FROM app_users ORDER BY role DESC, name ASC",
    );
    return rows.map(mapUser);
  }

  async getUserById(id: string) {
    const { rows } = await this.pool.query<DbUserRow>(
      "SELECT id, name, role, store_id FROM app_users WHERE id = $1",
      [id],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async listProducts(storeId: string) {
    const { rows } = await this.pool.query<DbProductRow>(
      `
        SELECT id, store_id, sku, name, description, price, stock, status, created_at, updated_at
        FROM products
        WHERE store_id = $1
        ORDER BY created_at DESC, sku ASC
      `,
      [storeId],
    );
    return rows.map(mapProduct);
  }

  async createProduct(actor: DemoUser, storeId: string, input: CreateProductInput) {
    assertSeller(actor, storeId);

    try {
      const { rows } = await this.pool.query<DbProductRow>(
        `
          INSERT INTO products (
            id,
            store_id,
            sku,
            name,
            description,
            price,
            stock,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          RETURNING id, store_id, sku, name, description, price, stock, status, created_at, updated_at
        `,
        [randomUUID(), storeId, input.sku, input.name, input.description, input.price, input.stock, input.status],
      );
      const created = rows[0];
      if (!created) {
        throw notFound("상품 생성 결과를 확인할 수 없습니다.");
      }
      return mapProduct(created);
    } catch (error) {
      if (error instanceof Error && error.message.includes("duplicate key")) {
        throw conflict("이 매장에는 이미 같은 SKU가 있습니다.");
      }
      throw error;
    }
  }

  async updateProduct(actor: DemoUser, storeId: string, productId: string, input: UpdateProductInput) {
    assertSeller(actor, storeId);

    const fields: string[] = [];
    const values: Array<string | number> = [];
    let index = 1;

    if (input.name !== undefined) {
      fields.push(`name = $${index++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = $${index++}`);
      values.push(input.description);
    }
    if (input.price !== undefined) {
      fields.push(`price = $${index++}`);
      values.push(input.price);
    }
    if (input.stock !== undefined) {
      fields.push(`stock = $${index++}`);
      values.push(input.stock);
    }
    if (input.status !== undefined) {
      fields.push(`status = $${index++}`);
      values.push(input.status);
    }

    if (fields.length === 0) {
      throw badRequest("수정할 상품 항목을 하나 이상 입력해야 합니다.");
    }

    values.push(productId, storeId);

    const { rows } = await this.pool.query<DbProductRow>(
      `
        UPDATE products
        SET ${fields.join(", ")}, updated_at = NOW()
        WHERE id = $${index++} AND store_id = $${index}
        RETURNING id, store_id, sku, name, description, price, stock, status, created_at, updated_at
      `,
      values,
    );

    if (!rows[0]) {
      throw notFound("상품 정보를 찾을 수 없습니다.");
    }

    return mapProduct(rows[0]);
  }

  async listPickupSlots(storeId: string, date: string) {
    const { rows } = await this.pool.query<DbSlotRow>(
      `
        SELECT id, store_id, slot_date::TEXT, start_time, end_time, capacity, remaining_capacity
        FROM pickup_slots
        WHERE store_id = $1 AND slot_date = $2
        ORDER BY start_time ASC
      `,
      [storeId, date],
    );
    return rows.map(mapSlot);
  }

  async createReservation(actor: DemoUser, input: CreateReservationInput) {
    assertCustomer(actor);

    return this.withTransaction(async (client) => {
      const productResult = await client.query<DbProductRow>(
        `
          SELECT id, store_id, sku, name, description, price, stock, status, created_at, updated_at
          FROM products
          WHERE id = $1
          FOR UPDATE
        `,
        [input.productId],
      );
      const product = productResult.rows[0];
      if (!product || product.store_id !== input.storeId) {
        throw notFound("해당 매장에서 상품 정보를 찾을 수 없습니다.");
      }
      if (product.status !== "ACTIVE") {
        throw badRequest("판매중인 상품만 예약할 수 있습니다.");
      }
      if (product.stock < input.quantity) {
        throw conflict("예약 가능한 재고가 부족합니다.");
      }

      const slotResult = await client.query<DbSlotRow>(
        `
          SELECT id, store_id, slot_date::TEXT, start_time, end_time, capacity, remaining_capacity
          FROM pickup_slots
          WHERE id = $1
          FOR UPDATE
        `,
        [input.slotId],
      );
      const slot = slotResult.rows[0];
      if (!slot || slot.store_id !== input.storeId) {
        throw notFound("해당 매장에서 픽업 슬롯을 찾을 수 없습니다.");
      }
      if (slot.remaining_capacity < 1) {
        throw conflict("선택한 픽업 슬롯은 마감되었습니다.");
      }

      await client.query(
        "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
        [input.quantity, input.productId],
      );
      await client.query(
        "UPDATE pickup_slots SET remaining_capacity = remaining_capacity - 1 WHERE id = $1",
        [input.slotId],
      );

      const reservationId = randomUUID();
      const pickupCode = `PK-${Math.floor(Math.random() * 9000) + 1000}`;

      await client.query(
        `
          INSERT INTO pickup_reservations (
            id,
            store_id,
            product_id,
            slot_id,
            customer_id,
            quantity,
            pickup_code,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', NOW(), NOW())
        `,
        [reservationId, input.storeId, input.productId, input.slotId, actor.id, input.quantity, pickupCode],
      );

      const { rows } = await client.query<DbReservationRow>(
        `
          SELECT
            reservation.id,
            reservation.store_id,
            reservation.product_id,
            reservation.slot_id,
            reservation.customer_id,
            reservation.quantity,
            reservation.pickup_code,
            reservation.status,
            reservation.created_at,
            reservation.updated_at,
            store.name AS store_name,
            product.name AS product_name,
            customer.name AS customer_name,
            slot.slot_date::TEXT AS slot_date,
            slot.start_time,
            slot.end_time
          FROM pickup_reservations reservation
          JOIN stores store ON store.id = reservation.store_id
          JOIN products product ON product.id = reservation.product_id
          JOIN app_users customer ON customer.id = reservation.customer_id
          JOIN pickup_slots slot ON slot.id = reservation.slot_id
          WHERE reservation.id = $1
        `,
        [reservationId],
      );
      const createdReservation = rows[0];
      if (!createdReservation) {
        throw notFound("예약 생성 결과를 확인할 수 없습니다.");
      }

      return mapReservation(createdReservation);
    });
  }

  async listReservations(actor: DemoUser, storeId: string, date?: string) {
    assertSeller(actor, storeId);

    const values: string[] = [storeId];
    let dateClause = "";
    if (date) {
      values.push(date);
      dateClause = "AND slot.slot_date = $2";
    }

    const { rows } = await this.pool.query<DbReservationRow>(
      `
        SELECT
          reservation.id,
          reservation.store_id,
          reservation.product_id,
          reservation.slot_id,
          reservation.customer_id,
          reservation.quantity,
          reservation.pickup_code,
          reservation.status,
          reservation.created_at,
          reservation.updated_at,
          store.name AS store_name,
          product.name AS product_name,
          customer.name AS customer_name,
          slot.slot_date::TEXT AS slot_date,
          slot.start_time,
          slot.end_time
        FROM pickup_reservations reservation
        JOIN stores store ON store.id = reservation.store_id
        JOIN products product ON product.id = reservation.product_id
        JOIN app_users customer ON customer.id = reservation.customer_id
        JOIN pickup_slots slot ON slot.id = reservation.slot_id
        WHERE reservation.store_id = $1
        ${dateClause}
        ORDER BY slot.slot_date ASC, slot.start_time ASC, reservation.created_at DESC
      `,
      values,
    );

    return rows.map(mapReservation);
  }

  async updateReservationStatus(actor: DemoUser, reservationId: string, input: UpdateReservationStatusInput) {
    return this.withTransaction(async (client) => {
      const current = await client.query<DbReservationRow>(
        `
          SELECT
            reservation.id,
            reservation.store_id,
            reservation.product_id,
            reservation.slot_id,
            reservation.customer_id,
            reservation.quantity,
            reservation.pickup_code,
            reservation.status,
            reservation.created_at,
            reservation.updated_at,
            store.name AS store_name,
            product.name AS product_name,
            customer.name AS customer_name,
            slot.slot_date::TEXT AS slot_date,
            slot.start_time,
            slot.end_time
          FROM pickup_reservations reservation
          JOIN stores store ON store.id = reservation.store_id
          JOIN products product ON product.id = reservation.product_id
          JOIN app_users customer ON customer.id = reservation.customer_id
          JOIN pickup_slots slot ON slot.id = reservation.slot_id
          WHERE reservation.id = $1
          FOR UPDATE
        `,
        [reservationId],
      );
      const reservation = current.rows[0];
      if (!reservation) {
        throw notFound("예약 정보를 찾을 수 없습니다.");
      }

      assertSeller(actor, reservation.store_id);
      assertStatusTransition(reservation.status, input.status);

      const { rows } = await client.query<DbReservationRow>(
        `
          UPDATE pickup_reservations
          SET status = $1, updated_at = NOW()
          WHERE id = $2
          RETURNING
            id,
            store_id,
            product_id,
            slot_id,
            customer_id,
            quantity,
            pickup_code,
            status,
            created_at,
            updated_at,
            ''::TEXT AS store_name,
            ''::TEXT AS product_name,
            ''::TEXT AS customer_name,
            ''::TEXT AS slot_date,
            ''::TEXT AS start_time,
            ''::TEXT AS end_time
        `,
        [input.status, reservationId],
      );

      const updated = rows[0];
      if (!updated) {
        throw notFound("예약 정보를 찾을 수 없습니다.");
      }

      const result = await client.query<DbReservationRow>(
        `
          SELECT
            reservation.id,
            reservation.store_id,
            reservation.product_id,
            reservation.slot_id,
            reservation.customer_id,
            reservation.quantity,
            reservation.pickup_code,
            reservation.status,
            reservation.created_at,
            reservation.updated_at,
            store.name AS store_name,
            product.name AS product_name,
            customer.name AS customer_name,
            slot.slot_date::TEXT AS slot_date,
            slot.start_time,
            slot.end_time
          FROM pickup_reservations reservation
          JOIN stores store ON store.id = reservation.store_id
          JOIN products product ON product.id = reservation.product_id
          JOIN app_users customer ON customer.id = reservation.customer_id
          JOIN pickup_slots slot ON slot.id = reservation.slot_id
          WHERE reservation.id = $1
        `,
        [reservationId],
      );
      const updatedReservation = result.rows[0];
      if (!updatedReservation) {
        throw notFound("예약 정보를 찾을 수 없습니다.");
      }

      return mapReservation(updatedReservation);
    });
  }

  async cancelReservation(actor: DemoUser, reservationId: string) {
    assertCustomer(actor);

    return this.withTransaction(async (client) => {
      const current = await client.query<DbReservationRow>(
        `
          SELECT
            reservation.id,
            reservation.store_id,
            reservation.product_id,
            reservation.slot_id,
            reservation.customer_id,
            reservation.quantity,
            reservation.pickup_code,
            reservation.status,
            reservation.created_at,
            reservation.updated_at,
            store.name AS store_name,
            product.name AS product_name,
            customer.name AS customer_name,
            slot.slot_date::TEXT AS slot_date,
            slot.start_time,
            slot.end_time
          FROM pickup_reservations reservation
          JOIN stores store ON store.id = reservation.store_id
          JOIN products product ON product.id = reservation.product_id
          JOIN app_users customer ON customer.id = reservation.customer_id
          JOIN pickup_slots slot ON slot.id = reservation.slot_id
          WHERE reservation.id = $1
          FOR UPDATE
        `,
        [reservationId],
      );
      const reservation = current.rows[0];
      if (!reservation) {
        throw notFound("예약 정보를 찾을 수 없습니다.");
      }
      if (reservation.customer_id !== actor.id) {
        throw forbidden("고객은 본인 예약만 취소할 수 있습니다.");
      }
      if (!["RESERVED", "READY"].includes(reservation.status)) {
        throw badRequest("예약 완료 또는 픽업 준비 상태에서만 취소할 수 있습니다.");
      }

      await client.query(
        "UPDATE pickup_reservations SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1",
        [reservationId],
      );
      await client.query("UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2", [
        reservation.quantity,
        reservation.product_id,
      ]);
      await client.query(
        "UPDATE pickup_slots SET remaining_capacity = remaining_capacity + 1 WHERE id = $1",
        [reservation.slot_id],
      );

      const result = await client.query<DbReservationRow>(
        `
          SELECT
            reservation.id,
            reservation.store_id,
            reservation.product_id,
            reservation.slot_id,
            reservation.customer_id,
            reservation.quantity,
            reservation.pickup_code,
            reservation.status,
            reservation.created_at,
            reservation.updated_at,
            store.name AS store_name,
            product.name AS product_name,
            customer.name AS customer_name,
            slot.slot_date::TEXT AS slot_date,
            slot.start_time,
            slot.end_time
          FROM pickup_reservations reservation
          JOIN stores store ON store.id = reservation.store_id
          JOIN products product ON product.id = reservation.product_id
          JOIN app_users customer ON customer.id = reservation.customer_id
          JOIN pickup_slots slot ON slot.id = reservation.slot_id
          WHERE reservation.id = $1
        `,
        [reservationId],
      );
      const cancelledReservation = result.rows[0];
      if (!cancelledReservation) {
        throw notFound("예약 정보를 찾을 수 없습니다.");
      }

      return mapReservation(cancelledReservation);
    });
  }

  async disconnect() {
    await this.pool.end();
  }
}
