"use server";
/** All admin mutations (Owner only, password + 2FA, audited, transactional). */
import { and, eq, isNull } from "drizzle-orm";
import { alerts, stockItems } from "@/db/schema";
import { run } from "@/admin/act";
import { createProduct, saveRecipe, setPrice, updateProduct, type RecipeLineInput } from "@/server/catalog";
import {
  createStockItem, recordCount, recordExplainedLoss, recordPurchase, updateStockItem, type Handover,
} from "@/server/stock";
import {
  createCustomer, issueSheet, recordCreditAdjustment, recordRepayment, updateCustomer, voidTicket,
} from "@/server/tickets";
import { adminPayOrder, approveOrder, createManualOrder, markOrderUnpaidLoss, voidOrder } from "@/server/orders";
import { createExpense, deactivateExpense, endFixedExpense, recordCashCount, setRoster } from "@/server/finance";
import { createPairingCode, revokeDevice } from "@/server/devices";
import { DEFAULT_SETTINGS, getSettings, setSetting, type Settings } from "@/server/settings";
import { audit } from "@/server/audit";
import { buildDailyReport, runPeriodicChecks, sendTelegram } from "@/server/checks";
import { bigToBase, smallToBase, yieldToNominalBase, yieldToRealBase, type StockKind } from "@/lib/units";
import { addDays, shiftInfo, type Shift } from "@/lib/time";
import { roundHalfUp } from "@/lib/money";

// ---------------------------------------------------------------- products
export async function saveProductAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const id = f.optInt("id");
    const input = { nameAr: f.str("nameAr", true), nameFr: f.opt("nameFr"), category: f.opt("category"), color: f.opt("color"), image: f.opt("image"), sortOrder: f.int("sortOrder", 0), active: f.bool("active") };
    if (id) { await updateProduct(db, id, input, actor); return; }
    const p = await createProduct(db, { ...input, active: true }, actor);
    const price = f.optMoney("price");
    if (price !== null) await setPrice(db, p.id, price, new Date(), actor);
    return `/admin/products/${p.id}`;
  });
}

export async function setPriceAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    await setPrice(db, f.int("productId"), f.money("price"), f.time("effectiveFrom"), actor);
  }, "تم تسجيل السعر الجديد ✓");
}

/**
 * Recipe editor: each line is entered either as "units per kg/L" (accounted & real yields, e.g. 80 & 90 cups/kg)
 * or as a quantity per unit in g / ml / pieces. The server converts to base units. Saving = new version.
 */
export async function saveRecipeAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const productId = f.int("productId");
    const ids = f.all("line_item");
    const modes = f.all("line_mode");
    const noms = f.all("line_nominal");
    const reals = f.all("line_real");
    const items = await db.select().from(stockItems);
    const lines: RecipeLineInput[] = [];
    ids.forEach((sid, i) => {
      if (!sid) return;
      const it = items.find((x) => x.id === Number(sid));
      if (!it) throw new Error("مادة غير موجودة");
      const kind = it.kind as StockKind;
      const nom = (noms[i] ?? "").trim(), real = (reals[i] ?? "").trim();
      if (!nom) throw new Error(`الكمية مطلوبة لـ "${it.nameAr}"`);
      let qtyBase: number, realQtyBase: number;
      if (kind === "piece") {
        qtyBase = Number(nom);
        if (!Number.isInteger(qtyBase) || qtyBase <= 0) throw new Error(`"${it.nameAr}": عدد قطع صحيح مطلوب`);
        realQtyBase = qtyBase;
      } else if (modes[i] === "yield") {
        const n = Number(nom.replace(",", ".")), r = Number((real || nom).replace(",", "."));
        if (r < n) throw new Error(`"${it.nameAr}": الإنتاج الحقيقي لا يمكن أن يكون أقل من المحسوب`);
        qtyBase = yieldToNominalBase(kind, n);
        realQtyBase = yieldToRealBase(kind, r);
      } else {
        qtyBase = smallToBase(kind, nom);
        realQtyBase = real ? roundHalfUp(Number(real.replace(",", ".")) * (kind === "weight" ? 1000 : 1), 3) : qtyBase;
      }
      if (realQtyBase > qtyBase) realQtyBase = qtyBase;
      lines.push({ stockItemId: it.id, qtyBase, realQtyBase });
    });
    await saveRecipe(db, productId, lines, f.time("effectiveFrom"), actor);
  }, "تم حفظ نسخة جديدة من الوصفة ✓");
}

