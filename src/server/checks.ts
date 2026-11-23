import "server-only";
import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { alerts, customers, devices, orders } from "@/db/schema";
import type { Exec } from "@/db";
import { raiseAlert, resolveAlerts } from "./audit";
import { getSettings } from "./settings";
import { checkStockAlerts, shiftStockReport } from "./stock";
import { checkLowTickets } from "./tickets";
import { profitSummary, shiftRows } from "./finance";
import { formatDT } from "@/lib/money";
import { addDays, shiftEnd, shiftInfo, SHIFT_AR, tunisLocalToUtc, tunisParts } from "@/lib/time";

/** Periodic checks (dashboard load + cron): device silent, busy hours with no orders, stock early warnings, low tickets. */
export async function runPeriodicChecks(db: Exec, now = new Date()) {
  const s = await getSettings(db);
  const devs = await db.select().from(devices).where(eq(devices.status, "active"));
  for (const d of devs) {
    const key = `device_silent:${d.id}`;
    const last = d.lastSyncAt ?? d.pairedAt;
    if (last && now.getTime() - last.getTime() > s.device_silent_hours * 3_600_000) {
      await raiseAlert(db, { severity: "warn", type: "device_silent", dedupeKey: key, message: `الجهاز ${d.name} لم يزامن منذ أكثر من ${s.device_silent_hours} ساعات` });
    } else await resolveAlerts(db, key);
  }
  if (s.busy_hours.length) {
    const p = tunisParts(now);
    const prevHour = (p.hour + 23) % 24;
    if (s.busy_hours.includes(prevHour)) {
      const dayParts = prevHour > p.hour ? tunisParts(new Date(now.getTime() - 86_400_000)) : p;
      const start = tunisLocalToUtc(dayParts.year, dayParts.month, dayParts.day, prevHour);
      const end = new Date(start.getTime() + 3_600_000);
      const [r] = await db.select({ n: sql<string>`count(*)` }).from(orders).where(and(gte(orders.effectiveTs, start), lt(orders.effectiveTs, end)));
      if (Number(r.n) === 0 && devs.length) {
        const info = shiftInfo(start, s.morning_start_hour, s.evening_start_hour);
        await raiseAlert(db, { severity: "warn", type: "no_orders_busy_hour", dedupeKey: `no_orders:${start.toISOString()}`, ...info, message: `لا توجد أي طلبات بين ${prevHour}:00 و ${prevHour + 1}:00 (ساعة ذروة)` });
      }
    }
  }
  // pay-later orders: one alert per order unpaid for too long, one per shift that ended with unpaid orders
  const open = await db.select().from(orders).where(and(eq(orders.paymentType, "pending"), ne(orders.status, "void")));
  const cur = shiftInfo(now, s.morning_start_hour, s.evening_start_hour);
  const byShift = new Map<string, { day: string; shift: string; n: number; v: number }>();
  for (const o of open) {
    const hours = (now.getTime() - o.effectiveTs.getTime()) / 3_600_000;
    if (hours >= s.unpaid_alert_hours) {
      await raiseAlert(db, {
        severity: "warn", type: "unpaid_order", dedupeKey: `unpaid:${o.id}`, ref: `order:${o.id}`, businessDay: o.businessDay, shift: o.shift,
        message: `الطلب ${o.orderLabel}${o.tableRef ? ` (${o.tableRef})` : ""} غير مدفوع منذ ${Math.floor(hours)} ساعات — ${formatDT(o.totalMillimes)}`,
      });
    }
    if (o.businessDay !== cur.businessDay || o.shift !== cur.shift) {
      const k = `${o.businessDay}:${o.shift}`;
      const e = byShift.get(k) ?? { day: o.businessDay, shift: o.shift, n: 0, v: 0 };
      e.n++; e.v += o.totalMillimes;
      byShift.set(k, e);
    }
  }
  for (const e of byShift.values()) {
    await raiseAlert(db, {
      severity: "warn", type: "unpaid_shift", dedupeKey: `unpaid_shift:${e.day}:${e.shift}`, businessDay: e.day, shift: e.shift,
      message: `انتهى شيفت ${e.day} ${SHIFT_AR[e.shift as "morning"]} وبقيت ${e.n} طلبات غير مدفوعة — ${formatDT(e.v)} على عامل الشيفت`,
    });
  }

  // shifts that ended (> 6 h ago, last 3 days) with orders but no stock count → ask for the paper count
  const from = addDays(cur.businessDay, -3);
  for (const r of await shiftStockReport(db, from, cur.businessDay)) {
    const key = `missing_count:${r.businessDay}:${r.shift}`;
    const ended = shiftEnd(r.businessDay, r.shift, s.morning_start_hour, s.evening_start_hour);
    if (r.counted || r.orders === 0 || now.getTime() - ended.getTime() < 6 * 3_600_000) { if (r.counted) await resolveAlerts(db, key); continue; }
    await raiseAlert(db, {
      severity: "warn", type: "missing_stock_count", dedupeKey: key, businessDay: r.businessDay, shift: r.shift,
      message: `لم يُسجَّل جرد المخزون لشيفت ${r.businessDay} ${SHIFT_AR[r.shift]} (${r.orders} طلب) — أدخل ورقة الجرد`,
    });
  }

  await checkStockAlerts(db, undefined, now);
  const custs = await db.select({ id: customers.id }).from(customers).where(eq(customers.active, true));
  for (const c of custs) await checkLowTickets(db, c.id);
}

