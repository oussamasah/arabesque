import "server-only";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  expenses, orderItems, orders, recipeLines, stockCostHistory, stockCounts, stockItems, stockMovements,
} from "@/db/schema";
import type { Exec } from "@/db";
import { audit, raiseAlert, resolveAlerts } from "./audit";
import { getSettings, type Settings } from "./settings";
import { assertInt, formatDT, roundHalfUp } from "@/lib/money";
import { addDays, shiftInfo, SHIFT_AR, type Shift } from "@/lib/time";
import { formatQty, type StockKind } from "@/lib/units";

export type MovementType = "sale" | "void" | "purchase" | "count_adjust" | "waste" | "staff_consumption" | "correction";

export async function createStockItem(db: Exec, input: { nameAr: string; kind: StockKind; minQtyBase: number }, actor: string) {
  if (!input.nameAr.trim()) throw new Error("الاسم مطلوب");
  if (!["weight", "volume", "piece"].includes(input.kind)) throw new Error("نوع غير صالح");
  assertInt(input.minQtyBase, "min");
  const [row] = await db.insert(stockItems).values({ nameAr: input.nameAr.trim(), kind: input.kind, minQtyBase: input.minQtyBase }).returning();
  await audit(db, actor, "stock_item.create", "stock_item", row.id, null, row);
  return row;
}

export async function updateStockItem(db: Exec, id: number, input: { nameAr: string; minQtyBase: number; active: boolean }, actor: string) {
  const [before] = await db.select().from(stockItems).where(eq(stockItems.id, id));
  if (!before) throw new Error("مادة غير موجودة");
  assertInt(input.minQtyBase, "min");
  const [row] = await db.update(stockItems).set({ nameAr: input.nameAr.trim(), minQtyBase: input.minQtyBase, active: input.active })
    .where(eq(stockItems.id, id)).returning();
  await audit(db, actor, "stock_item.update", "stock_item", id, before, row);
  await checkStockAlerts(db, [id]);
  return row;
}

/** Append a movement to the immutable ledger and update the cached quantity in the same transaction. */
export async function applyMovement(db: Exec, m: {
  ts: Date; stockItemId: number; deltaBase: number; type: MovementType;
  refType?: string | null; refId?: string | null; note?: string | null; createdBy?: string | null;
}) {
  assertInt(m.deltaBase, "delta");
  const [row] = await db.insert(stockMovements).values({
    ts: m.ts, stockItemId: m.stockItemId, deltaBase: m.deltaBase, type: m.type,
    refType: m.refType ?? null, refId: m.refId ?? null, note: m.note ?? null, createdBy: m.createdBy ?? null,
  }).returning();
  await db.update(stockItems).set({ qtyBase: sql`${stockItems.qtyBase} + ${m.deltaBase}` }).where(eq(stockItems.id, m.stockItemId));
  return row;
}

/** Weighted-average cost valid at a time (millimes per base unit). */
export async function costAt(db: Exec, stockItemId: number, at: Date): Promise<number> {
  const [row] = await db.select().from(stockCostHistory)
    .where(and(eq(stockCostHistory.stockItemId, stockItemId), lte(stockCostHistory.effectiveFrom, at)))
    .orderBy(desc(stockCostHistory.effectiveFrom), desc(stockCostHistory.id)).limit(1);
  if (row) return Number(row.costPerBase);
  const [first] = await db.select().from(stockCostHistory).where(eq(stockCostHistory.stockItemId, stockItemId))
    .orderBy(asc(stockCostHistory.effectiveFrom)).limit(1);
  return first ? Number(first.costPerBase) : 0;
}

export async function theoreticalAt(db: Exec, stockItemId: number, at: Date): Promise<number> {
  const [r] = await db.select({ s: sql<string>`coalesce(sum(${stockMovements.deltaBase}), 0)` }).from(stockMovements)
    .where(and(eq(stockMovements.stockItemId, stockItemId), lte(stockMovements.ts, at)));
  return Number(r.s);
}

export interface PurchaseInput {
  stockItemId: number; qtyBase: number; totalMillimes: number; ts: Date;
  paidFrom: "drawer" | "owner"; paidAt?: Date | null; invoiceRef?: string | null; note?: string | null;
  opening?: boolean; // opening stock: no expense is created
}

