import "server-only";
import crypto from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { creditLedger, orderItems, orders, products, stockMovements, tickets } from "@/db/schema";
import type { Exec } from "@/db";
import { audit, raiseAlert, resolveAlerts, type AlertInput } from "./audit";
import { priceAt, recipeAt } from "./catalog";
import { getSettings } from "./settings";
import { applyMovement, checkStockAlerts, costAt } from "./stock";
import { checkLowTickets, findTicketByHash } from "./tickets";
import { sha256Hex } from "./crypto";
import { normaliseShortCode } from "@/lib/canonical";
import { formatDT, roundHalfUp } from "@/lib/money";
import { shiftInfo, SHIFT_AR, type Shift } from "@/lib/time";

export const MAX_LINES = 60;

export class OrderRejected extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface NewOrder {
  id: string;
  deviceId: string | null;
  deviceSeq: number;
  orderLabel: string;
  clientTs: Date;
  effectiveTs: Date;
  receivedAt: Date;
  items: { product_id: number; qty: number }[];
  /** "later" = served now, paid when the customer leaves (a separate pay event closes it). */
  payment: "cash" | "ticket" | "later";
  ticketTokenHash?: string | null;
  ticketCodeHash?: string | null;
  tableRef?: string | null;
  flags?: string[];
  actor: string;
}

interface TicketResult {
  ticketId: string | null;
  pendingReview: boolean;
  flags: string[];
  alerts: AlertInput[];
  customerId: number | null;
}

/**
 * Ticket single-use rule (spec §7.6), applied at PAYMENT time (immediately or later).
 * Offline double use: the earliest payment wins; the other order goes to pending_review.
 */
async function applyTicket(db: Exec, o: {
  orderId: string; label: string; total: number; deviceId: string | null; at: Date; businessDay: string; shift: Shift;
  tokenHash?: string | null; codeHash?: string | null;
}): Promise<TicketResult> {
  const res: TicketResult = { ticketId: null, pendingReview: false, flags: [], alerts: [], customerId: null };
  const where = `${o.businessDay} ${SHIFT_AR[o.shift]}`;
  const t = await findTicketByHash(db, { tokenHash: o.tokenHash, codeHash: o.codeHash });
  if (!t || t.status === "void") {
    res.flags.push("ticket_invalid"); res.pendingReview = true;
    if (t) res.ticketId = t.id;
    res.alerts.push({ severity: "warn", type: "ticket_invalid", ref: `order:${o.orderId}`, businessDay: o.businessDay, shift: o.shift, message: `طلب ${o.label} بتذكرة غير صالحة (${where})` });
    return res;
  }
  res.ticketId = t.id;
  res.customerId = t.customerId;
  let take = t.status === "issued";
  if (t.status === "used") {
    const [prev] = t.usedOrderId ? await db.select().from(orders).where(eq(orders.id, t.usedOrderId)) : [];
    const prevAt = prev ? (prev.paidAt ?? prev.effectiveTs) : null;
    if (prev && prevAt && prevAt.getTime() > o.at.getTime()) {
      take = true; // the earlier use wins → move the ticket to this order
      await db.update(orders).set({ status: prev.status === "void" ? "void" : "pending_review", flags: sql`array_append(${orders.flags}, 'ticket_conflict')` }).where(eq(orders.id, prev.id));
      if (t.type === "credit" && t.customerId) {
        await db.insert(creditLedger).values({ customerId: t.customerId, ts: o.at, businessDay: prev.paidBusinessDay ?? prev.businessDay, type: "adjustment", amountMillimes: -prev.totalMillimes, orderId: prev.id, ticketId: t.id, note: "عكس دين بسبب تعارض تذكرة", createdBy: "system" });
      }
      res.alerts.push({ severity: "warn", type: "ticket_conflict", ref: `order:${prev.id}`, businessDay: prev.businessDay, shift: prev.shift, message: `تعارض: التذكرة ${t.shortCode} استُعملت مرتين (${prev.orderLabel} و ${o.label})` });
    } else {
      res.flags.push("ticket_conflict"); res.pendingReview = true;
      res.alerts.push({ severity: "warn", type: "ticket_conflict", ref: `order:${o.orderId}`, businessDay: o.businessDay, shift: o.shift, message: `تعارض: التذكرة ${t.shortCode} استُعملت مرتين (${prev?.orderLabel ?? "?"} و ${o.label})` });
    }
  }
  if (take) {
    await db.update(tickets).set({ status: "used", usedOrderId: o.orderId, usedAt: o.at, usedDeviceId: o.deviceId }).where(eq(tickets.id, t.id));
    if (t.maxAmountMillimes != null && o.total > t.maxAmountMillimes) {
      res.flags.push("over_ticket_limit"); res.pendingReview = true;
      res.alerts.push({ severity: "warn", type: "over_ticket_limit", ref: `order:${o.orderId}`, businessDay: o.businessDay, shift: o.shift, message: `طلب ${o.label}: ${formatDT(o.total)} يتجاوز سقف التذكرة ${formatDT(t.maxAmountMillimes)} (${t.customerName})` });
    }
    if (t.type === "credit" && t.customerId) {
      await db.insert(creditLedger).values({ customerId: t.customerId, ts: o.at, businessDay: o.businessDay, type: "charge", amountMillimes: o.total, orderId: o.orderId, ticketId: t.id, createdBy: "system" });
    }
  }
  return res;
}