export async function buildDailyReport(db: Exec, businessDay: string) {
  const s = await getSettings(db);
  const sum = await profitSummary(db, businessDay, businessDay);
  const rows = await shiftRows(db, businessDay, businessDay);
  const open = await db.select().from(alerts).where(and(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt))).orderBy(sql`${alerts.ts} desc`).limit(15);
  const color = { green: "🟢", yellow: "🟡", red: "🔴" } as const;
  const lines = [
    `☕ ${s.business_name} — تقرير يوم ${businessDay}`,
    ``,
    `الإيراد النقدي: ${formatDT(sum.revenueCash)} (مبيعات ${formatDT(sum.salesCash)} + سداد كريدي ${formatDT(sum.creditRepayments)})`,
    `المشتريات: ${formatDT(sum.purchases)} · مصاريف أخرى: ${formatDT(sum.otherVariable)} · ثابتة: ${formatDT(sum.fixedProrated)}`,
    `الربح (نقدي): ${formatDT(sum.profitCash)} · الربح (استهلاك): ${formatDT(sum.profitConsumption)}`,
    `مجاني (تكلفة): ${formatDT(sum.freeGiveawaysCost)} · كريدي غير مسدد: ${formatDT(sum.creditOutstanding)}`,
    `الطلبات: ${sum.ordersCount} · ملغاة: ${sum.voidCount} · تحتاج مراجعة: ${sum.pendingCount}`,
    `غير مدفوعة: ${sum.unpaidCount} (${formatDT(sum.unpaidValue)}) · خرج دون دفع: ${formatDT(sum.unpaidLossValue)}`,
    ``,
    ...rows.map((r) => `${color[r.color]} ${SHIFT_AR[r.shift]} (${r.worker}): ${r.orders} طلب، ${formatDT(r.salesCash)}، هامش ${r.marginUsedAvg ?? "—"}%، فرق كاش ${r.cashVariance === null ? "لم يُعد" : formatDT(r.cashVariance)}`),
    ``,
    open.length ? `تنبيهات مفتوحة (${open.length}):` : `لا توجد تنبيهات مفتوحة ✓`,
    ...open.map((a) => `• ${a.message}`),
  ];
  return lines.join("\n");
}

export async function sendTelegram(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN غير مضبوط في متغيرات البيئة");
  if (!chatId) throw new Error("معرّف محادثة تيليغرام غير مضبوط في الإعدادات");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!r.ok) throw new Error(`Telegram: ${r.status} ${await r.text()}`);
}

export async function sendDailyReport(db: Exec, now = new Date()) {
  const s = await getSettings(db);
  const yesterday = addDays(shiftInfo(now, s.morning_start_hour, s.evening_start_hour).businessDay, -1);
  const text = await buildDailyReport(db, yesterday);
  await sendTelegram(s.telegram_chat_id, text);
  return text;
}
