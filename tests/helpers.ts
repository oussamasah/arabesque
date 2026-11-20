import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { __setDbForTests, type DB } from "@/db";
import { createProduct, saveRecipe, setPrice } from "@/server/catalog";
import { createStockItem, recordPurchase } from "@/server/stock";
import { computeEventHash } from "@/server/sync";
import { sha256Hex } from "@/server/crypto";
import type { EventEnvelope } from "@/lib/canonical";

process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
process.env.TOTP_ENCRYPTION_KEY = "test-totp-key-0123456789abcdef";

export async function createTestDb(): Promise<DB> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  __setDbForTests(db);
  return db;
}

export const T0 = new Date("2026-01-01T00:00:00Z");

/** Coffee stock + Coffee product: 1.800 DT, accounted 80 cups/kg (12500 mg), real 90 (11111.111 mg). */
export async function seedCoffee(db: DB) {
  const coffee = await createStockItem(db, { nameAr: "بن", kind: "weight", minQtyBase: 0 }, "test");
  const water = await createStockItem(db, { nameAr: "ماء 0.5", kind: "piece", minQtyBase: 0 }, "test");
  const pCoffee = await createProduct(db, { nameAr: "قهوة" }, "test");
  const pWater = await createProduct(db, { nameAr: "ماء" }, "test");
  await setPrice(db, pCoffee.id, 1800, T0, "test");
  await setPrice(db, pWater.id, 1000, T0, "test");
  await saveRecipe(db, pCoffee.id, [{ stockItemId: coffee.id, qtyBase: 12500, realQtyBase: 11111.111 }], T0, "test");
  await saveRecipe(db, pWater.id, [{ stockItemId: water.id, qtyBase: 1, realQtyBase: 1 }], T0, "test");
  // 2 kg coffee for 80 DT  -> 0.04 millimes/mg ; 48 bottles for 24 DT -> 500 millimes/bottle
  await recordPurchase(db, { stockItemId: coffee.id, qtyBase: 2_000_000, totalMillimes: 80_000, ts: T0, paidFrom: "owner", opening: true }, "test");
  await recordPurchase(db, { stockItemId: water.id, qtyBase: 48, totalMillimes: 24_000, ts: T0, paidFrom: "owner", opening: true }, "test");
  return { coffee, water, pCoffee, pWater };
}

/** Simulates the tablet's event builder (same hash definition as the PWA). */
export class FakeTablet {
  seq = 0;
  lastHash: string | null = null;
  offset = 0;
  constructor(public deviceId: string) {}
  private build(type: EventEnvelope["type"], payload: EventEnvelope["payload"], at?: Date): EventEnvelope {
    this.seq++;
    const base: Omit<EventEnvelope, "hash"> = {
      client_event_id: crypto.randomUUID(), device_id: this.deviceId, seq: this.seq, type,
      client_ts: (at ?? new Date()).getTime() - this.offset, clock_offset_ms: this.offset,
      payload, prev_hash: this.lastHash,
    };
    const hash = computeEventHash(base);
    this.lastHash = hash;
    return { ...base, hash };
  }
  event(items: { product_id: number; qty: number }[], opts: { at?: Date; payment?: "cash" | "ticket" | "later"; tokenHash?: string; codeHash?: string; tableRef?: string } = {}): EventEnvelope {
    return this.build("order.create", {
      items, payment: opts.payment ?? "cash",
      ...(opts.tokenHash ? { ticket_token_hash: opts.tokenHash } : {}),
      ...(opts.codeHash ? { ticket_code_hash: opts.codeHash } : {}),
      ...(opts.tableRef ? { table_ref: opts.tableRef } : {}),
    }, opts.at);
  }
  pay(orderId: string, opts: { at?: Date; payment?: "cash" | "ticket"; tokenHash?: string; codeHash?: string } = {}): EventEnvelope {
    return this.build("order.pay", {
      order_id: orderId, payment: opts.payment ?? "cash",
      ...(opts.tokenHash ? { ticket_token_hash: opts.tokenHash } : {}),
      ...(opts.codeHash ? { ticket_code_hash: opts.codeHash } : {}),
    }, opts.at);
  }
}

export async function createDevice(db: DB, name = "T1") {
  const id = crypto.randomUUID();
  const [d] = await db.insert(schema.devices).values({ id, name, keyHash: sha256Hex("k-" + id), status: "active", pairedAt: new Date(), lastSeq: 0 }).returning();
  return d;
}