/**
 * Server-side order processing (spec §7.2): prices, recipe versions and costs valid at effective_ts,
 * snapshots on order_items, one stock movement per stock item per order (at SERVING time, even if paid later).
 */
export async function createOrder(db: Exec, o: NewOrder) {
  const s = await getSettings(db);
  const flags = new Set(o.flags ?? []);
  if (!o.items.length) throw new OrderRejected("empty", "طلب فارغ");
  if (o.items.length > MAX_LINES) throw new OrderRejected("too_many_lines", "عدد الأسطر أكثر من المسموح");
  const merged = new Map<number, number>();
  for (const it of o.items) {
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) throw new OrderRejected("qty_out_of_bounds", "كمية خارج الحدود");
    merged.set(it.product_id, (merged.get(it.product_id) ?? 0) + it.qty);
  }
  for (const q of merged.values()) if (q > 99) throw new OrderRejected("qty_out_of_bounds", "كمية خارج الحدود");

  const ids = [...merged.keys()];
  const prods = await db.select().from(products).where(inArray(products.id, ids));
  for (const id of ids) {
    if (!prods.find((p) => p.id === id)) throw new OrderRejected("unknown_product", `منتج غير معروف (${id})`);
  }
  const { businessDay, shift } = shiftInfo(o.effectiveTs, s.morning_start_hour, s.evening_start_hour);

  let total = 0;
  let cost = 0;
  const lines: { productId: number; qty: number; unitPrice: number; unitCost: number; recipeVersionId: number | null }[] = [];
  const stockDeltas = new Map<number, number>();
  for (const [productId, qty] of merged) {
    const p = prods.find((x) => x.id === productId)!;
    if (!p.active) flags.add("inactive_product");
    const price = await priceAt(db, productId, o.effectiveTs);
    if (price === null) flags.add("no_price");
    const recipe = await recipeAt(db, productId, o.effectiveTs);
    let unitCost = 0;
    for (const l of recipe?.lines ?? []) {
      unitCost += l.qtyBase * (await costAt(db, l.stockItemId, o.effectiveTs));
      stockDeltas.set(l.stockItemId, (stockDeltas.get(l.stockItemId) ?? 0) - l.qtyBase * qty);
    }
    unitCost = roundHalfUp(unitCost, 3);
    total += (price ?? 0) * qty;
    cost += roundHalfUp(unitCost * qty, 3);
    lines.push({ productId, qty, unitPrice: price ?? 0, unitCost, recipeVersionId: recipe?.versionId ?? null });
  }
  cost = roundHalfUp(cost, 3);

  let status: "ok" | "pending_review" = "ok";
  let ticketId: string | null = null;
  let ticketCustomer: number | null = null;
  const alertsToRaise: AlertInput[] = [];
  const paidNow = o.payment !== "later";

  // the order row must exist before a ticket can point at it
  await db.insert(orders).values({
    id: o.id, deviceId: o.deviceId, deviceSeq: o.deviceSeq, orderLabel: o.orderLabel,
    clientTs: o.clientTs, effectiveTs: o.effectiveTs, receivedAt: o.receivedAt, businessDay, shift,
    status, paymentType: o.payment === "later" ? "pending" : o.payment, ticketId: null,
    paidAt: paidNow ? o.effectiveTs : null, paidBusinessDay: paidNow ? businessDay : null, paidShift: paidNow ? shift : null,
    tableRef: o.tableRef?.trim().slice(0, 20) || null,
    totalMillimes: total, costMillimes: cost.toFixed(3), flags: [...flags],
  });
  if (o.payment === "ticket") {
    const tr = await applyTicket(db, {
      orderId: o.id, label: o.orderLabel, total, deviceId: o.deviceId, at: o.effectiveTs, businessDay, shift,
      tokenHash: o.ticketTokenHash, codeHash: o.ticketCodeHash,
    });
    ticketId = tr.ticketId; ticketCustomer = tr.customerId;
    tr.flags.forEach((f) => flags.add(f));
    if (tr.pendingReview) status = "pending_review";
    alertsToRaise.push(...tr.alerts);
  }
  if (flags.has("chain_broken") || flags.has("sequence_gap")) status = "pending_review";
  if (status !== "ok" || ticketId || flags.size) {
    await db.update(orders).set({ status, ticketId, flags: [...flags] }).where(eq(orders.id, o.id));
  }
  await db.insert(orderItems).values(lines.map((l) => ({
    orderId: o.id, productId: l.productId, qty: l.qty, unitPriceMillimes: l.unitPrice,
    unitCostMillimes: l.unitCost.toFixed(3), recipeVersionId: l.recipeVersionId,
  })));
  for (const [stockItemId, delta] of stockDeltas) {
    if (delta !== 0) await applyMovement(db, { ts: o.effectiveTs, stockItemId, deltaBase: delta, type: "sale", refType: "order", refId: o.id, createdBy: o.actor });
  }
  if (flags.has("no_price")) alertsToRaise.push({ severity: "warn", type: "no_price", ref: `order:${o.id}`, businessDay, shift, message: `طلب ${o.orderLabel} يحتوي منتجاً بدون سعر` });
  if (flags.has("inactive_product")) alertsToRaise.push({ severity: "info", type: "inactive_product", ref: `order:${o.id}`, businessDay, shift, message: `طلب ${o.orderLabel} يحتوي منتجاً غير مفعّل` });
  for (const a of alertsToRaise) await raiseAlert(db, a);
  if (stockDeltas.size) await checkStockAlerts(db, [...stockDeltas.keys()]);
  if (ticketCustomer) await checkLowTickets(db, ticketCustomer);
  return { id: o.id, status, total, cost, flags: [...flags], businessDay, shift };
}

