import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as S from "@/db/schema";
import type { DB } from "@/db";
import { createDevice, createTestDb, FakeTablet, seedCoffee, T0 } from "./helpers";
import { processPush } from "@/server/sync";
import { saveRecipe, setPrice } from "@/server/catalog";
import { checkStockAlerts, recordCount, recordPurchase, theoreticalAt } from "@/server/stock";
import { createCustomer, customerBalance, issueSheet, recordRepayment, sheetForPrint, validTicketHashes } from "@/server/tickets";
import { approveOrder, voidOrder } from "@/server/orders";
import { createExpense, expectedCash, profitSummary, recordCashCount, shiftRows } from "@/server/finance";
import { sha256Hex } from "@/server/crypto";
import { buildDeviceConfig } from "@/server/deviceConfig";
import { tunisLocalToUtc } from "@/lib/time";
import { setSetting } from "@/server/settings";

let db: DB;
let seed: Awaited<ReturnType<typeof seedCoffee>>;
let dev: Awaited<ReturnType<typeof createDevice>>;
let tab: FakeTablet;
const at = (d: number, h: number, mi = 0) => tunisLocalToUtc(2026, 3, d, h, mi);
const NOW = at(20, 12);

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
const alertTypes = async () => (await db.select().from(S.alerts)).map((a) => a.type);

describe("orders & stock", () => {
  it("computes totals server-side and deducts stock per recipe", async () => {
    const r = await push(tab.event([{ product_id: seed.pCoffee.id, qty: 2 }, { product_id: seed.pWater.id, qty: 1 }], { at: at(10, 9) }));
    expect(r.acked).toHaveLength(1);
    const [o] = await db.select().from(S.orders);
    expect(o.totalMillimes).toBe(2 * 1800 + 1000);
    expect(o.businessDay).toBe("2026-03-10");
    expect(o.shift).toBe("morning");
    expect(o.orderLabel).toBe("T1-0001");
    // cost: 2 × 12500 mg × 0.04 + 1 × 500 = 1000 + 500
    expect(Number(o.costMillimes)).toBe(1500);
    const [c] = await db.select().from(S.stockItems).where(eq(S.stockItems.id, seed.coffee.id));
    expect(c.qtyBase).toBe(2_000_000 - 25_000);
    const mv = await db.select().from(S.stockMovements).where(eq(S.stockMovements.type, "sale"));
    expect(mv).toHaveLength(2); // one per stock item per order
  });

  it("80 coffees deduct exactly 1 kg", async () => {
    const evs = [];
    for (let i = 0; i < 8; i++) evs.push(tab.event([{ product_id: seed.pCoffee.id, qty: 10 }], { at: at(10, 9, i) }));
    await push(...evs);
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(1_000_000);
  });

  it("4. price & recipe versioning never changes past orders", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) }));
    await setPrice(db, seed.pCoffee.id, 2000, at(11, 0), "test");
    await saveRecipe(db, seed.pCoffee.id, [{ stockItemId: seed.coffee.id, qtyBase: 14000, realQtyBase: 12000 }], at(11, 0), "test");
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(12, 9) }));
    const os = await db.select().from(S.orders).orderBy(S.orders.deviceSeq);
    expect(os.map((o) => o.totalMillimes)).toEqual([1800, 2000]);
    const items = await db.select().from(S.orderItems).orderBy(S.orderItems.id);
    expect(items[0].unitPriceMillimes).toBe(1800);
    expect(Number(items[0].unitCostMillimes)).toBe(500);
    expect(Number(items[1].unitCostMillimes)).toBe(560);
  });

  it("uses the cost valid at effective time for late-synced orders", async () => {
    await recordPurchase(db, { stockItemId: seed.coffee.id, qtyBase: 2_000_000, totalMillimes: 160_000, ts: at(15, 8), paidFrom: "owner" }, "test");
    // offline order taken BEFORE the expensive purchase but synced after
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(14, 9) }));
    const [it] = await db.select().from(S.orderItems);
    expect(Number(it.unitCostMillimes)).toBe(500); // old cost 0.04/mg, not the new average 0.06/mg
  });

  it("stock may go negative and raises an alert; low-stock and running-out alerts fire before running out", async () => {
    await db.update(S.stockItems).set({ minQtyBase: 40 }).where(eq(S.stockItems.id, seed.water.id));
    const evs = [];
    for (let i = 0; i < 6; i++) evs.push(tab.event([{ product_id: seed.pWater.id, qty: 9 }], { at: new Date(NOW.getTime() - (6 - i) * 3600_000) }));
    await push(...evs);
    const types = await alertTypes();
    expect(types).toContain("low_stock");
    expect(types).toContain("negative_stock"); // 48 - 54 = -6
    await db.delete(S.alerts);
    // early warning: 20 bottles left, consumption 54 in the last 7 days ≈ 7.7/day → < 3 days
    await recordPurchase(db, { stockItemId: seed.water.id, qtyBase: 26, totalMillimes: 13_000, ts: NOW, paidFrom: "owner" }, "test");
    await checkStockAlerts(db, [seed.water.id], NOW);
    expect(await alertTypes()).toContain("stock_running_out");
  });
});

