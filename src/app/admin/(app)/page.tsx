import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { alerts, devices } from "@/db/schema";
import { profitSummary, shiftRows, type ProfitSummary } from "@/server/finance";
import { runPeriodicChecks } from "@/server/checks";
import { getSettings } from "@/server/settings";
import { Flash, Money, PageTitle, RiskDot, Stat, type SP } from "@/admin/ui";
import { formatTunis, monthEnd, monthStart, shiftInfo, SHIFT_AR, weekStart, addDays } from "@/lib/time";
import { ALERT_TYPE_AR } from "@/server/audit";

export const dynamic = "force-dynamic";

function Cards({ title, s }: { title: string; s: ProfitSummary }) {
  return (
    <section className="mb-5">
      <h2 className="h2 mb-2">{title} <span className="muted text-sm font-normal">({s.from}{s.from !== s.to ? ` → ${s.to}` : ""})</span></h2>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="الإيراد النقدي" value={<Money m={s.revenueCash} />} hint={<>مبيعات <Money m={s.salesCash} /> + سداد <Money m={s.creditRepayments} /></>} />
        <Stat label="المشتريات + متغيرة" value={<Money m={s.purchases + s.otherVariable} />} hint={<>مشتريات <Money m={s.purchases} /></>} />
        <Stat label="ثابتة (موزعة)" value={<Money m={s.fixedProrated} />} />
        <Stat label="الربح (نقدي)" value={<Money m={s.profitCash} />} tone={s.profitCash >= 0 ? "good" : "bad"} hint="الإيراد − المشتريات − المصاريف" />
        <Stat label="الربح (استهلاك)" value={<Money m={s.profitConsumption} />} tone={s.profitConsumption >= 0 ? "good" : "bad"} hint="الإيراد − تكلفة المبيع − المصاريف" />
        <Stat label="مجاني (تكلفة)" value={<Money m={s.freeGiveawaysCost} />} tone="warn" />
        <Stat label="كريدي غير مسدد" value={<Money m={s.creditOutstanding} />} hint={`${s.ordersCount} طلب · ${s.voidCount} ملغى · ${s.pendingCount} للمراجعة`} />
        <Stat label="غير مدفوعة" value={<Money m={s.unpaidValue} />} tone={s.unpaidCount ? "warn" : undefined} hint={<>{s.unpaidCount} طلب{s.unpaidLossValue ? <> · خرج دون دفع <Money m={s.unpaidLossValue} /></> : null}</>} />
      </div>
    </section>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  await runPeriodicChecks(db).catch((e) => console.error("checks", e));
  const s = await getSettings(db);
  const today = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const [d, w, m] = await Promise.all([
    profitSummary(db, today, today),
    profitSummary(db, weekStart(today), today),
    profitSummary(db, monthStart(today), monthEnd(today) < today ? monthEnd(today) : today),
  ]);
  const rows = await shiftRows(db, addDays(today, -1), today);
  const open = await db.select().from(alerts).where(and(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt))).orderBy(desc(alerts.ts)).limit(12);
  const devs = await db.select().from(devices).where(eq(devices.status, "active"));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="لوحة القيادة" sub={`يوم العمل الحالي: ${today} — الشيفت الحالي: ${SHIFT_AR[shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).shift]}`}>
        <Link href="/admin/orders/new" className="btn btn-ghost">+ طلب يدوي</Link>
        <Link href="/admin/stock/count" className="btn">جرد / تسليم شيفت</Link>
      </PageTitle>
      <Cards title="اليوم" s={d} />
      <Cards title="هذا الأسبوع" s={w} />
      <Cards title="هذا الشهر" s={m} />

      <div className="grid xl:grid-cols-3 gap-4">
        <section className="card xl:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">الشيفتات (أمس واليوم)</h2>
          <table className="tbl">
            <thead><tr><th>اليوم</th><th>الشيفت</th><th>المسؤول</th><th>طلبات</th><th>مبيعات كاش</th><th>تذاكر</th><th>ملغاة</th><th>الهامش المستعمل</th><th>فرق الكاش</th><th>الحالة</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={10} className="muted text-center">لا نشاط بعد</td></tr>}
              {rows.map((r) => (
                <tr key={r.businessDay + r.shift}>
                  <td className="num">{r.businessDay}</td><td>{SHIFT_AR[r.shift]}</td><td>{r.worker}</td>
                  <td className="num">{r.orders}</td><td><Money m={r.salesCash} /></td><td className="num">{r.ticketOrders}</td>
                  <td className="num">{r.voids}</td><td className="num">{r.marginUsedAvg === null ? "—" : `${r.marginUsedAvg}%`}</td>
                  <td>{r.cashVariance === null ? <span className="muted">لم يُعد</span> : <Money m={r.cashVariance} />}</td>
                  <td><RiskDot color={r.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="flex justify-between items-center mb-2"><h2 className="h2">التنبيهات المفتوحة</h2><Link href="/admin/alerts" className="text-sm underline">الكل</Link></div>
          {open.length === 0 ? <p className="muted">لا توجد تنبيهات ✓</p> : (
            <ul className="space-y-2 text-sm">
              {open.map((a) => (
                <li key={a.id} className="border-b pb-2">
                  <span className={`badge ${a.severity === "critical" ? "badge-red" : a.severity === "warn" ? "badge-yellow" : "badge-blue"}`}>{ALERT_TYPE_AR[a.type] ?? a.type}</span>
                  <div className="mt-1">{a.message}</div>
                  <div className="muted text-xs num">{formatTunis(a.ts)}</div>
                </li>
              ))}
            </ul>
          )}
          <h2 className="h2 mt-4 mb-2">الأجهزة</h2>
          {devs.length === 0 ? <p className="muted text-sm">لا يوجد جهاز مربوط. <Link href="/admin/devices" className="underline">ربط تابلت</Link></p> : (
            <ul className="text-sm space-y-1">
              {devs.map((dv) => (
                <li key={dv.id} className="flex justify-between"><span className="font-bold">{dv.name}</span><span className="muted num">آخر مزامنة {formatTunis(dv.lastSyncAt)}{dv.pendingReported ? ` · في الانتظار ${dv.pendingReported}` : ""}</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
