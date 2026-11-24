import "server-only";
/**
 * Owner corrections (spec §3 rule 7: no hard deletes, no silent edits).
 * Every correction is a NEW record (reversal movement, voided flag, soft delete) plus an audit entry,
 * so mistakes can be fixed while the history needed for theft detection stays intact.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cashCounts, customers, expenses, orders, productPrices, products, recipeLines, recipeVersions,
  stockCostHistory, stockCounts, stockItems, stockMovements, tickets,
} from "@/db/schema";
import type { Exec } from "@/db";
import { audit } from "./audit";
import { applyMovement, checkStockAlerts } from "./stock";
import { createOrder, voidOrder } from "./orders";
import { customerBalance } from "./tickets";
import { assertInt } from "@/lib/money";

const CANCEL_REF = "cancel";

/** Movement ids that have already been cancelled. */
export async function cancelledMovementIds(db: Exec, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ refId: stockMovements.refId }).from(stockMovements)
    .where(and(eq(stockMovements.refType, CANCEL_REF), inArray(stockMovements.refId, ids.map(String))));
  return new Set(rows.map((r) => Number(r.refId)));
}

/**
 * Cancel a purchase, an opening-stock entry, a waste or a staff consumption:
 * a reversing movement at the same time, the purchase expense is deactivated, the average cost is restored.
 */
export async function cancelMovement(db: Exec, movementId: number, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("السبب مطلوب");
  const [m] = await db.select().from(stockMovements).where(eq(stockMovements.id, movementId));
  if (!m) throw new Error("حركة غير موجودة");
  if (!["purchase", "waste", "staff_consumption"].includes(m.type)) throw new Error("لا يمكن إلغاء هذا النوع من الحركات هنا");
  if ((await cancelledMovementIds(db, [m.id])).size) throw new Error("ملغاة مسبقاً");
  const rev = await applyMovement(db, {
    ts: m.ts, stockItemId: m.stockItemId, deltaBase: -m.deltaBase, type: "correction",
    refType: CANCEL_REF, refId: String(m.id), note: `إلغاء: ${reason}`, createdBy: actor,
  });
  let expenseId: number | null = null;
  if (m.type === "purchase") {
    const [e] = await db.select().from(expenses).where(and(eq(expenses.purchaseRef, m.id), eq(expenses.isPurchase, true)));
    if (e) { await db.update(expenses).set({ active: false }).where(eq(expenses.id, e.id)); expenseId = e.id; }
    // restore the average cost if this purchase set the current one
    const hist = await db.select().from(stockCostHistory).where(eq(stockCostHistory.stockItemId, m.stockItemId))
      .orderBy(desc(stockCostHistory.effectiveFrom), desc(stockCostHistory.id)).limit(2);
    if (hist[0]?.purchaseMovementId === m.id) {
      const prev = hist[1]?.costPerBase ?? "0";
      await db.update(stockItems).set({ costPerBase: prev }).where(eq(stockItems.id, m.stockItemId));
      // same effective time as the cancelled purchase (newer id wins), so it applies from that moment on
      await db.insert(stockCostHistory).values({ stockItemId: m.stockItemId, costPerBase: prev, effectiveFrom: m.ts, purchaseMovementId: null });
    }
  }
  await audit(db, actor, `stock.${m.type}_cancel`, "stock_movement", m.id, m, { reversal: rev.id, expenseDeactivated: expenseId, reason });
  await checkStockAlerts(db, [m.stockItemId]);
}