describe("5. sync", () => {
  it("is idempotent on re-send", async () => {
    const e = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) });
    await push(e);
    const r = await push(e);
    expect(r.acked).toEqual([e.client_event_id]);
    expect(await db.select().from(S.orders)).toHaveLength(1);
  });

  it("processes out-of-order batches in sequence order", async () => {
    const a = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) });
    const b = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 10) });
    const r = await push(b, a);
    expect(r.acked).toHaveLength(2);
    expect(await alertTypes()).not.toContain("sequence_gap");
  });

  it("detects gaps (deleted local records)", async () => {
    const a = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) });
    tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9, 5) }); // never sent
    const c = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9, 10) });
    await push(a, c);
    expect(await alertTypes()).toContain("sequence_gap");
  });

  it("detects altered records (hash invalid) and broken chains", async () => {
    const a = tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) });
    const tampered = { ...a, client_event_id: crypto.randomUUID(), payload: { ...a.payload, items: [{ product_id: seed.pCoffee.id, qty: 5 }] } };
    const r = await push(tampered);
    expect(r.rejected[0].reason).toBe("hash_invalid");
    expect(await alertTypes()).toContain("hash_invalid");
    // valid event, but its prev_hash does not match what the server knows
    await push(a);
    const t2 = new FakeTablet(dev.id); t2.seq = 1; t2.lastHash = "f".repeat(64);
    await push(t2.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 10) }));
    expect(await alertTypes()).toContain("hash_chain_broken");
  });

  it("rejects sequence regressions (storage cleared)", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9) }));
    const fresh = new FakeTablet(dev.id);
    const r = await push(fresh.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 10) }));
    expect(r.rejected[0].reason).toBe("sequence_regression");
  });

  it("corrects device clock with the offset and flags late syncs & skew", async () => {
    tab.offset = 3_600_000; // tablet clock 1 h behind
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 14, 30) }));
    const [o] = await db.select().from(S.orders);
    expect(o.shift).toBe("morning");
    expect(o.effectiveTs.getTime()).toBe(at(10, 14, 30).getTime());
    expect(o.flags).toContain("late_sync"); // 10 days before NOW
    tab.offset = 0; // offset jumps by 1 h
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(20, 11) }));
    expect(await alertTypes()).toContain("clock_skew");
  });

  it("rejects unknown products without losing the raw event", async () => {
    const r = await push(tab.event([{ product_id: 9999, qty: 1 }], { at: at(10, 9) }));
    expect(r.rejected[0].reason).toBe("unknown_product");
    const ev = await db.select().from(S.syncEvents);
    expect(ev[0].status).toBe("rejected");
  });

  it("10. device config has no prices when tablet_show_prices is off (blind mode)", async () => {
    await setSetting(db, "tablet_show_prices", false);
    const cfg = await buildDeviceConfig(db, dev);
    const text = JSON.stringify(cfg);
    expect(text).not.toMatch(/price_millimes|millime|total|cost|qty_base|stock/i);
    expect(cfg.products.length).toBe(2);
    await setSetting(db, "tablet_show_prices", true);
  });

  it("10b. device config carries current prices when tablet_show_prices is on (default)", async () => {
    const cfg = await buildDeviceConfig(db, dev);
    expect(cfg.show_prices).toBe(true);
    expect(cfg.products.every((p) => "price_millimes" in p && typeof (p as { price_millimes: number }).price_millimes === "number")).toBe(true);
    expect(JSON.stringify(cfg)).not.toMatch(/cost|qty_base|stock/i);
  });

  it("10c. config carries the server's exact order totals (tablet shift total = admin total even after a price change)", async () => {
    const e = tab.event([{ product_id: seed.pCoffee.id, qty: 2 }], { at: at(10, 9) });
    await push(e);
    const [o] = await db.select().from(S.orders);
    await setPrice(db, seed.pCoffee.id, 9999, at(10, 10), "owner"); // price changes later
    const cfg = await buildDeviceConfig(db, dev, at(10, 12));
    expect(cfg.order_totals?.[e.client_event_id]).toBe(o.totalMillimes);
  });
});