/**
 * Pay an order that was served with payment "later" (tablet order.pay event).
 * Cash reconciliation counts it in the shift of the PAYMENT, so a customer who sits across 15:00 is handled correctly.
 */
export async function payOrder(db: Exec, p: {
  orderId: string; payment: "cash" | "ticket"; at: Date; deviceId: string | null; label?: string;
  ticketTokenHash?: string | null; ticketCodeHash?: string | null; actor: string;
}) {
  const s = await getSettings(db);
  const [o] = await db.select().from(orders).where(eq(orders.id, p.orderId));
  if (!o) throw new OrderRejected("unknown_order", "طلب غير موجود");
  const info = shiftInfo(p.at, s.morning_start_hour, s.evening_start_hour);
  if (o.status === "void") {
    await raiseAlert(db, { severity: "info", type: "pay_after_void", ref: `order:${o.id}`, ...info, message: `دفع مسجّل على الطلب ${o.orderLabel} بعد إلغائه — تحقق من الكاش` });
    throw new OrderRejected("order_void", "الطلب ملغى");
  }
  if (o.paymentType !== "pending") {
    await raiseAlert(db, { severity: "warn", type: "double_payment", ref: `order:${o.id}`, ...info, message: `محاولة دفع ثانية للطلب ${o.orderLabel}` });
    throw new OrderRejected("already_paid", "الطلب مدفوع مسبقاً");
  }
  const flags = new Set(o.flags);
  let status = o.status;
  let ticketId: string | null = null;
  let ticketCustomer: number | null = null;
  const alertsToRaise: AlertInput[] = [];
  if (p.payment === "ticket") {
    const tr = await applyTicket(db, {
      orderId: o.id, label: o.orderLabel, total: o.totalMillimes, deviceId: p.deviceId, at: p.at,
      businessDay: info.businessDay, shift: info.shift, tokenHash: p.ticketTokenHash, codeHash: p.ticketCodeHash,
    });
    ticketId = tr.ticketId; ticketCustomer = tr.customerId;
    tr.flags.forEach((f) => flags.add(f));
    if (tr.pendingReview) status = "pending_review";
    alertsToRaise.push(...tr.alerts);
  }
  if (info.businessDay !== o.businessDay || info.shift !== o.shift) flags.add("paid_other_shift");
  await db.update(orders).set({
    paymentType: p.payment, ticketId, status, flags: [...flags],
    paidAt: p.at, paidBusinessDay: info.businessDay, paidShift: info.shift,
  }).where(eq(orders.id, o.id));
  for (const a of alertsToRaise) await raiseAlert(db, a);
  await resolveAlerts(db, `unpaid:${o.id}`);
  if (ticketCustomer) await checkLowTickets(db, ticketCustomer);
  return { id: o.id, status, paidBusinessDay: info.businessDay, paidShift: info.shift };
}

