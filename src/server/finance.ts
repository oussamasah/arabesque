import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  cashCounts, creditLedger, customers, expenses, orderItems, orders, products, roster, stockCounts, stockItems, tickets,
} from "@/db/schema";
import type { Exec } from "@/db";
import { audit, raiseAlert } from "./audit";
import { getSettings, type Settings } from "./settings";
import { priceAt, recipeAt } from "./catalog";
import { costAt } from "./stock";
import { assertInt, formatDT, roundHalfUp } from "@/lib/money";
import { daysInMonth, eachDay, shiftEnd, shiftStart, SHIFT_AR, tunisParts, type Shift } from "@/lib/time";

// ---------------------------------------------------------------- roster
export async function workerFor(db: Exec, businessDay: string, shift: Shift, s?: Settings): Promise<string> {
  const [r] = await db.select().from(roster).where(and(eq(roster.businessDay, businessDay), eq(roster.shift, shift)));
  if (r) return r.workerName;
  const st = s ?? (await getSettings(db));
  return (shift === "morning" ? st.default_worker_morning : st.default_worker_evening) || "—";
}

export async function setRoster(db: Exec, businessDay: string, shift: Shift, workerName: string, actor: string) {
  const [before] = await db.select().from(roster).where(and(eq(roster.businessDay, businessDay), eq(roster.shift, shift)));
  if (!workerName.trim()) {
    if (before) {
      // clearing = fallback to default; we keep history in the audit log
      await db.delete(roster).where(and(eq(roster.businessDay, businessDay), eq(roster.shift, shift)));
    }
  } else if (before) {
    await db.update(roster).set({ workerName: workerName.trim() }).where(and(eq(roster.businessDay, businessDay), eq(roster.shift, shift)));
  } else {
    await db.insert(roster).values({ businessDay, shift, workerName: workerName.trim() });
  }
  await audit(db, actor, "roster.set", "roster", `${businessDay}:${shift}`, before ?? null, { workerName });
}

// ---------------------------------------------------------------- expenses
export interface ExpenseInput {
  kind: "fixed" | "variable"; category: string; label: string; amountMillimes: number;
  startDay: string; endDay?: string | null; paidFrom?: "drawer" | "owner"; paidAt?: Date | null; invoiceRef?: string | null;
}

export async function createExpense(db: Exec, e: ExpenseInput, actor: string) {
  assertInt(e.amountMillimes, "amount");
  if (e.amountMillimes <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  if (!e.label.trim()) throw new Error("الوصف مطلوب");
  const paidFrom = e.kind === "fixed" ? "owner" : e.paidFrom ?? "owner";
  if (paidFrom === "drawer" && !e.invoiceRef?.trim()) throw new Error("مصروف من الدرج يجب أن يطابق فاتورة شراء (رقم الفاتورة مطلوب)");
  if (paidFrom === "drawer" && !e.paidAt) throw new Error("وقت الدفع من الدرج مطلوب");
  const [row] = await db.insert(expenses).values({
    kind: e.kind, category: e.category.trim() || (e.kind === "fixed" ? "ثابت" : "متغير"), label: e.label.trim(),
    amountMillimes: e.amountMillimes, recurrence: e.kind === "fixed" ? "monthly" : "once",
    startDay: e.startDay, endDay: e.kind === "fixed" ? e.endDay || null : e.startDay,
    paidFrom, paidAt: e.paidAt ?? null, invoiceRef: e.invoiceRef?.trim() || null, createdBy: actor,
  }).returning();
  await audit(db, actor, "expense.create", "expense", row.id, null, row);
  return row;
}

/** No hard deletes: an expense is deactivated (or a fixed one ended) with an audit entry. */
export async function deactivateExpense(db: Exec, id: number, actor: string) {
  const [before] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!before) throw new Error("مصروف غير موجود");
  await db.update(expenses).set({ active: false }).where(eq(expenses.id, id));
  await audit(db, actor, "expense.deactivate", "expense", id, before, { active: false });
}