describe("6. tickets", () => {
  async function sheet(type: "free" | "credit", count = 3, cap?: number) {
    const c = await createCustomer(db, { name: "Ali" }, "test");
    const s = await issueSheet(db, { customerId: c.id, type, count, maxAmountMillimes: cap ?? null }, "test");
    const p = await sheetForPrint(db, s.id);
    return { c, s, tokens: p.tickets.map((t) => t.token!), codes: p.tickets.map((t) => t.shortCode) };
  }

  it("issues unguessable single-use tickets; only hashes go to the tablet", async () => {
    const { tokens, codes } = await sheet("free");
    expect(new Set(tokens).size).toBe(3);
    expect(tokens[0].length).toBeGreaterThanOrEqual(22);
    const h = await validTicketHashes(db);
    expect(h.token_hashes).toContain(sha256Hex(tokens[0]));
    expect(h.code_hashes).toContain(sha256Hex(codes[0]));
    expect(JSON.stringify(h)).not.toContain(tokens[0]);
  });

  it("single use + reuse → conflict; free order revenue 0 & cost counted as giveaway", async () => {
    const { tokens } = await sheet("free");
    const th = sha256Hex(tokens[0]);
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "ticket", tokenHash: th }));
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 10), payment: "ticket", tokenHash: th }));
    const os = await db.select().from(S.orders).orderBy(S.orders.deviceSeq);
    expect(os[0].status).toBe("ok");
    expect(os[1].status).toBe("pending_review");
    expect(os[1].flags).toContain("ticket_conflict");
    const sum = await profitSummary(db, "2026-03-10", "2026-03-10");
    expect(sum.salesCash).toBe(0);
    expect(sum.freeGiveawaysCost).toBe(500);
  });

  it("offline double use: the earliest effective time wins even if synced later", async () => {
    const { tokens } = await sheet("credit");
    const th = sha256Hex(tokens[0]);
    const tab2Dev = await createDevice(db, "T2");
    const tab2 = new FakeTablet(tab2Dev.id);
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 11), payment: "ticket", tokenHash: th }));
    const [d2] = await db.select().from(S.devices).where(eq(S.devices.id, tab2Dev.id));
    await processPush(db, d2, [tab2.event([{ product_id: seed.pWater.id, qty: 1 }], { at: at(10, 9), payment: "ticket", tokenHash: th })], NOW);
    const os = await db.select().from(S.orders);
    const early = os.find((o) => o.orderLabel === "T2-0001")!;
    const late = os.find((o) => o.orderLabel === "T1-0001")!;
    expect(early.status).toBe("ok");
    expect(late.status).toBe("pending_review");
    expect(late.flags).toContain("ticket_conflict");
    const [t] = await db.select().from(S.tickets).where(eq(S.tickets.tokenHash, th));
    expect(t.usedOrderId).toBe(early.id);
    const c = (await db.select().from(S.customers))[0];
    expect(await customerBalance(db, c.id)).toBe(1000); // only the water order is a debt
  });

  it("cap exceeded → pending_review + over_ticket_limit", async () => {
    const { codes } = await sheet("free", 1, 2000);
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 2 }], { at: at(10, 9), payment: "ticket", codeHash: sha256Hex(codes[0]) }));
    const [o] = await db.select().from(S.orders);
    expect(o.status).toBe("pending_review");
    expect(o.flags).toContain("over_ticket_limit");
    await approveOrder(db, o.id, "ok", "owner");
    expect((await db.select().from(S.orders))[0].status).toBe("ok");
  });

  it("credit: charge on use, repayment counted as cash revenue on repayment day, not in drawer", async () => {
    const { c, tokens } = await sheet("credit");
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 3 }], { at: at(10, 9), payment: "ticket", tokenHash: sha256Hex(tokens[0]) }));
    expect(await customerBalance(db, c.id)).toBe(5400);
    await recordRepayment(db, c.id, 5400, at(12, 10), null, "owner");
    expect(await customerBalance(db, c.id)).toBe(0);
    expect((await profitSummary(db, "2026-03-10", "2026-03-10")).revenueCash).toBe(0);
    expect((await profitSummary(db, "2026-03-12", "2026-03-12")).revenueCash).toBe(5400);
    expect((await expectedCash(db, "2026-03-12", "morning")).expectedCash).toBe(0);
  });

  it("low remaining tickets alert", async () => {
    await setSetting(db, "low_tickets_threshold", 2);
    const { tokens } = await sheet("free", 3);
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 1 }], { at: at(10, 9), payment: "ticket", tokenHash: sha256Hex(tokens[0]) }));
    expect(await alertTypes()).toContain("low_tickets");
  });
});

