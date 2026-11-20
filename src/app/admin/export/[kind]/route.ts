import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { expenses, orders, stockCounts, stockItems } from "@/db/schema";
import { getAdmin } from "@/server/auth";
import { audit } from "@/server/audit";
import { creditAging, orderLinesFor, productStats, shiftRows } from "@/server/finance";
import { formatTunis } from "@/lib/time";

export const dynamic = "force-dynamic";

const dt = (m: number | string | null | undefined) => (m === null || m === undefined ? "" : (Number(m) / 1000).toFixed(3));

function csv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const admin = await getAdmin();
  if (!admin) return new Response("unauthorized", { status: 401 });
  const { kind } = await params;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2000-01-01";
  const to = url.searchParams.get("to") ?? "2999-12-31";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return new Response("bad range", { status: 400 });
  const db = await getDb();
  let rows: (string | number | null | undefined)[][] = [];
  if (kind === "orders") {
    const os = await db.select().from(orders).where(and(gte(orders.businessDay, from), lte(orders.businessDay, to))).orderBy(asc(orders.effectiveTs));
    const lines = await orderLinesFor(db, os.map((o) => o.id));
    rows = [["order", "time_tunis", "business_day", "shift", "status", "payment", "total_dt", "cost_dt", "items", "flags"]];
    for (const o of os) rows.push([o.orderLabel, formatTunis(o.effectiveTs, true), o.businessDay, o.shift, o.status, o.paymentType, dt(o.totalMillimes), dt(o.costMillimes), lines.filter((l) => l.orderId === o.id).map((l) => `${l.name} x${l.qty}`).join(" | "), o.flags.join(" ")]);
  } else if (kind === "products") {
    rows = [["product", "units", "paid", "free", "credit", "revenue_dt", "cost_dt", "profit_dt", "price_dt", "unit_cost_dt", "unit_margin_dt", "loss_making"]];
    for (const p of await productStats(db, from, to)) rows.push([p.name, p.units, p.paidUnits, p.freeUnits, p.creditUnits, dt(p.revenue), dt(p.cost), dt(p.profit), dt(p.currentPrice), dt(p.currentUnitCost), dt(p.unitMargin), p.lossMaking ? "yes" : ""]);
  } else if (kind === "shifts") {
    rows = [["business_day", "shift", "worker", "orders", "voids", "ticket_orders", "cash_sales_dt", "margin_used_avg", "margin_used_max", "cash_variance_dt", "ticket_mismatch", "risk", "color"]];
    for (const r of await shiftRows(db, from, to)) rows.push([r.businessDay, r.shift, r.worker, r.orders, r.voids, r.ticketOrders, dt(r.salesCash), r.marginUsedAvg, r.marginUsedMax, dt(r.cashVariance), r.ticketMismatch === null ? "" : r.ticketMismatch ? "yes" : "no", r.risk, r.color]);
  } else if (kind === "counts") {
    const cs = await db.select({ c: stockCounts, name: stockItems.nameAr }).from(stockCounts).innerJoin(stockItems, eq(stockItems.id, stockCounts.stockItemId))
      .where(and(gte(stockCounts.businessDay, from), lte(stockCounts.businessDay, to))).orderBy(asc(stockCounts.ts));
    rows = [["time_tunis", "item", "handover", "business_day", "evaluated_shift", "theoretical_base", "counted_base", "variance_base", "units_sold", "expected_surplus_base", "margin_used_pct", "value_dt", "counted_by"]];
    for (const { c, name } of cs) rows.push([formatTunis(c.ts), name, c.handover, c.businessDay, c.evaluatedShift, c.theoreticalBase, c.countedBase, c.varianceBase, c.unitsSold, c.expectedSurplusBase, c.marginUsedPct, dt(c.valueMillimes), c.countedBy]);
  } else if (kind === "expenses") {
    const es = await db.select().from(expenses).where(and(gte(expenses.startDay, from), lte(expenses.startDay, to))).orderBy(asc(expenses.startDay));
    rows = [["day", "kind", "category", "label", "amount_dt", "recurrence", "end_day", "purchase", "paid_from", "paid_at", "invoice", "active"]];
    for (const e of es) rows.push([e.startDay, e.kind, e.category, e.label, dt(e.amountMillimes), e.recurrence, e.endDay, e.isPurchase ? "yes" : "", e.paidFrom, formatTunis(e.paidAt), e.invoiceRef, e.active ? "yes" : "no"]);
  } else if (kind === "credit") {
    rows = [["customer", "phone", "balance_dt", "oldest_unpaid_day", "age_days", "remaining_tickets"]];
    for (const c of await creditAging(db, to)) rows.push([c.name, c.phone, dt(c.balance), c.oldestUnpaidDay, c.ageDays, c.remainingTickets]);
  } else {
    return new Response("unknown export", { status: 404 });
  }
  await audit(db, admin.email, "export.csv", "export", kind, null, { from, to });
  return new Response(csv(rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${kind}_${from}_${to}.csv"`, "cache-control": "no-store" },
  });
}