// ---------------------------------------------------------------- stock
export async function saveStockItemAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const id = f.optInt("id");
    const kind = (f.str("kind") || "weight") as StockKind;
    const minRaw = f.str("min");
    if (id) {
      const [it] = await db.select().from(stockItems).where(eq(stockItems.id, id));
      await updateStockItem(db, id, { nameAr: f.str("nameAr", true), minQtyBase: minRaw ? bigToBase(it.kind as StockKind, minRaw) : 0, active: f.bool("active") }, actor);
      return;
    }
    const it = await createStockItem(db, { nameAr: f.str("nameAr", true), kind, minQtyBase: minRaw ? bigToBase(kind, minRaw) : 0 }, actor);
    const opening = f.str("openingQty");
    if (opening) {
      await recordPurchase(db, { stockItemId: it.id, qtyBase: bigToBase(kind, opening), totalMillimes: f.optMoney("openingValue") ?? 0, ts: new Date(), paidFrom: "owner", opening: true, note: "مخزون افتتاحي" }, actor);
    }
    return `/admin/stock/${it.id}`;
  });
}

export async function purchaseAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const [it] = await db.select().from(stockItems).where(eq(stockItems.id, f.int("stockItemId")));
    if (!it) throw new Error("مادة غير موجودة");
    const paidFrom = f.str("paidFrom") === "drawer" ? "drawer" : "owner";
    const ts = f.time("ts");
    await recordPurchase(db, {
      stockItemId: it.id, qtyBase: bigToBase(it.kind as StockKind, f.str("qty", true)), totalMillimes: f.money("total"),
      ts, paidFrom, paidAt: paidFrom === "drawer" ? (f.str("paidAt") ? f.time("paidAt") : ts) : null,
      invoiceRef: f.opt("invoiceRef"), note: f.opt("note"), opening: f.bool("opening"),
    }, actor);
  }, "تم تسجيل الشراء ✓");
}

export async function lossAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const [it] = await db.select().from(stockItems).where(eq(stockItems.id, f.int("stockItemId")));
    if (!it) throw new Error("مادة غير موجودة");
    const type = f.str("type") === "staff_consumption" ? "staff_consumption" : "waste";
    const unit = f.str("unit");
    const kind = it.kind as StockKind;
    const qty = unit === "small" ? smallToBase(kind, f.str("qty", true)) : bigToBase(kind, f.str("qty", true));
    await recordExplainedLoss(db, type, it.id, qty, f.time("ts"), f.str("note", true), actor);
  });
}

export async function countAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const items = await db.select().from(stockItems).where(eq(stockItems.active, true));
    const entries = [];
    for (const it of items) {
      const v = f.str(`count_${it.id}`);
      if (v === "") continue;
      entries.push({ stockItemId: it.id, countedBase: bigToBase(it.kind as StockKind, v) });
    }
    if (!entries.length) throw new Error("أدخل كمية مادة واحدة على الأقل");
    const ts = f.time("ts");
    // "auto": pick the handover from the count time (around evening start = morning handover, around morning start = evening handover)
    let handover = (f.str("handoverOverride") || f.str("handover", true)) as Handover | "auto";
    if (handover === "auto") {
      const st = await getSettings(db);
      const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", hour: "2-digit", hourCycle: "h23" }).format(ts));
      const near = (x: number) => Math.min(Math.abs(h - x), 24 - Math.abs(h - x)) <= 2;
      handover = near(st.evening_start_hour) ? "morning_to_evening" : near(st.morning_start_hour) ? "evening_to_morning" : "unannounced";
    }
    const rows = await recordCount(db, { ts, handover, entries, countedBy: f.opt("countedBy"), note: f.opt("note") }, actor);
    return `/admin/stock/count?done=${rows.map((r) => r.id).join(",")}`;
  }, "تم تسجيل الجرد ✓");
}