/** Cancel a wrong stock count: its adjustment is reversed and it no longer counts in margin analysis. */
export async function cancelStockCount(db: Exec, countId: number, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("السبب مطلوب");
  const [c] = await db.select().from(stockCounts).where(eq(stockCounts.id, countId));
  if (!c) throw new Error("جرد غير موجود");
  if (c.cancelledAt) throw new Error("ملغى مسبقاً");
  const [adj] = await db.select().from(stockMovements).where(and(eq(stockMovements.refType, "stock_count"), eq(stockMovements.refId, String(c.id))));
  if (adj) {
    await applyMovement(db, { ts: adj.ts, stockItemId: adj.stockItemId, deltaBase: -adj.deltaBase, type: "correction", refType: CANCEL_REF, refId: String(adj.id), note: `إلغاء جرد: ${reason}`, createdBy: actor });
  }
  await db.update(stockCounts).set({ cancelledAt: new Date(), cancelledBy: actor, cancelReason: reason }).where(eq(stockCounts.id, c.id));
  await audit(db, actor, "stock.count_cancel", "stock_count", c.id, c, { reason });
  await checkStockAlerts(db, [c.stockItemId]);
}

export async function cancelCashCount(db: Exec, id: number, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("السبب مطلوب");
  const [c] = await db.select().from(cashCounts).where(eq(cashCounts.id, id));
  if (!c) throw new Error("عدّ غير موجود");
  if (c.cancelledAt) throw new Error("ملغى مسبقاً");
  await db.update(cashCounts).set({ cancelledAt: new Date(), cancelledBy: actor, cancelReason: reason }).where(eq(cashCounts.id, id));
  await audit(db, actor, "cash.count_cancel", "cash_count", id, c, { reason });
}

/** Edit an expense (purchases are corrected by cancelling the purchase). */
export async function updateExpense(db: Exec, id: number, e: {
  category: string; label: string; amountMillimes: number; startDay: string; endDay?: string | null; invoiceRef?: string | null;
}, actor: string) {
  const [before] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!before) throw new Error("مصروف غير موجود");
  if (before.isPurchase) throw new Error("مصروف شراء: ألغِ الشراء من صفحة المخزون ثم سجّله من جديد");
  assertInt(e.amountMillimes, "amount");
  if (e.amountMillimes <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  if (!e.label.trim()) throw new Error("الوصف مطلوب");
  if (before.paidFrom === "drawer" && !e.invoiceRef?.trim()) throw new Error("مصروف من الدرج: رقم الفاتورة مطلوب");
  const after = {
    category: e.category.trim() || before.category, label: e.label.trim(), amountMillimes: e.amountMillimes,
    startDay: e.startDay || before.startDay,
    endDay: before.kind === "fixed" ? e.endDay || null : e.startDay || before.startDay,
    invoiceRef: e.invoiceRef?.trim() || null,
  };
  await db.update(expenses).set(after).where(eq(expenses.id, id));
  await audit(db, actor, "expense.update", "expense", id, before, after);
}

/** A wrong price is voided; the previous valid price applies again. Past orders keep their price snapshot. */
export async function voidPrice(db: Exec, priceId: number, actor: string) {
  const [p] = await db.select().from(productPrices).where(eq(productPrices.id, priceId));
  if (!p) throw new Error("سعر غير موجود");
  if (p.voidedAt) throw new Error("ملغى مسبقاً");
  await db.update(productPrices).set({ voidedAt: new Date(), voidedBy: actor }).where(eq(productPrices.id, priceId));
  await audit(db, actor, "product.price_void", "product", p.productId, p, { voided: true });
}

/**
 * Change the items of an order: the old order is voided (stock, ticket and credit reversed) and a corrected
 * order is created at the same time with the same payment. Both stay visible; the new one points to the old one.
 */