/** Spec §7.3 — purchase: stock +, weighted average cost (max(old,0)), cost history, auto variable expense. */
export async function recordPurchase(db: Exec, p: PurchaseInput, actor: string) {
  assertInt(p.qtyBase, "qty"); assertInt(p.totalMillimes, "total");
  if (p.qtyBase <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
  if (p.totalMillimes < 0) throw new Error("السعر لا يمكن أن يكون سالباً");
  if (!p.opening && p.paidFrom === "drawer" && !p.invoiceRef?.trim()) throw new Error("مصروف من الدرج يجب أن يطابق فاتورة شراء (رقم الفاتورة مطلوب)");
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, p.stockItemId));
  if (!item) throw new Error("مادة غير موجودة");
  const oldQty = Math.max(item.qtyBase, 0);
  const oldCost = Number(item.costPerBase);
  const newCost = (oldQty * oldCost + p.totalMillimes) / (oldQty + p.qtyBase);
  const mv = await applyMovement(db, {
    ts: p.ts, stockItemId: p.stockItemId, deltaBase: p.qtyBase, type: "purchase",
    refType: p.opening ? "opening" : "purchase", note: p.note ?? null, createdBy: actor,
  });
  await db.update(stockItems).set({ costPerBase: newCost.toFixed(10) }).where(eq(stockItems.id, p.stockItemId));
  await db.insert(stockCostHistory).values({ stockItemId: p.stockItemId, costPerBase: newCost.toFixed(10), effectiveFrom: p.ts, purchaseMovementId: mv.id });
  let expenseId: number | null = null;
  if (!p.opening) {
    const s = await getSettings(db);
    const paidAt = p.paidFrom === "drawer" ? (p.paidAt ?? p.ts) : (p.paidAt ?? null);
    const day = shiftInfo(paidAt ?? p.ts, s.morning_start_hour, s.evening_start_hour).businessDay;
    const [e] = await db.insert(expenses).values({
      kind: "variable", category: "مشتريات", label: `شراء: ${item.nameAr} (${formatQty(item.kind as StockKind, p.qtyBase)})`,
      amountMillimes: p.totalMillimes, recurrence: "once", startDay: day, endDay: day, isPurchase: true,
      purchaseRef: mv.id, paidFrom: p.paidFrom, paidAt, invoiceRef: p.invoiceRef?.trim() || null, createdBy: actor,
    }).returning();
    expenseId = e.id;
  }
  await audit(db, actor, p.opening ? "stock.opening" : "stock.purchase", "stock_item", p.stockItemId,
    { qtyBase: item.qtyBase, costPerBase: item.costPerBase },
    { movementId: mv.id, qtyBase: p.qtyBase, totalMillimes: p.totalMillimes, newCost, expenseId, paidFrom: p.paidFrom, invoiceRef: p.invoiceRef });
  await checkStockAlerts(db, [p.stockItemId]);
  return { movementId: mv.id, expenseId, newCost };
}