/**
 * Owner records the payment of an unpaid order:
 *  drawer = paid into the shift drawer · owner = the customer paid the Owner directly ·
 *  worker = the responsible shift worker covered it (also allowed for "left without paying").
 */
export async function adminPayOrder(db: Exec, orderId: string, at: Date, paidTo: "drawer" | "owner" | "worker", actor: string, ip?: string | null) {
  const [before] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (before && before.paymentType === "loss" && paidTo === "worker") {
    await db.update(orders).set({ paymentType: "pending" }).where(eq(orders.id, orderId));
  }
  const res = await payOrder(db, { orderId, payment: "cash", at, deviceId: null, actor });
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const extra = paidTo === "owner" ? ["paid_to_owner"] : paidTo === "worker" ? ["paid_by_worker"] : [];
  const flags = new Set([...o.flags, "manual_payment", ...extra]);
  await db.update(orders).set({ flags: [...flags] }).where(eq(orders.id, orderId));
  await audit(db, actor, "order.pay_manual", "order", orderId, { paymentType: "pending" }, { paymentType: "cash", at, paidTo }, ip);
  return res;
}

/** The customer left without paying: the goods were served (stock stays deducted), revenue 0, recorded as a loss. */
export async function markOrderUnpaidLoss(db: Exec, orderId: string, reason: string, actor: string, ip?: string | null) {
  if (!reason.trim()) throw new Error("السبب مطلوب");
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new Error("طلب غير موجود");
  if (o.paymentType !== "pending" || o.status === "void") throw new Error("الطلب ليس في انتظار الدفع");
  await db.update(orders).set({ paymentType: "loss", reviewNote: reason, flags: [...new Set([...o.flags, "unpaid_loss"])] }).where(eq(orders.id, orderId));
  await audit(db, actor, "order.unpaid_loss", "order", orderId, { paymentType: "pending" }, { paymentType: "loss", reason }, ip);
  await resolveAlerts(db, `unpaid:${o.id}`);
  await raiseAlert(db, { severity: "info", type: "unpaid_loss", ref: `order:${o.id}`, businessDay: o.businessDay, shift: o.shift, message: `الطلب ${o.orderLabel} (${formatDT(o.totalMillimes)}) خرج دون دفع: ${reason} — على عامل الشيفت` });
}