export async function editOrderItems(db: Exec, orderId: string, items: { product_id: number; qty: number }[], actor: string, ip?: string | null) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new Error("طلب غير موجود");
  if (o.status === "void") throw new Error("الطلب ملغى");
  if (o.paymentType === "loss") throw new Error("طلب «خرج دون دفع»: ألغِه وسجّل طلباً يدوياً");
  if (!items.length) throw new Error("أضف منتجاً واحداً على الأقل (أو ألغِ الطلب)");
  let codeHash: string | null = null;
  if (o.paymentType === "ticket" && o.ticketId) {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, o.ticketId));
    codeHash = t?.shortCodeHash ?? null;
  }
  const [r] = await db.select({ n: sql<string>`count(*)` }).from(orders).where(isNull(orders.deviceId));
  const seq = Number(r.n) + 1;
  const newLabel = `ADM-${String(seq).padStart(4, "0")}`;
  await voidOrder(db, o.id, `تعديل المنتجات ← ${newLabel}`, actor, ip, { quiet: true });
  const id = crypto.randomUUID();
  const res = await createOrder(db, {
    id, deviceId: null, deviceSeq: seq, orderLabel: newLabel, clientTs: o.clientTs, effectiveTs: o.effectiveTs, receivedAt: new Date(),
    items, payment: o.paymentType === "pending" ? "later" : o.paymentType === "ticket" ? "ticket" : "cash",
    ticketCodeHash: codeHash, tableRef: o.tableRef, flags: ["manual", "edited"], actor,
  });
  // the money was taken when the original order was paid: keep that payment time / shift
  await db.update(orders).set({
    reviewNote: `بدلاً من ${o.orderLabel}`,
    ...(o.paymentType === "cash" || o.paymentType === "ticket" ? { paidAt: o.paidAt, paidBusinessDay: o.paidBusinessDay, paidShift: o.paidShift } : {}),
  }).where(eq(orders.id, id));
  await audit(db, actor, "order.edit", "order", o.id, { label: o.orderLabel }, { replacedBy: newLabel, newId: id, items, result: res }, ip);
  return { id, label: newLabel };
}

/** Soft delete a product: hidden everywhere (tablet, lists); its past sales stay in the reports. */
export async function deleteProduct(db: Exec, id: number, actor: string) {
  const [p] = await db.select().from(products).where(eq(products.id, id));
  if (!p) throw new Error("منتج غير موجود");
  await db.update(products).set({ active: false, deletedAt: new Date() }).where(eq(products.id, id));
  await audit(db, actor, "product.delete", "product", id, p, { deleted: true });
}

/** Soft delete a stock item (refused while an active product's current recipe still uses it). */
export async function deleteStockItem(db: Exec, id: number, actor: string) {
  const [it] = await db.select().from(stockItems).where(eq(stockItems.id, id));
  if (!it) throw new Error("مادة غير موجودة");
  const prods = await db.select().from(products).where(and(eq(products.active, true), isNull(products.deletedAt)));
  const users: string[] = [];
  for (const p of prods) {
    const [v] = await db.select().from(recipeVersions).where(eq(recipeVersions.productId, p.id)).orderBy(desc(recipeVersions.effectiveFrom), desc(recipeVersions.id)).limit(1);
    if (!v) continue;
    const [l] = await db.select().from(recipeLines).where(and(eq(recipeLines.recipeVersionId, v.id), eq(recipeLines.stockItemId, id)));
    if (l) users.push(p.nameAr);
  }
  if (users.length) throw new Error(`مستعملة في وصفة: ${users.join("، ")} — عدّل الوصفة أولاً`);
  await db.update(stockItems).set({ active: false, deletedAt: new Date() }).where(eq(stockItems.id, id));
  await audit(db, actor, "stock_item.delete", "stock_item", id, it, { deleted: true });
}

/** Soft delete a customer: only with no debt; unused tickets are voided. */
export async function deleteCustomer(db: Exec, id: number, actor: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, id));
  if (!c) throw new Error("زبون غير موجود");
  const bal = await customerBalance(db, id);
  if (bal !== 0) throw new Error("لا يمكن حذف زبون عليه دين — سجّل السداد أو التعديل أولاً");
  await db.update(tickets).set({ status: "void" }).where(and(eq(tickets.customerId, id), eq(tickets.status, "issued")));
  await db.update(customers).set({ active: false, deletedAt: new Date() }).where(eq(customers.id, id));
  await audit(db, actor, "customer.delete", "customer", id, c, { deleted: true });
}
