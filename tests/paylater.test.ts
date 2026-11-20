import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as S from "@/db/schema";
import type { DB } from "@/db";
import { createDevice, createTestDb, FakeTablet, seedCoffee } from "./helpers";
import { processPush } from "@/server/sync";
import { createCustomer, customerBalance, issueSheet, sheetForPrint } from "@/server/tickets";
import { adminPayOrder, markOrderUnpaidLoss, voidOrder } from "@/server/orders";
import { expectedCash, profitSummary, shiftRows } from "@/server/finance";
import { theoreticalAt } from "@/server/stock";
import { runPeriodicChecks } from "@/server/checks";
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
const order = async (id: string) => (await db.select().from(S.orders).where(eq(S.orders.id, id)))[0];
const alertTypes = async () => (await db.select().from(S.alerts)).map((a) => a.type);

describe("pay later (order now, payment when the customer leaves)", () => {
  it("deducts stock when served, counts cash in the shift that took the payment", async () => {
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 2 }], { at: at(10, 14, 30), payment: "later", tableRef: "طاولة 5" });
    await push(c);
    let o = await order(c.client_event_id);
    expect(o.paymentType).toBe("pending");
    expect(o.tableRef).toBe("طاولة 5");
    expect(o.paidAt).toBeNull();
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(2_000_000 - 25_000); // stock out at serving time
    expect((await expectedCash(db, "2026-03-10", "morning")).expectedCash).toBe(0);

    // the customer pays at 15:20 → evening shift collects the money
    await push(tab.pay(c.client_event_id, { at: at(10, 15, 20) }));
    o = await order(c.client_event_id);
    expect(o.paymentType).toBe("cash");
    expect(o.shift).toBe("morning"); // served in the morning
    expect(o.paidShift).toBe("evening"); // paid in the evening
    expect(o.flags).toContain("paid_other_shift");
    expect((await expectedCash(db, "2026-03-10", "morning")).expectedCash).toBe(0);
    expect((await expectedCash(db, "2026-03-10", "evening")).expectedCash).toBe(3600);
    const rows = await shiftRows(db, "2026-03-10", "2026-03-10");
    expect(rows.find((r) => r.shift === "evening")!.salesCash).toBe(3600);
    expect(rows.find((r) => r.shift === "morning")!.orders).toBe(1);
    expect((await profitSummary(db, "2026-03-10", "2026-03-10")).salesCash).toBe(3600);
  });

  it("pays with a ticket later (credit charged at payment, one ticket per order)", async () => {
    const cust = await createCustomer(db, { name: "Ali" }, "t");
    const sheet = await issueSheet(db, { customerId: cust.id, type: "credit", count: 2 }, "t");
    const tok = (await sheetForPrint(db, sheet.id)).tickets[0].token!;
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "later" });
    await push(c);
    expect(await customerBalance(db, cust.id)).toBe(0);
    await push(tab.pay(c.client_event_id, { at: at(10, 10), payment: "ticket", tokenHash: sha256Hex(tok) }));
    const o = await order(c.client_event_id);
    expect(o.paymentType).toBe("ticket");
    expect(o.status).toBe("ok");
    expect(await customerBalance(db, cust.id)).toBe(1800);
    expect((await expectedCash(db, "2026-03-10", "morning")).ticketsExpected).toBe(1);
  });

  it("rejects a second payment and payments of unknown orders", async () => {
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "later" });
    await push(c, tab.pay(c.client_event_id, { at: at(10, 9, 30) }));
    const r = await push(tab.pay(c.client_event_id, { at: at(10, 9, 40) }));
    expect(r.rejected[0].reason).toBe("already_paid");
    expect(await alertTypes()).toContain("double_payment");
    const r2 = await push(tab.pay(crypto.randomUUID(), { at: at(10, 9, 50) }));
    expect(r2.rejected[0].reason).toBe("unknown_order");
  });

  it("alerts on orders left unpaid and on shifts that ended with unpaid orders", async () => {
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(20, 7), payment: "later" });
    await push(c);
    await runPeriodicChecks(db, at(20, 11));
    expect(await alertTypes()).toContain("unpaid_order");
    await runPeriodicChecks(db, at(20, 16));
    expect(await alertTypes()).toContain("unpaid_shift");
    const rows = await shiftRows(db, "2026-03-20", "2026-03-20");
    expect(rows.find((r) => r.shift === "morning")!.unpaid).toBe(1);
  });

  it("owner can record the payment or mark 'left without paying'; tablet open list follows", async () => {
    const a = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(20, 9), payment: "later" });
    const b = tab.event([{ product_id: seed.pWater.id, qty: 1 }], { at: at(20, 9, 5), payment: "later" });
    const c = tab.event([{ product_id: seed.pWater.id, qty: 1 }], { at: at(20, 9, 10), payment: "later" });
    await push(a, b, c);
    let cfg = await buildDeviceConfig(db, dev, NOW);
    expect(cfg.open_orders.sort()).toEqual([a, b, c].map((e) => e.client_event_id).sort());

    await adminPayOrder(db, a.client_event_id, at(20, 10), "owner", "owner");
    expect((await order(a.client_event_id)).flags).toContain("paid_to_owner");
    expect((await expectedCash(db, "2026-03-20", "morning")).expectedCash).toBe(0); // owner kept it, not in drawer

    await markOrderUnpaidLoss(db, b.client_event_id, "هرب", "owner");
    expect((await order(b.client_event_id)).paymentType).toBe("loss");
    expect(await theoreticalAt(db, seed.water.id, NOW)).toBe(48 - 2); // goods were served

    await voidOrder(db, c.client_event_id, "خطأ", "owner");
    cfg = await buildDeviceConfig(db, dev, NOW);
    expect(cfg.open_orders).toEqual([]);
    const sum = await profitSummary(db, "2026-03-20", "2026-03-20");
    expect(sum.unpaidLossValue).toBe(1000);
    expect(sum.salesCash).toBe(1800);
  });

  it("unpaid orders are owed by the worker of the serving shift until paid", async () => {
    const a = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(20, 9), payment: "later" });
    const b = tab.event([{ product_id: seed.pWater.id, qty: 1 }], { at: at(20, 9, 5), payment: "later" });
    await push(a, b);
    let e = await expectedCash(db, "2026-03-20", "morning");
    expect(e.owedByWorker).toBe(2800);
    expect(e.owedCount).toBe(2);
    // customer of "a" pays in the evening → no longer owed by the morning worker
    await push(tab.pay(a.client_event_id, { at: at(20, 16) }));
    // "b" left without paying → still owed; then the worker covers it
    await markOrderUnpaidLoss(db, b.client_event_id, "خرج", "owner");
    e = await expectedCash(db, "2026-03-20", "morning");
    expect(e.owedByWorker).toBe(1000);
    expect((await shiftRows(db, "2026-03-20", "2026-03-20")).find((r) => r.shift === "morning")!.owedByWorker).toBe(1000);
    await adminPayOrder(db, b.client_event_id, at(20, 17), "worker", "owner");
    const o = await order(b.client_event_id);
    expect(o.paymentType).toBe("cash");
    expect(o.flags).toContain("paid_by_worker");
    e = await expectedCash(db, "2026-03-20", "morning");
    expect(e.owedByWorker).toBe(0);
    expect((await expectedCash(db, "2026-03-20", "evening")).expectedCash).toBe(1800); // worker's money is not in the drawer
    expect((await profitSummary(db, "2026-03-20", "2026-03-20")).salesCash).toBe(2800); // but it is revenue
  });

  it("pay now still behaves as before (paid in the serving shift)", async () => {
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) });
    await push(c);
    const o = await order(c.client_event_id);
    expect(o.paidShift).toBe("morning");
    expect(o.paidBusinessDay).toBe("2026-03-10");
  });
});