describe("7. void", () => {
  it("reverses stock, re-opens ticket, reverses credit and audits", async () => {
    const c = await createCustomer(db, { name: "Sami" }, "test");
    const s = await issueSheet(db, { customerId: c.id, type: "credit", count: 1 }, "test");
    const tok = (await sheetForPrint(db, s.id)).tickets[0].token!;
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 2 }], { at: at(10, 9), payment: "ticket", tokenHash: sha256Hex(tok) }));
    const [o] = await db.select().from(S.orders);
    await voidOrder(db, o.id, "خطأ", "owner");
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(2_000_000);
    const [t] = await db.select().from(S.tickets);
    expect(t.status).toBe("issued");
    expect(await customerBalance(db, c.id)).toBe(0);
    const log = await db.select().from(S.auditLog).where(eq(S.auditLog.action, "order.void"));
    expect(log).toHaveLength(1);
    await expect(voidOrder(db, o.id, "again", "owner")).rejects.toThrow();
  });
});

describe("stock counts & margin (§7.4)", () => {
  it("uses theoretical at the ACTUAL count time and computes margin used", async () => {
    // 80 cups sold during the morning of the 10th
    const evs = [];
    for (let i = 0; i < 8; i++) evs.push(tab.event([{ product_id: seed.pCoffee.id, qty: 10 }], { at: at(10, 9, i) }));
    await push(...evs);
    // a sale AFTER the count, synced before the count is typed in
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 4 }], { at: at(10, 16) }));
    // physical count at 15:00: honest operation → 1 kg theoretical + 80 × 1388.889 surplus ≈ 1,111,111 mg
    const [row] = await recordCount(db, { ts: at(10, 15), handover: "morning_to_evening", entries: [{ stockItemId: seed.coffee.id, countedBase: 1_111_111 }] }, "owner");
    expect(row.theoreticalBase).toBe(1_000_000);
    expect(row.unitsSold).toBe(80);
    expect(Number(row.marginUsedPct)).toBeCloseTo(0, 0);
    expect(row.evaluatedShift).toBe("morning");
    // stock after: counted − later 4 cups
    expect(await theoreticalAt(db, seed.coffee.id, NOW)).toBe(1_111_111 - 50_000);
  });

  it("zero variance = 100% margin used (critical); negative variance → alerts", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 10 }], { at: at(10, 9) }));
    await recordCount(db, { ts: at(10, 15), handover: "morning_to_evening", entries: [{ stockItemId: seed.coffee.id, countedBase: 1_875_000 }] }, "owner");
    expect(await alertTypes()).toContain("margin_critical");
    await push(tab.event([{ product_id: seed.pWater.id, qty: 2 }], { at: at(10, 16) }));
    await recordCount(db, { ts: at(11, 6), handover: "evening_to_morning", entries: [{ stockItemId: seed.water.id, countedBase: 40 }] }, "owner");
    expect(await alertTypes()).toContain("piece_variance"); // 46 expected, 40 counted
    const rows = await shiftRows(db, "2026-03-10", "2026-03-10");
    expect(rows.find((r) => r.shift === "morning")!.color).not.toBe("green");
  });
});