/** Admin-only void (spec §7.7): reverses stock, re-opens the ticket, reverses credit, audits. */
export async function voidOrder(db: Exec, orderId: string, reason: string, actor: string, ip?: string | null, opts: { quiet?: boolean } = {}) {
  if (!reason.trim()) throw new Error("سبب الإلغاء مطلوب");
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new Error("طلب غير موجود");
  if (o.status === "void") throw new Error("الطلب ملغى مسبقاً");
  const now = new Date();
  const mvs = await db.select().from(stockMovements).where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, orderId), eq(stockMovements.type, "sale")));
  for (const m of mvs) {
    await applyMovement(db, { ts: m.ts, stockItemId: m.stockItemId, deltaBase: -m.deltaBase, type: "void", refType: "order_void", refId: orderId, note: reason, createdBy: actor });
  }
  if (o.ticketId) {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, o.ticketId));
    if (t && t.usedOrderId === o.id) {
      await db.update(tickets).set({ status: "issued", usedOrderId: null, usedAt: null, usedDeviceId: null }).where(eq(tickets.id, t.id));
      const charges = await db.select().from(creditLedger).where(and(eq(creditLedger.orderId, o.id), eq(creditLedger.type, "charge")));
      for (const c of charges) {
        await db.insert(creditLedger).values({ customerId: c.customerId, ts: now, businessDay: o.businessDay, type: "adjustment", amountMillimes: -c.amountMillimes, orderId: o.id, ticketId: t.id, note: `إلغاء الطلب ${o.orderLabel}: ${reason}`, createdBy: actor });
      }
    }
  }
  await db.update(orders).set({ status: "void", voidReason: reason, voidedBy: actor, voidedAt: now }).where(eq(orders.id, orderId));
  await audit(db, actor, "order.void", "order", orderId, { status: o.status }, { status: "void", reason }, ip);
  await resolveAlerts(db, `unpaid:${o.id}`);
  await checkStockAlerts(db, [...new Set(mvs.map((m) => m.stockItemId))]);
  const s = await getSettings(db);
  const [r] = await db.select({ n: sql<string>`count(*)` }).from(orders).where(and(eq(orders.businessDay, o.businessDay), eq(orders.shift, o.shift), eq(orders.status, "void")));
  if (!opts.quiet && Number(r.n) >= s.void_spike_count) {
    await raiseAlert(db, { severity: "warn", type: "void_spike", dedupeKey: `void_spike:${o.businessDay}:${o.shift}`, businessDay: o.businessDay, shift: o.shift, message: `${r.n} إلغاءات في شيفت ${o.businessDay} ${SHIFT_AR[o.shift as Shift]}` });
  }
}

export async function approveOrder(db: Exec, orderId: string, note: string, actor: string, ip?: string | null) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new Error("طلب غير موجود");
  if (o.status !== "pending_review") throw new Error("الطلب ليس في انتظار المراجعة");
  await db.update(orders).set({ status: "ok", reviewNote: note || null }).where(eq(orders.id, orderId));
  await audit(db, actor, "order.approve", "order", orderId, { status: o.status }, { status: "ok", note }, ip);
}

/** Manual order entered by the Owner (audited, flagged 'manual'). */
export async function createManualOrder(db: Exec, input: {
  items: { product_id: number; qty: number }[]; payment: "cash" | "ticket" | "later"; ticketCode?: string | null; at: Date; note?: string | null; tableRef?: string | null;
}, actor: string, ip?: string | null) {
  const [r] = await db.select({ n: sql<string>`count(*)` }).from(orders).where(isNull(orders.deviceId));
  const seq = Number(r.n) + 1;
  const id = crypto.randomUUID();
  const codeHash = input.payment === "ticket" && input.ticketCode ? sha256Hex(normaliseShortCode(input.ticketCode)) : null;
  if (input.payment === "ticket" && !codeHash) throw new Error("رمز التذكرة مطلوب");
  const res = await createOrder(db, {
    id, deviceId: null, deviceSeq: seq, orderLabel: `ADM-${String(seq).padStart(4, "0")}`,
    clientTs: input.at, effectiveTs: input.at, receivedAt: new Date(), items: input.items, payment: input.payment,
    ticketCodeHash: codeHash, tableRef: input.tableRef, flags: ["manual"], actor,
  });
  await audit(db, actor, "order.manual", "order", id, null, { ...input, result: res }, ip);
  return res;
}
