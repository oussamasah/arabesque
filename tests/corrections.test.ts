import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as S from "@/db/schema";
import type { DB } from "@/db";
import { createDevice, createTestDb, FakeTablet, seedCoffee } from "./helpers";
import { processPush } from "@/server/sync";
import { priceAt, listProducts } from "@/server/catalog";
import { costAt, recordCount, recordExplainedLoss, recordPurchase, shiftStockReport, theoreticalAt } from "@/server/stock";
import { runPeriodicChecks } from "@/server/checks";
import { createCustomer, deleteSheet, issueSheet, sheetForPrint, updateSheet, updateTicketNote, validTicketHashes } from "@/server/tickets";
import { createExpense, expectedCash, profitSummary, recordCashCount, shiftRows } from "@/server/finance";
import {
  cancelCashCount, cancelMovement, cancelStockCount, deleteCustomer, deleteProduct, deleteStockItem, editOrderItems,
  updateExpense, voidPrice,
} from "@/server/corrections";
import { setPrice } from "@/server/catalog";
import { buildDeviceConfig } from "@/server/deviceConfig";
import { sha256Hex } from "@/server/crypto";
import { tunisLocalToUtc } from "@/lib/time";

let db: DB;
let seed: Awaited<ReturnType<typeof seedCoffee>>;
let dev: Awaited<ReturnType<typeof createDevice>>;
let tab: FakeTablet;
const at = (d: number, h: number, mi = 0) => tunisLocalToUtc(2026, 3, d, h, mi);
const NOW = at(20, 23);

beforeEach(async () => {
  db = await createTestDb();
  seed = await seedCoffee(db);
  dev = await createDevice(db);
  tab = new FakeTablet(dev.id);
});

async function push(...events: ReturnType<FakeTablet["event"]>[]) {
  const [d] = await db.select().from(S.devices).where(eq(S.devices.id, dev.id));
  return processPush(db, d, events, NOW);
}