// ---------------------------------------------------------------- tickets & customers
export async function saveCustomerAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const id = f.optInt("id");
    const input = { name: f.str("name", true), phone: f.opt("phone"), note: f.opt("note"), lowTicketsThreshold: f.optInt("lowTicketsThreshold") };
    if (id) { await updateCustomer(db, id, { ...input, active: f.bool("active") }, actor); return; }
    const c = await createCustomer(db, input, actor);
    return `/admin/customers/${c.id}`;
  });
}

export async function issueSheetAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const s = await issueSheet(db, { customerId: f.int("customerId"), type: f.str("type") === "credit" ? "credit" : "free", count: f.int("count"), maxAmountMillimes: f.optMoney("cap"), note: f.opt("note") }, actor);
    return `/admin/tickets?printed=${s.id}`;
  }, "تم إصدار ورقة التذاكر ✓");
}

export async function voidTicketAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await voidTicket(db, f.str("ticketId", true), f.str("reason") || "إلغاء", actor); }, "تم إلغاء التذكرة ✓");
}

export async function repaymentAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await recordRepayment(db, f.int("customerId"), f.money("amount"), f.time("ts"), f.opt("note"), actor); }, "تم تسجيل السداد ✓");
}

export async function creditAdjustAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await recordCreditAdjustment(db, f.int("customerId"), f.money("amount"), f.str("note", true), actor); });
}

// ---------------------------------------------------------------- orders
export async function voidOrderAction(fd: FormData) {
  await run(fd, async ({ db, actor, ip, f }) => { await voidOrder(db, f.str("orderId", true), f.str("reason", true), actor, ip); }, "تم إلغاء الطلب ✓");
}

export async function approveOrderAction(fd: FormData) {
  await run(fd, async ({ db, actor, ip, f }) => { await approveOrder(db, f.str("orderId", true), f.str("note"), actor, ip); }, "تمت الموافقة ✓");
}

export async function manualOrderAction(fd: FormData) {
  await run(fd, async ({ db, actor, ip, f }) => {
    const items: { product_id: number; qty: number }[] = [];
    for (const [k, v] of f.raw().entries()) {
      if (k.startsWith("qty_") && String(v).trim() && Number(v) > 0) items.push({ product_id: Number(k.slice(4)), qty: Number(v) });
    }
    if (!items.length) throw new Error("أضف منتجاً واحداً على الأقل");
    const pm = f.str("payment");
    const payment = pm === "ticket" ? "ticket" : pm === "later" ? "later" : "cash";
    const res = await createManualOrder(db, { items, payment, ticketCode: f.opt("ticketCode"), at: f.time("at"), note: f.opt("note"), tableRef: f.opt("tableRef") }, actor, ip);
    return `/admin/orders/${res.id}`;
  }, "تم تسجيل الطلب اليدوي ✓");
}

// ---------------------------------------------------------------- shifts, cash, expenses
export async function rosterAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const day = f.str("day", true);
    await setRoster(db, day, "morning", f.str("morning"), actor);
    await setRoster(db, day, "evening", f.str("evening"), actor);
  });
}

export async function defaultWorkersAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const before = await getSettings(db);
    await setSetting(db, "default_worker_morning", f.str("morning"));
    await setSetting(db, "default_worker_evening", f.str("evening"));
    await audit(db, actor, "settings.default_workers", "settings", null, { m: before.default_worker_morning, e: before.default_worker_evening }, { m: f.str("morning"), e: f.str("evening") });
  });
}