describe("cash reconciliation & profit (§7.5, §7.8)", () => {
  it("subtracts only drawer expenses; alerts on variance and ticket mismatch", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 5 }], { at: at(10, 9) })); // 9.000
    await createExpense(db, { kind: "variable", category: "خبز", label: "خبز", amountMillimes: 2000, startDay: "2026-03-10", paidFrom: "drawer", paidAt: at(10, 10), invoiceRef: "F-1" }, "owner");
    await createExpense(db, { kind: "variable", category: "غاز", label: "غاز", amountMillimes: 5000, startDay: "2026-03-10", paidFrom: "owner" }, "owner");
    const exp = await expectedCash(db, "2026-03-10", "morning");
    expect(exp.expectedCash).toBe(7000);
    await recordCashCount(db, { ts: at(10, 15), businessDay: "2026-03-10", shift: "morning", countedCashMillimes: 6500, ticketsInDrawer: 1 }, "owner");
    const t = await alertTypes();
    expect(t).toContain("cash_variance");
    expect(t).toContain("ticket_mismatch");
    await expect(createExpense(db, { kind: "variable", category: "x", label: "x", amountMillimes: 1, startDay: "2026-03-10", paidFrom: "drawer", paidAt: at(10, 10) }, "owner")).rejects.toThrow();
  });

  it("profit cash vs consumption", async () => {
    await push(tab.event([{ product_id: seed.pCoffee.id, qty: 10 }], { at: at(10, 9) })); // 18.000, cost 5.000
    await recordPurchase(db, { stockItemId: seed.coffee.id, qtyBase: 1_000_000, totalMillimes: 40_000, ts: at(10, 8), paidFrom: "owner", invoiceRef: "A" }, "owner");
    await createExpense(db, { kind: "fixed", category: "كراء", label: "كراء", amountMillimes: 310_000, startDay: "2026-03-01" }, "owner");
    const s = await profitSummary(db, "2026-03-10", "2026-03-10");
    expect(s.revenueCash).toBe(18000);
    expect(s.purchases).toBe(40000);
    expect(s.fixedProrated).toBe(10000);
    expect(s.cogs).toBe(5000);
    expect(s.profitCash).toBe(18000 - 40000 - 10000);
    expect(s.profitConsumption).toBe(18000 - 5000 - 10000);
  });
});