describe("owner corrections keep history", () => {
  it("cancels a purchase: stock, expense and average cost are reversed", async () => {
    const { movementId } = await recordPurchase(db, { stockItemId: seed.coffee.id, qtyBase: 1_000_000, totalMillimes: 100_000, ts: at(10, 8), paidFrom: "owner", invoiceRef: "X" }, "owner");
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(3_000_000);
    expect(await costAt(db, seed.coffee.id, NOW)).toBeCloseTo(0.06, 6);
    await cancelMovement(db, movementId, "فاتورة خاطئة", "owner");
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(2_000_000);
    expect(await costAt(db, seed.coffee.id, NOW)).toBeCloseTo(0.04, 6);
    const [e] = await db.select().from(S.expenses).where(eq(S.expenses.purchaseRef, movementId));
    expect(e.active).toBe(false);
    expect((await profitSummary(db, "2026-03-10", "2026-03-10")).purchases).toBe(0);
    await expect(cancelMovement(db, movementId, "again", "owner")).rejects.toThrow();
    // the original movement is still there (append-only ledger)
    expect((await db.select().from(S.stockMovements).where(eq(S.stockMovements.id, movementId))).length).toBe(1);
  });

  it("cancels a loss", async () => {
    const mv = await recordExplainedLoss(db, "waste", seed.water.id, 3, at(10, 9), "مكسور", "owner");
    await cancelMovement(db, mv.id, "خطأ", "owner");
    expect(await theoreticalAt(db, seed.water.id, NOW)).toBe(48);
  });

  it("cancels a wrong stock count and a wrong cash count", async () => {
    const [c] = await recordCount(db, { ts: at(10, 15), handover: "morning_to_evening", entries: [{ stockItemId: seed.water.id, countedBase: 40 }] }, "owner");
    expect(await theoreticalAt(db, seed.water.id, NOW)).toBe(40);
    await cancelStockCount(db, c.id, "خطأ في الكتابة", "owner");
    expect(await theoreticalAt(db, seed.water.id, NOW)).toBe(48);
    const rows = await shiftRows(db, "2026-03-10", "2026-03-10");
    expect(rows.find((r) => r.shift === "morning")?.negativePieceVariance ?? false).toBe(false);

    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) }));
    const cc = await recordCashCount(db, { ts: at(10, 15), businessDay: "2026-03-10", shift: "morning", countedCashMillimes: 0, ticketsInDrawer: 0 }, "owner");
    expect((await shiftRows(db, "2026-03-10", "2026-03-10")).find((r) => r.shift === "morning")!.cashVariance).toBe(-1800);
    await cancelCashCount(db, cc.id, "عدّ خاطئ", "owner");
    expect((await shiftRows(db, "2026-03-10", "2026-03-10")).find((r) => r.shift === "morning")!.cashVariance).toBeNull();
  });

  it("edits an expense with an audit entry; purchase expenses must be cancelled instead", async () => {
    const e = await createExpense(db, { kind: "variable", category: "صيانة", label: "سباك", amountMillimes: 30_000, startDay: "2026-03-10" }, "owner");
    await updateExpense(db, e.id, { category: "صيانة", label: "سباك (مصحح)", amountMillimes: 25_000, startDay: "2026-03-10" }, "owner");
    const [after] = await db.select().from(S.expenses).where(eq(S.expenses.id, e.id));
    expect(after.amountMillimes).toBe(25_000);
    const log = await db.select().from(S.auditLog).where(eq(S.auditLog.action, "expense.update"));
    expect((log[0].before as { amountMillimes: number }).amountMillimes).toBe(30_000);
    const { expenseId } = await recordPurchase(db, { stockItemId: seed.water.id, qtyBase: 12, totalMillimes: 6000, ts: at(10, 8), paidFrom: "owner" }, "owner");
    await expect(updateExpense(db, expenseId!, { category: "x", label: "x", amountMillimes: 1, startDay: "2026-03-10" }, "owner")).rejects.toThrow();
  });

  it("voids a wrong price: the previous price applies again, past orders keep their price", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) }));
    const wrong = await setPrice(db, seed.pCoffee.id, 18_000, at(9, 0), "owner"); // typo: 18 DT, back-dated
    expect(await priceAt(db, seed.pCoffee.id, NOW)).toBe(18_000);
    await voidPrice(db, wrong.id, "owner");
    expect(await priceAt(db, seed.pCoffee.id, NOW)).toBe(1800);
    const [o] = await db.select().from(S.orders);
    expect(o.totalMillimes).toBe(1800);
  });

  it("edits the items of a paid order: old voided, corrected order with the same payment shift", async () => {
    const e = tab.event([{ product_id: seed.pCoffee.id, qty: 2 }], { at: at(10, 9) });
    await push(e);
    const r = await editOrderItems(db, e.client_event_id, [{ product_id: seed.pCoffee.id, qty: 1 }, { product_id: seed.pWater.id, qty: 1 }], "owner");
    const [old] = await db.select().from(S.orders).where(eq(S.orders.id, e.client_event_id));
    const [neu] = await db.select().from(S.orders).where(eq(S.orders.id, r.id));
    expect(old.status).toBe("void");
    expect(neu.totalMillimes).toBe(2800);
    expect(neu.flags).toContain("edited");
    expect(neu.paidShift).toBe("morning");
    expect((await expectedCash(db, "2026-03-10", "morning")).expectedCash).toBe(2800);
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(2_000_000 - 12_500);
    expect(await theoreticalAt(db, seed.water.id, NOW)).toBe(47);
  });

  it("edits a pay-later order: the corrected order appears on the tablet's unpaid list", async () => {
    const e = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(20, 9), payment: "later", tableRef: "T5" });
    await push(e);
    const r = await editOrderItems(db, e.client_event_id, [{ product_id: seed.pCoffee.id, qty: 3 }], "owner");
    const cfg = await buildDeviceConfig(db, dev, NOW);
    expect(cfg.open_orders).toEqual([r.id]);
    expect(cfg.open_order_details[0]).toMatchObject({ id: r.id, table_ref: "T5", items: [{ product_id: seed.pCoffee.id, qty: 3 }] });
    expect(JSON.stringify(cfg)).not.toMatch(/total|cost/i);
    // the tablet pays it with a normal pay event
    await push(tab.pay(r.id, { at: at(20, 10) }));
    const [paid] = await db.select().from(S.orders).where(eq(S.orders.id, r.id));
    expect(paid.paymentType).toBe("cash");
  });

  it("ticket order edit keeps the same ticket", async () => {
    const c = await createCustomer(db, { name: "Ali" }, "t");
    const s = await issueSheet(db, { customerId: c.id, type: "credit", count: 1 }, "t");
    const tok = (await sheetForPrint(db, s.id)).tickets[0].token!;
    const e = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "ticket", tokenHash: sha256Hex(tok) });
    await push(e);
    const r = await editOrderItems(db, e.client_event_id, [{ product_id: seed.pCoffee.id, qty: 2 }], "owner");
    const [t] = await db.select().from(S.tickets);
    expect(t.usedOrderId).toBe(r.id);
  });

  it("soft deletes products, stock items (if unused) and customers (if no debt)", async () => {
    await expect(deleteStockItem(db, seed.coffee.id, "owner")).rejects.toThrow(/وصفة/);
    await deleteProduct(db, seed.pCoffee.id, "owner");
    expect((await listProducts(db)).map((p) => p.id)).not.toContain(seed.pCoffee.id);
    await deleteStockItem(db, seed.coffee.id, "owner"); // no active product uses it any more
    const [it] = await db.select().from(S.stockItems).where(eq(S.stockItems.id, seed.coffee.id));
    expect(it.deletedAt).not.toBeNull();
    const cfg = await buildDeviceConfig(db, dev, NOW);
    expect(cfg.products.map((p) => p.id)).not.toContain(seed.pCoffee.id);

    const cust = await createCustomer(db, { name: "Sami" }, "t");
    await issueSheet(db, { customerId: cust.id, type: "free", count: 2 }, "t");
    await deleteCustomer(db, cust.id, "owner");
    const open = await db.select().from(S.tickets).where(and(eq(S.tickets.customerId, cust.id), eq(S.tickets.status, "issued")));
    expect(open).toHaveLength(0);
  });

  it("edits a sheet (unused tickets follow, used keep) and deletes it (unused voided, used kept, tablets stop accepting)", async () => {
    const c = await createCustomer(db, { name: "Ali" }, "t");
    const s = await issueSheet(db, { customerId: c.id, type: "credit", count: 3 }, "t");
    const toks = (await sheetForPrint(db, s.id)).tickets.map((t) => t.token!);
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "ticket", tokenHash: sha256Hex(toks[0]) }));

    await updateSheet(db, s.id, { note: "ورقة نوفمبر", type: "free", maxAmountMillimes: 5000, count: 5 }, "owner"); // +2 tickets
    expect((await db.select().from(S.tickets).where(and(eq(S.tickets.sheetId, s.id), eq(S.tickets.status, "issued"))))).toHaveLength(4);
    await expect(updateSheet(db, s.id, { type: "free", count: 0 }, "owner")).rejects.toThrow();
    await updateSheet(db, s.id, { note: "ورقة نوفمبر", type: "free", maxAmountMillimes: 5000, count: 3 }, "owner"); // back to 3: voids 2 unused
    expect((await db.select().from(S.tickets).where(and(eq(S.tickets.sheetId, s.id), eq(S.tickets.status, "issued"))))).toHaveLength(2);
    expect((await db.select().from(S.ticketSheets).where(eq(S.ticketSheets.id, s.id)))[0].ticketCount).toBe(3);
    const rows = await db.select().from(S.tickets).where(eq(S.tickets.sheetId, s.id));
    expect(rows.filter((t) => t.status === "issued").every((t) => t.type === "free" && t.maxAmountMillimes === 5000)).toBe(true);
    expect(rows.find((t) => t.status === "used")!.type).toBe("credit"); // history untouched

    await updateTicketNote(db, rows[0].id, "ملاحظة", "owner");

    expect((await validTicketHashes(db)).token_hashes).toHaveLength(2);
    expect(await deleteSheet(db, s.id, "owner")).toBe(2);
    expect((await validTicketHashes(db)).token_hashes).toHaveLength(0);
    const after = await db.select().from(S.tickets).where(eq(S.tickets.sheetId, s.id));
    expect(after.filter((t) => t.status === "void")).toHaveLength(4); // 2 removed by the count change + 2 by the delete
    expect(after.filter((t) => t.status === "used")).toHaveLength(1);
    await expect(sheetForPrint(db, s.id)).rejects.toThrow();
    await expect(deleteSheet(db, s.id, "owner")).rejects.toThrow();
  });

  it("shows per shift which one has a stock shortage, and alerts when a finished shift has no count", async () => {
    // morning: 2 waters sold; evening: 1 sold. Water seeded with 48 (see seedCoffee).
    await push(tab.event([{ product_id: seed.pWater.id, qty: 2 }], { at: at(10, 9) }), tab.event([{ product_id: seed.pWater.id, qty: 1 }], { at: at(10, 17) }));
    // count at the 15:00 handover finds 3 missing bottles (expected 46, found 43) → shortage filed under the MORNING shift
    await recordCount(db, { ts: at(10, 15, 5), handover: "morning_to_evening", entries: [{ stockItemId: seed.water.id, countedBase: 43 }] }, "owner");
    const rep = await shiftStockReport(db, "2026-03-10", "2026-03-10");
    const morning = rep.find((r) => r.shift === "morning")!;
    const evening = rep.find((r) => r.shift === "evening")!;
    expect(morning.counted).toBe(true);
    expect(morning.shortages).toBe(1);
    expect(morning.lines[0]).toMatchObject({ theoretical: 46, counted: 43, variance: -3 });
    expect(evening.counted).toBe(false);
    expect(evening.orders).toBe(1);

    // 6+ hours after the evening shift ended (06:00 next day) with no count → alert
    await runPeriodicChecks(db, at(11, 13));
    const al = await db.select().from(S.alerts).where(eq(S.alerts.type, "missing_stock_count"));
    expect(al.map((a) => a.message).join()).toMatch(/2026-03-10/);
    // the morning shift has a count → no alert for it
    expect(al.filter((a) => a.shift === "morning")).toHaveLength(0);
  });
});