export async function cashCountAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const ts = f.time("ts");
    await recordCashCount(db, {
      ts, businessDay: f.str("day", true), shift: (f.str("shift") === "evening" ? "evening" : "morning") as Shift,
      countedCashMillimes: f.money("counted"), ticketsInDrawer: f.int("tickets", 0), countedBy: f.opt("countedBy"), note: f.opt("note"),
    }, actor);
  }, "تم تسجيل عدّ الكاش ✓");
}

export async function expenseAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const kind = f.str("kind") === "fixed" ? "fixed" : "variable";
    const s = await getSettings(db);
    const paidFrom = kind === "variable" && f.str("paidFrom") === "drawer" ? "drawer" : "owner";
    const paidAt = f.str("paidAt") ? f.time("paidAt") : paidFrom === "drawer" ? new Date() : null;
    const startDay = kind === "fixed" ? f.str("startDay", true) : f.str("startDay") || shiftInfo(paidAt ?? new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
    await createExpense(db, {
      kind, category: f.str("category"), label: f.str("label", true), amountMillimes: f.money("amount"),
      startDay, endDay: f.opt("endDay"), paidFrom, paidAt, invoiceRef: f.opt("invoiceRef"),
    }, actor);
  });
}

export async function expenseDeactivateAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await deactivateExpense(db, f.int("id"), actor); }, "تم إيقاف المصروف ✓");
}

export async function expenseEndAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await endFixedExpense(db, f.int("id"), f.str("endDay", true), actor); });
}

// ---------------------------------------------------------------- alerts, devices, settings
export async function ackAlertAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const id = f.optInt("id");
    if (id) await db.update(alerts).set({ acknowledgedBy: actor, acknowledgedAt: new Date() }).where(eq(alerts.id, id));
    else await db.update(alerts).set({ acknowledgedBy: actor, acknowledgedAt: new Date() }).where(and(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt)));
    await audit(db, actor, "alert.ack", "alert", id ?? "all", null, null);
  }, "تم ✓");
}

export async function pairCodeAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const r = await createPairingCode(db, f.str("name") || "T1", actor);
    return `/admin/devices?code=${r.code}&name=${r.name}&exp=${r.expiresAt.getTime()}`;
  }, "تم إنشاء رمز الربط ✓");
}

export async function revokeDeviceAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => { await revokeDevice(db, f.str("id", true), actor); }, "تم إلغاء ربط الجهاز ✓");
}

const NUM_KEYS: (keyof Settings)[] = [
  "morning_start_hour", "evening_start_hour", "max_offline_hours", "future_tolerance_min", "low_tickets_threshold",
  "consumption_window_days", "reorder_days_ahead", "device_silent_hours", "unpaid_alert_hours", "margin_critical_pct", "margin_warn_pct",
  "margin_warn_consecutive", "void_spike_count", "risk_yellow_at", "risk_red_at",
];

export async function settingsAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const before = await getSettings(db);
    const after: Partial<Settings> = {};
    after.business_name = f.str("business_name") || DEFAULT_SETTINGS.business_name;
    for (const k of NUM_KEYS) (after as Record<string, number>)[k] = f.int(k, before[k] as number);
    if (after.morning_start_hour! < 0 || after.morning_start_hour! > 23 || after.evening_start_hour! <= after.morning_start_hour! || after.evening_start_hour! > 23) {
      throw new Error("ساعات الشيفت غير صالحة (الصباح < المساء، بين 0 و 23)");
    }
    after.clock_skew_threshold_ms = f.int("clock_skew_threshold_s", before.clock_skew_threshold_ms / 1000) * 1000;
    after.variance_value_critical_millimes = f.money("variance_value_critical");
    after.busy_hours = f.str("busy_hours").split(/[,\s]+/).filter(Boolean).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
    after.telegram_chat_id = f.str("telegram_chat_id");
    after.report_email = f.str("report_email");
    const rw = { ...before.risk_weights };
    for (const k of Object.keys(rw) as (keyof typeof rw)[]) rw[k] = f.int(`rw_${k}`, rw[k]);
    after.risk_weights = rw;
    for (const [k, v] of Object.entries(after)) await setSetting(db, k as keyof Settings, v);
    await audit(db, actor, "settings.update", "settings", null, before, after);
  });
}

