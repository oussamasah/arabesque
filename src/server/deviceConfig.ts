import "server-only";
import { and, asc, eq, gte, ne } from "drizzle-orm";
import { devices, orders, products } from "@/db/schema";
import type { Exec } from "@/db";
import { getSettings } from "./settings";
import { validTicketHashes } from "./tickets";
import { sha256Hex } from "./crypto";
import { canonicalJson } from "@/lib/canonical";

/** Catalogue WITHOUT prices (spec §3 rule 2, §8.3), shift settings and valid ticket hashes. */
export async function buildDeviceConfig(db: Exec, dev: typeof devices.$inferSelect, now = new Date()) {
  const s = await getSettings(db);
  const rows = await db.select({
    id: products.id, name_ar: products.nameAr, name_fr: products.nameFr, category: products.category,
    color: products.color, image: products.image, sort_order: products.sortOrder,
  }).from(products).where(eq(products.active, true)).orderBy(asc(products.sortOrder), asc(products.id));
  const body = {
    business_name: s.business_name,
    device_name: dev.name,
    products: rows,
    settings: { morning_start_hour: s.morning_start_hour, evening_start_hour: s.evening_start_hour },
    valid_tickets: await validTicketHashes(db),
    // pay-later orders of this device that the server still considers open (voided / settled by the Owner disappear on the tablet)
    open_orders: (await db.select({ id: orders.id }).from(orders).where(and(
      eq(orders.deviceId, dev.id), eq(orders.paymentType, "pending"), ne(orders.status, "void"),
      gte(orders.effectiveTs, new Date(now.getTime() - 14 * 86_400_000)),
    ))).map((r) => r.id),
  };
  return { ...body, config_version: sha256Hex(canonicalJson(body)).slice(0, 16) };
}