export async function endFixedExpense(db: Exec, id: number, endDay: string, actor: string) {
  const [before] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!before || before.kind !== "fixed") throw new Error("مصروف ثابت غير موجود");
  await db.update(expenses).set({ endDay }).where(eq(expenses.id, id));
  await audit(db, actor, "expense.end", "expense", id, before, { endDay });
}

/** Fixed cost proration: for each day, amount / days in THAT calendar month (spec §7.8, §15). */
export function prorateFixed(list: { amountMillimes: number; startDay: string; endDay: string | null }[], from: string, to: string): number {
  let total = 0;
  for (const d of eachDay(from, to)) {
    const dim = daysInMonth(d);
    for (const e of list) {
      if (e.startDay <= d && (e.endDay === null || d <= e.endDay)) total += e.amountMillimes / dim;
    }
  }
  return roundHalfUp(total);
}

// ---------------------------------------------------------------- cash reconciliation
export async function expectedCash(db: Exec, businessDay: string, shift: Shift) {
  const s = await getSettings(db);
  // money is counted in the shift that TOOK the payment (pay-later orders may be paid in the next shift)
  const [c] = await db.select({ t: sql<string>`coalesce(sum(${orders.totalMillimes}), 0)` }).from(orders)
    .where(and(eq(orders.paidBusinessDay, businessDay), eq(orders.paidShift, shift), eq(orders.paymentType, "cash"), ne(orders.status, "void"),
      sql`not (${orders.flags} && array['paid_to_owner','paid_by_worker']::text[])`));
  const [tk] = await db.select({ n: sql<string>`count(*)` }).from(orders)
    .where(and(eq(orders.paidBusinessDay, businessDay), eq(orders.paidShift, shift), eq(orders.paymentType, "ticket"), ne(orders.status, "void")));
  const start = shiftStart(businessDay, shift, s.morning_start_hour, s.evening_start_hour);
  const end = shiftEnd(businessDay, shift, s.morning_start_hour, s.evening_start_hour);
  const [ex] = await db.select({ t: sql<string>`coalesce(sum(${expenses.amountMillimes}), 0)` }).from(expenses)
    .where(and(eq(expenses.paidFrom, "drawer"), eq(expenses.active, true), gte(expenses.paidAt, start), sql`${expenses.paidAt} < ${end}`));
  // the worker of the SERVING shift is responsible for its orders that are still unpaid (or left without paying)
  const [ow] = await db.select({
    n: sql<string>`count(*)`, t: sql<string>`coalesce(sum(${orders.totalMillimes}), 0)`,
  }).from(orders).where(and(eq(orders.businessDay, businessDay), eq(orders.shift, shift), ne(orders.status, "void"), inArray(orders.paymentType, ["pending", "loss"])));
  const cashSales = Number(c.t);
  const drawerExpenses = Number(ex.t);
  return {
    cashSales, drawerExpenses, expectedCash: cashSales - drawerExpenses, ticketsExpected: Number(tk.n),
    owedByWorker: Number(ow.t), owedCount: Number(ow.n),
  };
}