export async function testReportAction(fd: FormData) {
  await run(fd, async ({ db }) => {
    const s = await getSettings(db);
    const day = addDays(shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay, 0);
    await sendTelegram(s.telegram_chat_id, await buildDailyReport(db, day));
  }, "تم إرسال التقرير إلى تيليغرام ✓");
}

export async function runChecksAction(fd: FormData) {
  await run(fd, async ({ db }) => { await runPeriodicChecks(db); }, "تم الفحص ✓");
}

export async function adminPayAction(fd: FormData) {
  await run(fd, async ({ db, actor, ip, f }) => {
    const to = f.str("paidTo");
    await adminPayOrder(db, f.str("orderId", true), f.time("at"), to === "owner" ? "owner" : to === "worker" ? "worker" : "drawer", actor, ip);
  }, "تم تسجيل الدفع ✓");
}

export async function unpaidLossAction(fd: FormData) {
  await run(fd, async ({ db, actor, ip, f }) => { await markOrderUnpaidLoss(db, f.str("orderId", true), f.str("reason", true), actor, ip); }, "تم التسجيل كغير مدفوع ✓");
}

/** A supplier invoice with one or more items (simple purchase page). */
export async function purchaseInvoiceAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const items = await db.select().from(stockItems);
    const drawer = f.bool("fromDrawer");
    const ts = f.str("ts") ? f.time("ts") : new Date();
    const invoiceRef = f.opt("invoiceRef");
    if (drawer && !invoiceRef) throw new Error("دُفع من الدرج: رقم الفاتورة مطلوب");
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const id = f.str(`item_${i}`), qty = f.str(`qty_${i}`), total = f.str(`total_${i}`);
      if (!id && !qty && !total) continue;
      const it = items.find((x) => x.id === Number(id));
      if (!it) throw new Error(`السطر ${i + 1}: اختر المادة`);
      if (!qty) throw new Error(`"${it.nameAr}": الكمية مطلوبة`);
      if (!total) throw new Error(`"${it.nameAr}": السعر مطلوب`);
      await recordPurchase(db, {
        stockItemId: it.id, qtyBase: bigToBase(it.kind as StockKind, qty), totalMillimes: f.money(`total_${i}`),
        ts, paidFrom: drawer ? "drawer" : "owner", paidAt: drawer ? ts : null, invoiceRef, note: f.opt("note"),
      }, actor);
      n++;
    }
    if (!n) throw new Error("أضف مادة واحدة على الأقل");
    return "/admin/stock";
  }, "تم تسجيل الشراء ✓");
}

/** One-time opening stock: what is physically in the café now (no expense is created). */
export async function openingStockAction(fd: FormData) {
  await run(fd, async ({ db, actor, f }) => {
    const items = await db.select().from(stockItems).where(eq(stockItems.active, true));
    let n = 0;
    for (const it of items) {
      const qty = f.str(`qty_${it.id}`);
      if (!qty) continue;
      const qtyBase = bigToBase(it.kind as StockKind, qty);
      if (qtyBase <= 0) continue;
      await recordPurchase(db, {
        stockItemId: it.id, qtyBase, totalMillimes: f.optMoney(`value_${it.id}`) ?? 0, ts: new Date(),
        paidFrom: "owner", opening: true, note: "مخزون افتتاحي",
      }, actor);
      n++;
    }
    if (!n) throw new Error("أدخل كمية مادة واحدة على الأقل");
    return "/admin/stock";
  }, "تم إدخال المخزون الافتتاحي ✓");
}
