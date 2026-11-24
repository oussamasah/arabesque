import "server-only";
import { and, asc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { devices, orderItems, orders, products, stockItems } from "@/db/schema";
import type { Exec } from "@/db";
import { getSettings } from "./settings";
import { priceAt, recipeAt } from "./catalog";
import { validTicketHashes } from "./tickets";
import { sha256Hex } from "./crypto";
import { canonicalJson } from "@/lib/canonical";

/**
 * Catalogue, shift settings and valid ticket hashes. Prices are included only when the Owner enabled
 * "tablet_show_prices" (the original blind-tablet rule, spec §3 rule 2, is the setting turned off).
 */
export async function buildDeviceConfig(db: Exec, dev: typeof devices.$inferSelect, now = new Date()) {
  const s = await getSettings(db);
  const rows = await db.select({
    id: products.id, name_ar: products.nameAr, name_fr: products.nameFr, category: products.category,
    color: products.color, image: products.image, sort_order: products.sortOrder,
  }).from(products).where(and(eq(products.active, true), isNull(products.deletedAt))).orderBy(asc(products.sortOrder), asc(products.id));
  // pay-later orders still open on the server: this device's, plus those entered/corrected by the Owner (no device).
  // Voided / settled orders disappear from the tablet's unpaid list. No amounts are sent.
  const open = await db.select({
    id: orders.id, label: orders.orderLabel, table_ref: orders.tableRef, ts: orders.effectiveTs, deviceId: orders.deviceId, total: orders.totalMillimes,
  }).from(orders).where(and(
    or(eq(orders.deviceId, dev.id), isNull(orders.deviceId)), eq(orders.paymentType, "pending"), ne(orders.status, "void"),
    gte(orders.effectiveTs, new Date(now.getTime() - 14 * 86_400_000)),
  ));
  const lines = open.length ? await db.select({ orderId: orderItems.orderId, product_id: orderItems.productId, qty: orderItems.qty })
    .from(orderItems).where(inArray(orderItems.orderId, open.map((o) => o.id))) : [];
  const withPrices = s.tablet_show_prices;
  const products_ = withPrices
    ? await Promise.all(rows.map(async (r) => ({ ...r, price_millimes: (await priceAt(db, r.id, now)) ?? null })))
    : rows;
  // this device's orders deleted by the Owner in the last 2 days (removed from the tablet's shift list)
  const voided = await db.select({ id: orders.id }).from(orders).where(and(
    eq(orders.deviceId, dev.id), eq(orders.status, "void"), gte(orders.effectiveTs, new Date(now.getTime() - 2 * 86_400_000)),
  ));
  // exact server totals of this device's recent orders (so the tablet's shift totals equal the admin's, whatever prices did since)
  const totals = withPrices ? await db.select({ id: orders.id, total: orders.totalMillimes }).from(orders).where(and(
    eq(orders.deviceId, dev.id), ne(orders.status, "void"), gte(orders.effectiveTs, new Date(now.getTime() - 2 * 86_400_000)),
  )) : [];
  // products whose ingredients are not enough for one more unit (the names of the missing items only; never quantities)
  const items = await db.select({ id: stockItems.id, name: stockItems.nameAr, qty: stockItems.qtyBase }).from(stockItems);
  const unavailable: Record<string, string> = {};
  for (const r of rows) {
    const rec = await recipeAt(db, r.id, now);
    if (!rec) continue;
    const missing = rec.lines.map((l) => ({ l, it: items.find((x) => x.id === l.stockItemId) })).filter((x) => x.it && x.it.qty < x.l.qtyBase).map((x) => x.it!.name);
    if (missing.length) unavailable[r.id] = missing.join("، ");
  }
  const body = {
    business_name: s.business_name,
    device_name: dev.name,
    products: products_,
    show_prices: withPrices,
    unavailable,
    ...(withPrices ? { order_totals: Object.fromEntries([...totals, ...open].map((t) => [t.id, t.total])) } : {}),
    void_orders: voided.map((v) => v.id),
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