export async function recordCashCount(db: Exec, input: {
  ts: Date; businessDay: string; shift: Shift; countedCashMillimes: number; ticketsInDrawer: number; countedBy?: string | null; note?: string | null;
}, actor: string) {
  assertInt(input.countedCashMillimes, "cash");
  if (!Number.isInteger(input.ticketsInDrawer) || input.ticketsInDrawer < 0) throw new Error("عدد التذاكر غير صالح");
  const exp = await expectedCash(db, input.businessDay, input.shift);
  const variance = input.countedCashMillimes - exp.expectedCash;
  const [row] = await db.insert(cashCounts).values({
    ts: input.ts, businessDay: input.businessDay, shift: input.shift, expectedCashMillimes: exp.expectedCash,
    countedCashMillimes: input.countedCashMillimes, varianceMillimes: variance, ticketsExpected: exp.ticketsExpected,
    ticketsInDrawer: input.ticketsInDrawer, countedBy: input.countedBy ?? null, note: input.note ?? null,
  }).returning();
  const where = `${input.businessDay} ${SHIFT_AR[input.shift]}`;
  if (variance !== 0) {
    await raiseAlert(db, { severity: variance < 0 ? "warn" : "info", type: "cash_variance", ref: `cash_count:${row.id}`, businessDay: input.businessDay, shift: input.shift, message: `فرق في الكاش ${formatDT(variance)} (${where})` });
  }
  if (exp.owedByWorker > 0) {
    await raiseAlert(db, { severity: "warn", type: "worker_owed", ref: `cash_count:${row.id}`, businessDay: input.businessDay, shift: input.shift, message: `على عامل الشيفت ${formatDT(exp.owedByWorker)}: ${exp.owedCount} طلبات قُدّمت ولم تُدفع (${where})` });
  }
  if (input.ticketsInDrawer !== exp.ticketsExpected) {
    await raiseAlert(db, { severity: "warn", type: "ticket_mismatch", ref: `cash_count:${row.id}`, businessDay: input.businessDay, shift: input.shift, message: `أوراق التذاكر في الدرج ${input.ticketsInDrawer} والطلبات بتذكرة ${exp.ticketsExpected} (${where})` });
  }
  await audit(db, actor, "cash.count", "cash_count", row.id, null, row);
  return row;
}

// ---------------------------------------------------------------- profit & reports (spec §7.8)
export interface ProfitSummary {
  from: string; to: string;
  salesCash: number; creditRepayments: number; revenueCash: number;
  purchases: number; otherVariable: number; fixedProrated: number;
  freeGiveawaysCost: number; creditChargedValue: number; creditOutstanding: number;
  cogs: number; profitCash: number; profitConsumption: number;
  ordersCount: number; voidCount: number; pendingCount: number; ticketOrders: number; ticketValue: number;
  /** pay-later orders not paid yet / recorded as left without paying */
  unpaidCount: number; unpaidValue: number; unpaidLossValue: number;
}