/** Waste / staff consumption — explained losses (negative movement with a note). */
export async function recordExplainedLoss(db: Exec, type: "waste" | "staff_consumption", stockItemId: number, qtyBase: number, ts: Date, note: string, actor: string) {
  assertInt(qtyBase, "qty");
  if (qtyBase <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
  if (!note.trim()) throw new Error("الملاحظة مطلوبة");
  const mv = await applyMovement(db, { ts, stockItemId, deltaBase: -qtyBase, type, note, createdBy: actor });
  await audit(db, actor, `stock.${type}`, "stock_item", stockItemId, null, mv);
  await checkStockAlerts(db, [stockItemId]);
  return mv;
}

export type Handover = "morning_to_evening" | "evening_to_morning" | "unannounced" | "weekly";
export const HANDOVER_AR: Record<Handover, string> = {
  morning_to_evening: "تسليم صباحية ← مسائية",
  evening_to_morning: "تسليم مسائية ← صباحية",
  unannounced: "جرد مفاجئ",
  weekly: "جرد أسبوعي",
};

/** Which shift's activity a count closes. */
export function evaluatedShiftFor(handover: Handover, ts: Date, s: Pick<Settings, "morning_start_hour" | "evening_start_hour">): { businessDay: string; shift: Shift } {
  const info = shiftInfo(ts, s.morning_start_hour, s.evening_start_hour);
  if (handover === "morning_to_evening") {
    // count made around 15:00: closes the morning shift of that business day
    return { businessDay: info.businessDay, shift: "morning" };
  }
  if (handover === "evening_to_morning") {
    // count made around 06:00: closes the evening shift of the previous business day
    return info.shift === "morning" ? { businessDay: addDays(info.businessDay, -1), shift: "evening" } : { businessDay: info.businessDay, shift: "evening" };
  }
  return info;
}

/** Units sold and expected margin surplus for a stock item over (from, to] — spec §7.4. */
export async function salesBetween(db: Exec, stockItemId: number, from: Date | null, to: Date) {
  const conds = [
    eq(recipeLines.stockItemId, stockItemId),
    ne(orders.status, "void"),
    lte(orders.effectiveTs, to),
  ];
  if (from) conds.push(gt(orders.effectiveTs, from));
  const [r] = await db.select({
    units: sql<string>`coalesce(sum(${orderItems.qty}), 0)`,
    surplus: sql<string>`coalesce(sum(${orderItems.qty} * (${recipeLines.qtyBase} - ${recipeLines.realQtyBase})), 0)`,
  }).from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(recipeLines, and(eq(recipeLines.recipeVersionId, orderItems.recipeVersionId), eq(recipeLines.stockItemId, stockItemId)))
    .where(and(...conds));
  return { unitsSold: Number(r.units), expectedSurplus: roundHalfUp(Number(r.surplus), 3) };
}

/** Pure margin formulas (spec §7.4). */
export function marginAnalysis(variance: number, expectedSurplus: number, costPerBase: number) {
  const marginUsedPct = expectedSurplus > 0 ? roundHalfUp(((expectedSurplus - variance) / expectedSurplus) * 100, 2) : null;
  const value = roundHalfUp(variance * costPerBase, 3);
  return { marginUsedPct, value };
}

export interface CountEntry { stockItemId: number; countedBase: number }

/** Record a physical count (entered by the Owner from the trusted person's paper, with the ACTUAL count time). */
export async function recordCount(db: Exec, input: {
  ts: Date; handover: Handover; entries: CountEntry[]; countedBy?: string | null; note?: string | null;
}, actor: string) {
  const s = await getSettings(db);
  if (input.ts.getTime() > Date.now() + 5 * 60_000) throw new Error("وقت الجرد في المستقبل");
  const ev = evaluatedShiftFor(input.handover, input.ts, s);
  const results = [];
  for (const e of input.entries) {
    assertInt(e.countedBase, "counted");
    if (e.countedBase < 0) throw new Error("الكمية لا يمكن أن تكون سالبة");
    const [item] = await db.select().from(stockItems).where(eq(stockItems.id, e.stockItemId));
    if (!item) throw new Error("مادة غير موجودة");
    const theoretical = await theoreticalAt(db, item.id, input.ts);
    const [prev] = await db.select({ ts: stockCounts.ts }).from(stockCounts)
      .where(and(eq(stockCounts.stockItemId, item.id), lt(stockCounts.ts, input.ts), isNull(stockCounts.cancelledAt)))
      .orderBy(desc(stockCounts.ts)).limit(1);
    const { unitsSold, expectedSurplus } = await salesBetween(db, item.id, prev?.ts ?? null, input.ts);
    const variance = e.countedBase - theoretical;
    const cost = await costAt(db, item.id, input.ts);
    const { marginUsedPct, value } = marginAnalysis(variance, expectedSurplus, cost);
    const [row] = await db.insert(stockCounts).values({
      ts: input.ts, businessDay: ev.businessDay, evaluatedShift: ev.shift, handover: input.handover,
      stockItemId: item.id, theoreticalBase: theoretical, countedBase: e.countedBase, varianceBase: variance,
      expectedSurplusBase: expectedSurplus.toFixed(3), marginUsedPct: marginUsedPct === null ? null : marginUsedPct.toFixed(2),
      valueMillimes: value.toFixed(3), unitsSold, countedBy: input.countedBy ?? null, note: input.note ?? null,
    }).returning();
    if (variance !== 0) {
      await applyMovement(db, {
        ts: input.ts, stockItemId: item.id, deltaBase: variance, type: "count_adjust",
        refType: "stock_count", refId: String(row.id), note: "تسوية بعد الجرد", createdBy: actor,
      });
    }
    await countAlerts(db, s, item, row.id, variance, expectedSurplus, marginUsedPct, value, ev);
    results.push({ ...row, itemName: item.nameAr, kind: item.kind });
  }
  await audit(db, actor, "stock.count", "stock_count", results.map((r) => r.id).join(","), null,
    { ts: input.ts, handover: input.handover, countedBy: input.countedBy, entries: input.entries });
  await checkStockAlerts(db, input.entries.map((e) => e.stockItemId));
  return results;
}

async function countAlerts(
  db: Exec, s: Settings, item: typeof stockItems.$inferSelect, countId: number, variance: number,
  expectedSurplus: number, marginUsedPct: number | null, value: number, ev: { businessDay: string; shift: Shift },
) {
  const kind = item.kind as StockKind;
  const where = `${ev.businessDay} ${SHIFT_AR[ev.shift]}`;
  const base = { ref: `stock_count:${countId}`, businessDay: ev.businessDay, shift: ev.shift };
  if (kind === "piece") {
    if (variance < 0) {
      await raiseAlert(db, { ...base, severity: "warn", type: "piece_variance", message: `يحتاج مراجعة: نقص ${formatQty(kind, -variance)} من "${item.nameAr}" (${where})` });
    }
  } else if (expectedSurplus > 0 && marginUsedPct !== null) {
    if (marginUsedPct >= s.margin_critical_pct) {
      await raiseAlert(db, { ...base, severity: "critical", type: "margin_critical", message: `يحتاج مراجعة: الهامش المستعمل ${marginUsedPct}% لـ "${item.nameAr}" (${where})` });
    }
  } else if (variance < 0) {
    await raiseAlert(db, { ...base, severity: "warn", type: "negative_variance", message: `يحتاج مراجعة: نقص ${formatQty(kind, -variance)} من "${item.nameAr}" (${where})` });
  }
  if (variance < 0 && Math.abs(value) >= s.variance_value_critical_millimes) {
    await raiseAlert(db, { ...base, severity: "critical", type: "variance_value", message: `قيمة الفرق ${formatDT(value)} لـ "${item.nameAr}" (${where})` });
  }
  // repeated high margin use for the same shift (pattern, not a single signal)
  if (kind !== "piece") {
    const last = await db.select({ m: stockCounts.marginUsedPct }).from(stockCounts)
      .where(and(eq(stockCounts.stockItemId, item.id), eq(stockCounts.evaluatedShift, ev.shift), inArray(stockCounts.handover, ["morning_to_evening", "evening_to_morning"]), isNull(stockCounts.cancelledAt)))
      .orderBy(desc(stockCounts.ts)).limit(s.margin_warn_consecutive);
    if (last.length >= s.margin_warn_consecutive && last.every((r) => r.m !== null && Number(r.m) >= s.margin_warn_pct)) {
      await raiseAlert(db, {
        ...base, severity: "warn", type: "margin_repeated", dedupeKey: `margin_repeated:${item.id}:${ev.shift}:${ev.businessDay}`,
        message: `نمط يحتاج مراجعة: الشيفت ${SHIFT_AR[ev.shift]} استعمل ≥${s.margin_warn_pct}% من هامش "${item.nameAr}" ${s.margin_warn_consecutive} مرات متتالية`,
      });
    }
  }
}

/** Average daily consumption over the window (sales net of voids), in base units/day. */
export async function avgDailyConsumption(db: Exec, stockItemId: number, windowDays: number, now = new Date()) {
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const [r] = await db.select({ s: sql<string>`coalesce(sum(${stockMovements.deltaBase}), 0)` }).from(stockMovements)
    .where(and(eq(stockMovements.stockItemId, stockItemId), inArray(stockMovements.type, ["sale", "void", "staff_consumption", "waste"]), gte(stockMovements.ts, from), lte(stockMovements.ts, now)));
  const consumed = -Number(r.s);
  return consumed > 0 ? consumed / windowDays : 0;
}

export function daysLeft(qty: number, avgPerDay: number): number | null {
  if (avgPerDay <= 0) return null;
  return Math.max(0, qty) / avgPerDay;
}

/** Low-stock, running-out (early warning) and negative-stock alerts. Auto-resolves when no longer true. */
export async function checkStockAlerts(db: Exec, itemIds?: number[], now = new Date()) {
  const s = await getSettings(db);
  const items = itemIds?.length
    ? await db.select().from(stockItems).where(inArray(stockItems.id, itemIds))
    : await db.select().from(stockItems).where(eq(stockItems.active, true));
  for (const it of items) {
    if (!it.active) continue;
    const kind = it.kind as StockKind;
    const kNeg = `negative_stock:${it.id}`, kLow = `low_stock:${it.id}`, kRun = `stock_running_out:${it.id}`;
    if (it.qtyBase < 0) await raiseAlert(db, { severity: "warn", type: "negative_stock", dedupeKey: kNeg, message: `مخزون سالب: "${it.nameAr}" = ${formatQty(kind, it.qtyBase)} — هل نسيت تسجيل شراء؟` });
    else await resolveAlerts(db, kNeg);
    if (it.minQtyBase > 0 && it.qtyBase < it.minQtyBase) {
      await raiseAlert(db, { severity: "warn", type: "low_stock", dedupeKey: kLow, message: `يجب الشراء: "${it.nameAr}" = ${formatQty(kind, it.qtyBase)} (الحد الأدنى ${formatQty(kind, it.minQtyBase)})` });
    } else await resolveAlerts(db, kLow);
    const avg = await avgDailyConsumption(db, it.id, s.consumption_window_days, now);
    const dl = daysLeft(it.qtyBase, avg);
    if (dl !== null && dl <= s.reorder_days_ahead) {
      await raiseAlert(db, {
        severity: "warn", type: "stock_running_out", dedupeKey: kRun,
        message: `المخزون سينفد خلال ${dl.toFixed(1)} يوم: "${it.nameAr}" = ${formatQty(kind, it.qtyBase)} (الاستهلاك ≈ ${formatQty(kind, Math.round(avg))}/يوم)`,
      });
    } else await resolveAlerts(db, kRun);
  }
}

export interface ShiftStockLine { itemId: number; name: string; kind: StockKind; theoretical: number; counted: number; variance: number; value: number; marginUsedPct: number | null; countedAt: Date }
export interface ShiftStockReport {
  businessDay: string; shift: Shift; orders: number; counted: boolean;
  lines: ShiftStockLine[]; shortages: number; /** lines with a negative variance */
}

/**
 * Per shift: what the stock count found compared with what the orders say should be there.
 * A count closes one shift (see evaluatedShiftFor), so a shortage points at the shift it is filed under.
 * Shifts with orders but no count are listed as "not counted".
 */
export async function shiftStockReport(db: Exec, fromDay: string, toDay: string): Promise<ShiftStockReport[]> {
  const counts = await db.select({ c: stockCounts, name: stockItems.nameAr, kind: stockItems.kind }).from(stockCounts)
    .innerJoin(stockItems, eq(stockItems.id, stockCounts.stockItemId))
    .where(and(gte(stockCounts.businessDay, fromDay), lte(stockCounts.businessDay, toDay), isNull(stockCounts.cancelledAt)))
    .orderBy(asc(stockCounts.ts), asc(stockItems.nameAr));
  const ord = await db.select({ day: orders.businessDay, shift: orders.shift, n: sql<string>`count(*)` }).from(orders)
    .where(and(gte(orders.businessDay, fromDay), lte(orders.businessDay, toDay), ne(orders.status, "void")))
    .groupBy(orders.businessDay, orders.shift);
  const map = new Map<string, ShiftStockReport>();
  const get = (day: string, shift: string) => {
    const k = `${day}:${shift}`;
    if (!map.has(k)) map.set(k, { businessDay: day, shift: shift as Shift, orders: 0, counted: false, lines: [], shortages: 0 });
    return map.get(k)!;
  };
  for (const o of ord) get(o.day, o.shift).orders = Number(o.n);
  for (const { c, name, kind } of counts) {
    const r = get(c.businessDay, c.evaluatedShift);
    r.counted = true;
    // the latest count of an item in that shift wins
    const i = r.lines.findIndex((l) => l.itemId === c.stockItemId);
    const line: ShiftStockLine = {
      itemId: c.stockItemId, name, kind: kind as StockKind, theoretical: c.theoreticalBase, counted: c.countedBase, variance: c.varianceBase,
      value: Number(c.valueMillimes ?? 0), marginUsedPct: c.marginUsedPct === null ? null : Number(c.marginUsedPct), countedAt: c.ts,
    };
    if (i >= 0) r.lines[i] = line; else r.lines.push(line);
  }
  for (const r of map.values()) r.shortages = r.lines.filter((l) => l.variance < 0).length;
  return [...map.values()].sort((a, b) => (a.businessDay === b.businessDay ? (a.shift === "morning" ? 1 : -1) : a.businessDay < b.businessDay ? 1 : -1));
}
