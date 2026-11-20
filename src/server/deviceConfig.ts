import "server-only";
import { and, asc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { devices, orderItems, orders, products } from "@/db/schema";
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
  }).from(products).where(and(eq(products.active, true), isNull(products.deletedAt))).orderBy(asc(products.sortOrder), asc(products.id));
  // pay-later orders still open on the server: this device's, plus those entered/corrected by the Owner (no device).
  // Voided / settled orders disappear from the tablet's unpaid list. No amounts are sent.
  const open = await db.select({
    id: orders.id, label: orders.orderLabel, table_ref: orders.tableRef, ts: orders.effectiveTs, deviceId: orders.deviceId,
  }).from(orders).where(and(
    or(eq(orders.deviceId, dev.id), isNull(orders.deviceId)), eq(orders.paymentType, "pending"), ne(orders.status, "void"),
    gte(orders.effectiveTs, new Date(now.getTime() - 14 * 86_400_000)),
  ));
  const lines = open.length ? await db.select({ orderId: orderItems.orderId, product_id: orderItems.productId, qty: orderItems.qty })
    .from(orderItems).where(inArray(orderItems.orderId, open.map((o) => o.id))) : [];
  const body = {
    business_name: s.business_name,
    device_name: dev.name,
    products: rows,
    settings: { morning_start_hour: s.morning_start_hour, evening_start_hour: s.evening_start_hour },
    valid_tickets: await validTicketHashes(db),
    open_orders: open.map((o) => o.id),
    open_order_details: open.filter((o) => o.deviceId === null).map((o) => ({
      id: o.id, label: o.label, table_ref: o.table_ref, ts: o.ts.getTime(),
      items: lines.filter((l) => l.orderId === o.id).map((l) => ({ product_id: l.product_id, qty: l.qty })),
    })),
  };
  return { ...body, config_version: sha256Hex(canonicalJson(body)).slice(0, 16) };
}