export async function profitSummary(db: Exec, from: string, to: string): Promise<ProfitSummary> {
  const inRange = and(gte(orders.businessDay, from), lte(orders.businessDay, to));
  const [paid] = await db.select({
    salesCash: sql<string>`coalesce(sum(${orders.totalMillimes}), 0)`,
  }).from(orders).where(and(gte(orders.paidBusinessDay, from), lte(orders.paidBusinessDay, to), eq(orders.status, "ok"), eq(orders.paymentType, "cash")));
  const [unp] = await db.select({
    n: sql<string>`count(*) filter (where ${orders.paymentType} = 'pending')`,
    v: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.paymentType} = 'pending'), 0)`,
    lossV: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.paymentType} = 'loss'), 0)`,
  }).from(orders).where(and(inRange, ne(orders.status, "void")));
  const [o] = await db.select({
    cogs: sql<string>`coalesce(sum(case when ${orders.status} = 'ok' then ${orders.costMillimes} else 0 end), 0)`,
    n: sql<string>`count(*) filter (where ${orders.status} <> 'void')`,
    voids: sql<string>`count(*) filter (where ${orders.status} = 'void')`,
    pending: sql<string>`count(*) filter (where ${orders.status} = 'pending_review')`,
    tk: sql<string>`count(*) filter (where ${orders.status} <> 'void' and ${orders.paymentType} = 'ticket')`,
    tkv: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.status} <> 'void' and ${orders.paymentType} = 'ticket'), 0)`,
  }).from(orders).where(inRange);
  const [free] = await db.select({
    free: sql<string>`coalesce(sum(case when ${tickets.type} = 'free' then ${orders.costMillimes} else 0 end), 0)`,
    credit: sql<string>`coalesce(sum(case when ${tickets.type} = 'credit' then ${orders.totalMillimes} else 0 end), 0)`,
  }).from(orders).innerJoin(tickets, eq(tickets.usedOrderId, orders.id)).where(and(inRange, eq(orders.status, "ok")));
  const [rep] = await db.select({ t: sql<string>`coalesce(sum(${creditLedger.amountMillimes}), 0)` }).from(creditLedger)
    .where(and(eq(creditLedger.type, "payment"), gte(creditLedger.businessDay, from), lte(creditLedger.businessDay, to)));
  const [out] = await db.select({
    b: sql<string>`coalesce(sum(case when ${creditLedger.type} = 'payment' then -${creditLedger.amountMillimes} else ${creditLedger.amountMillimes} end), 0)`,
  }).from(creditLedger);
  const vars = await db.select().from(expenses).where(and(eq(expenses.kind, "variable"), eq(expenses.active, true), gte(expenses.startDay, from), lte(expenses.startDay, to)));
  const fixed = await db.select().from(expenses).where(and(eq(expenses.kind, "fixed"), eq(expenses.active, true)));
  const purchases = vars.filter((v) => v.isPurchase).reduce((a, v) => a + v.amountMillimes, 0);
  const otherVariable = vars.filter((v) => !v.isPurchase).reduce((a, v) => a + v.amountMillimes, 0);
  const fixedProrated = prorateFixed(fixed, from, to);
  const salesCash = Number(paid.salesCash);
  const creditRepayments = Number(rep.t);
  const revenueCash = salesCash + creditRepayments;
  const cogs = roundHalfUp(Number(o.cogs));
  return {
    from, to, salesCash, creditRepayments, revenueCash, purchases, otherVariable, fixedProrated,
    freeGiveawaysCost: roundHalfUp(Number(free?.free ?? 0)), creditChargedValue: Number(free?.credit ?? 0),
    creditOutstanding: Number(out.b), cogs,
    profitCash: revenueCash - purchases - otherVariable - fixedProrated,
    profitConsumption: revenueCash - cogs - otherVariable - fixedProrated,
    ordersCount: Number(o.n), voidCount: Number(o.voids), pendingCount: Number(o.pending), ticketOrders: Number(o.tk), ticketValue: Number(o.tkv),
    unpaidCount: Number(unp.n), unpaidValue: Number(unp.v), unpaidLossValue: Number(unp.lossV),
  };
}

export interface ShiftRow {
  businessDay: string; shift: Shift; worker: string; orders: number; voids: number; ticketOrders: number; ticketValue: number; totalValue: number; pending: number;
  /** orders served in this shift that were not paid (still pending, or recorded as left without paying) */
  unpaid: number;
  /** value of those orders: owed by the shift worker until paid */
  owedByWorker: number;
  salesCash: number; marginUsedAvg: number | null; marginUsedMax: number | null; cashVariance: number | null;
  ticketMismatch: boolean | null; integrityFlags: number; negativePieceVariance: boolean;
  risk: number; color: "green" | "yellow" | "red";
}

export async function shiftRows(db: Exec, from: string, to: string): Promise<ShiftRow[]> {
  const s = await getSettings(db);
  const w = s.risk_weights;
  const ord = await db.select({
    day: orders.businessDay, shift: orders.shift,
    n: sql<string>`count(*) filter (where ${orders.status} <> 'void')`,
    voids: sql<string>`count(*) filter (where ${orders.status} = 'void')`,
    tk: sql<string>`count(*) filter (where ${orders.status} <> 'void' and ${orders.paymentType} = 'ticket')`,
    tkv: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.status} <> 'void' and ${orders.paymentType} = 'ticket'), 0)`,
    tot: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.status} <> 'void'), 0)`,
    pending: sql<string>`count(*) filter (where ${orders.status} = 'pending_review')`,
    unpaid: sql<string>`count(*) filter (where ${orders.status} <> 'void' and ${orders.paymentType} in ('pending','loss'))`,
    owed: sql<string>`coalesce(sum(${orders.totalMillimes}) filter (where ${orders.status} <> 'void' and ${orders.paymentType} in ('pending','loss')), 0)`,
    integ: sql<string>`count(*) filter (where ${orders.flags} && array['chain_broken','sequence_gap','clock_skew']::text[])`,
  }).from(orders).where(and(gte(orders.businessDay, from), lte(orders.businessDay, to))).groupBy(orders.businessDay, orders.shift);
  // cash is attributed to the shift that took the payment
  const paidRows = await db.select({
    day: orders.paidBusinessDay, shift: orders.paidShift,
    cash: sql<string>`coalesce(sum(${orders.totalMillimes}), 0)`,
  }).from(orders).where(and(gte(orders.paidBusinessDay, from), lte(orders.paidBusinessDay, to), eq(orders.status, "ok"), eq(orders.paymentType, "cash")))
    .groupBy(orders.paidBusinessDay, orders.paidShift);
  const counts = await db.select({ day: stockCounts.businessDay, shift: stockCounts.evaluatedShift, m: stockCounts.marginUsedPct, v: stockCounts.varianceBase, kind: stockItems.kind })
    .from(stockCounts).innerJoin(stockItems, eq(stockItems.id, stockCounts.stockItemId))
    .where(and(gte(stockCounts.businessDay, from), lte(stockCounts.businessDay, to), isNull(stockCounts.cancelledAt)));
  const cash = await db.select().from(cashCounts).where(and(gte(cashCounts.businessDay, from), lte(cashCounts.businessDay, to), isNull(cashCounts.cancelledAt))).orderBy(asc(cashCounts.ts));
  const rosterRows = await db.select().from(roster).where(and(gte(roster.businessDay, from), lte(roster.businessDay, to)));
  const out: ShiftRow[] = [];
  for (const d of eachDay(from, to)) {
    for (const sh of ["morning", "evening"] as Shift[]) {
      const o = ord.find((r) => r.day === d && r.shift === sh);
      const pr = paidRows.find((r) => r.day === d && r.shift === sh);
      const cs = counts.filter((c) => c.day === d && c.shift === sh);
      const margins = cs.filter((c) => c.m !== null).map((c) => Number(c.m));
      const cc = cash.filter((c) => c.businessDay === d && c.shift === sh).at(-1);
      const rr = rosterRows.find((r) => r.businessDay === d && r.shift === sh);
      const worker = rr?.workerName || (sh === "morning" ? s.default_worker_morning : s.default_worker_evening) || "—";
      const row: ShiftRow = {
        businessDay: d, shift: sh, worker,
        orders: Number(o?.n ?? 0), voids: Number(o?.voids ?? 0), ticketOrders: Number(o?.tk ?? 0), ticketValue: Number(o?.tkv ?? 0), totalValue: Number(o?.tot ?? 0), pending: Number(o?.pending ?? 0),
        salesCash: Number(pr?.cash ?? 0),
        unpaid: Number(o?.unpaid ?? 0),
        owedByWorker: Number(o?.owed ?? 0),
        marginUsedAvg: margins.length ? roundHalfUp(margins.reduce((a, b) => a + b, 0) / margins.length, 1) : null,
        marginUsedMax: margins.length ? Math.max(...margins) : null,
        cashVariance: cc ? cc.varianceMillimes : null,
        ticketMismatch: cc ? cc.ticketsInDrawer !== cc.ticketsExpected : null,
        integrityFlags: Number(o?.integ ?? 0),
        negativePieceVariance: cs.some((c) => c.kind === "piece" && c.v < 0),
        risk: 0, color: "green",
      };
      let risk = 0;
      if (row.cashVariance !== null && row.cashVariance !== 0) risk += w.cash_variance;
      if (row.ticketMismatch) risk += w.ticket_mismatch;
      if (row.marginUsedMax !== null && row.marginUsedMax >= s.margin_critical_pct) risk += w.margin_critical;
      else if (row.marginUsedMax !== null && row.marginUsedMax >= s.margin_warn_pct) risk += w.margin_warn;
      if (row.voids >= s.void_spike_count) risk += w.void_spike;
      if (row.integrityFlags > 0) risk += w.integrity;
      if (row.negativePieceVariance) risk += w.negative_piece_variance;
      if (row.unpaid > 0) risk += w.unpaid_orders;
      row.risk = risk;
      row.color = risk >= s.risk_red_at ? "red" : risk >= s.risk_yellow_at ? "yellow" : "green";
      if (o || pr || cs.length || cc) out.push(row);
    }
  }
  return out;
}

export interface ProductStat {
  productId: number; name: string; units: number; paidUnits: number; freeUnits: number; creditUnits: number; unpaidUnits: number;
  revenue: number; cost: number; profit: number; currentPrice: number | null; currentUnitCost: number; unitMargin: number | null; lossMaking: boolean;
}

/** Per-product profitability (spec §7.9, §15). */
export async function productStats(db: Exec, from: string, to: string): Promise<ProductStat[]> {
  const rows = await db.select({
    pid: orderItems.productId, qty: orderItems.qty, price: orderItems.unitPriceMillimes, cost: orderItems.unitCostMillimes,
    pay: orders.paymentType, ttype: tickets.type,
  }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).leftJoin(tickets, eq(tickets.usedOrderId, orders.id))
    .where(and(gte(orders.businessDay, from), lte(orders.businessDay, to), ne(orders.status, "void")));
  const prods = await db.select().from(products);
  const now = new Date();
  const out: ProductStat[] = [];
  for (const p of prods) {
    const mine = rows.filter((r) => r.pid === p.id);
    const currentPrice = await priceAt(db, p.id, now);
    const recipe = await recipeAt(db, p.id, now);
    let currentUnitCost = 0;
    for (const l of recipe?.lines ?? []) currentUnitCost += l.qtyBase * (await costAt(db, l.stockItemId, now));
    currentUnitCost = roundHalfUp(currentUnitCost, 3);
    if (!mine.length && !p.active) continue;
    const st: ProductStat = {
      productId: p.id, name: p.nameAr, units: 0, paidUnits: 0, freeUnits: 0, creditUnits: 0, unpaidUnits: 0, revenue: 0, cost: 0, profit: 0,
      currentPrice, currentUnitCost, unitMargin: currentPrice === null ? null : roundHalfUp(currentPrice - currentUnitCost, 3), lossMaking: false,
    };
    for (const r of mine) {
      st.units += r.qty;
      st.cost += r.qty * Number(r.cost);
      if (r.pay === "cash") { st.paidUnits += r.qty; st.revenue += r.qty * r.price; }
      else if (r.pay === "pending" || r.pay === "loss") st.unpaidUnits += r.qty;
      else if (r.ttype === "credit") st.creditUnits += r.qty;
      else st.freeUnits += r.qty;
    }
    st.cost = roundHalfUp(st.cost, 3);
    st.profit = roundHalfUp(st.revenue - st.cost, 3);
    st.lossMaking = (st.unitMargin !== null && st.unitMargin < 0) || (st.units > 0 && st.profit < 0);
    out.push(st);
  }
  return out.sort((a, b) => b.units - a.units);
}

export async function salesByHour(db: Exec, from: string, to: string) {
  const rows = await db.select({ ts: orders.effectiveTs, total: orders.totalMillimes, pay: orders.paymentType, status: orders.status })
    .from(orders).where(and(gte(orders.businessDay, from), lte(orders.businessDay, to), ne(orders.status, "void")));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, salesCash: 0 }));
  for (const r of rows) {
    const h = tunisParts(r.ts).hour;
    hours[h].orders++;
    if (r.pay === "cash" && r.status === "ok") hours[h].salesCash += r.total;
  }
  return hours;
}

export async function workerStats(db: Exec, from: string, to: string) {
  const rows = await shiftRows(db, from, to);
  const map = new Map<string, { worker: string; shifts: number; orders: number; voids: number; ticketOrders: number; salesCash: number; marginSum: number; marginN: number; cashVariance: number; red: number; yellow: number }>();
  for (const r of rows) {
    const m = map.get(r.worker) ?? { worker: r.worker, shifts: 0, orders: 0, voids: 0, ticketOrders: 0, salesCash: 0, marginSum: 0, marginN: 0, cashVariance: 0, red: 0, yellow: 0 };
    m.shifts++; m.orders += r.orders; m.voids += r.voids; m.ticketOrders += r.ticketOrders; m.salesCash += r.salesCash;
    if (r.marginUsedAvg !== null) { m.marginSum += r.marginUsedAvg; m.marginN++; }
    if (r.cashVariance) m.cashVariance += r.cashVariance;
    if (r.color === "red") m.red++; else if (r.color === "yellow") m.yellow++;
    map.set(r.worker, m);
  }
  return [...map.values()].map((m) => ({ ...m, marginAvg: m.marginN ? roundHalfUp(m.marginSum / m.marginN, 1) : null }));
}

/** Outstanding credit per customer with FIFO aging of unpaid charges. */
export async function creditAging(db: Exec, today: string) {
  const custs = await db.select().from(customers).where(isNull(customers.deletedAt)).orderBy(asc(customers.name));
  const ledger = await db.select().from(creditLedger).orderBy(asc(creditLedger.ts), asc(creditLedger.id));
  const out = [];
  for (const c of custs) {
    const mine = ledger.filter((l) => l.customerId === c.id);
    const charges: { day: string; left: number }[] = [];
    let credit = 0; // payments and negative adjustments to apply
    for (const l of mine) {
      if (l.type === "charge" || (l.type === "adjustment" && l.amountMillimes > 0)) charges.push({ day: l.businessDay, left: l.amountMillimes });
      else credit += l.type === "payment" ? l.amountMillimes : -l.amountMillimes;
    }
    for (const ch of charges) { const take = Math.min(ch.left, credit); ch.left -= take; credit -= take; }
    const open = charges.filter((ch) => ch.left > 0);
    const balance = open.reduce((a, ch) => a + ch.left, 0) - credit;
    const oldest = open[0]?.day ?? null;
    const ageDays = oldest ? Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) : null;
    const remaining = Number((await db.select({ n: sql<string>`count(*)` }).from(tickets).where(and(eq(tickets.customerId, c.id), eq(tickets.status, "issued"))))[0].n);
    out.push({ customerId: c.id, name: c.name, phone: c.phone, balance, oldestUnpaidDay: oldest, ageDays, remainingTickets: remaining, active: c.active });
  }
  return out;
}

export async function ordersForReconciliation(db: Exec, businessDay: string, shift: Shift) {
  return db.select({
    id: orders.id, label: orders.orderLabel, total: orders.totalMillimes, status: orders.status, ts: orders.effectiveTs,
    ticketCode: tickets.shortCode, customer: tickets.customerName, type: tickets.type,
  }).from(orders).leftJoin(tickets, eq(tickets.id, orders.ticketId))
    .where(and(eq(orders.paidBusinessDay, businessDay), eq(orders.paidShift, shift), eq(orders.paymentType, "ticket"), ne(orders.status, "void")))
    .orderBy(asc(orders.paidAt));
}

export async function orderLinesFor(db: Exec, orderIds: string[]) {
  if (!orderIds.length) return [];
  return db.select({ orderId: orderItems.orderId, name: products.nameAr, qty: orderItems.qty, price: orderItems.unitPriceMillimes, cost: orderItems.unitCostMillimes })
    .from(orderItems).innerJoin(products, eq(products.id, orderItems.productId)).where(inArray(orderItems.orderId, orderIds));
}
