import process from "node:process";

import dotenv from "dotenv";

import { createApp } from "./app.js";
import { MemoryMarketplaceStore } from "./memory-store.js";
import { PostgresMarketplaceStore } from "./postgres-store.js";
import type { MarketplaceStore } from "./store.js";

dotenv.config();

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;

async function buildStore(): Promise<MarketplaceStore> {
  if (!databaseUrl) {
    return new MemoryMarketplaceStore();
  }

  return PostgresMarketplaceStore.create(databaseUrl);
}

const store = await buildStore();
const app = createApp({ store });

try {
  await app.listen({ port, host });
  console.log(`API listening on http://${host}:${port}`);
} catch (error) {
  console.error(error);
  await store.disconnect();
  process.exit(1);
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down.`);
  await app.close();
  await store.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
