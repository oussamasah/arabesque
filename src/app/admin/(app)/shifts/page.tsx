import { and, desc, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { cashCounts } from "@/db/schema";
import { expectedCash, ordersForReconciliation, shiftRows, workerFor } from "@/server/finance";
import { getSettings } from "@/server/settings";
import { cashCountAction, defaultWorkersAction, rosterAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, RiskDot, one, type SP } from "@/admin/ui";
import { addDays, formatTunis, shiftInfo, SHIFT_AR, toTunisLocalInput, type Shift } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function ShiftsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const cur = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour);
  // default selection: the shift that just ended (handover)
  const prev: { businessDay: string; shift: Shift } = cur.shift === "evening" ? { businessDay: cur.businessDay, shift: "morning" } : { businessDay: addDays(cur.businessDay, -1), shift: "evening" };
  const day = one(sp.day) ?? prev.businessDay;
  const shift = (one(sp.shift) as Shift) ?? prev.shift;
  const exp = await expectedCash(db, day, shift);
  const recon = await ordersForReconciliation(db, day, shift);
  const worker = await workerFor(db, day, shift, s);
  const days = Array.from({ length: 10 }, (_, i) => addDays(cur.businessDay, 3 - i));
  const roster = await Promise.all(days.map(async (d) => ({ d, m: await workerFor(db, d, "morning", s), e: await workerFor(db, d, "evening", s) })));
  const rows = await shiftRows(db, addDays(cur.businessDay, -13), cur.businessDay);
  const counts = await db.select().from(cashCounts).where(and(gte(cashCounts.businessDay, addDays(cur.businessDay, -13)))).orderBy(desc(cashCounts.ts));
  const back = `/admin/shifts?day=${day}&shift=${shift}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الشيفتات والكاش" sub={`صباحية ${s.morning_start_hour}:00 → ${s.evening_start_hour}:00 · مسائية ${s.evening_start_hour}:00 → ${s.morning_start_hour}:00. المسؤولية حسب الشيفت، تعديلها ممكن بأثر رجعي (مسجّل في سجل التدقيق).`} />

      <div className="grid xl:grid-cols-3 gap-4">
        <section className="card xl:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
            <h2 className="h2">عدّ الكاش وأوراق التذاكر</h2>
            <form className="flex gap-2 items-end" action="/admin/shifts">
              <label><span className="lbl">يوم العمل</span><input className="inp" type="date" name="day" defaultValue={day} /></label>
              <label><span className="lbl">الشيفت</span><select className="inp" name="shift" defaultValue={shift}><option value="morning">صباحية</option><option value="evening">مسائية</option></select></label>
              <button className="btn btn-ghost">عرض</button>
            </form>
          </div>
          <div className="grid md:grid-cols-4 gap-3 mb-3">
            <div className="card"><div className="muted text-sm">المسؤول</div><div className="font-bold">{worker}</div></div>
            <div className="card"><div className="muted text-sm">كاش مقبوض في هذا الشيفت</div><div className="font-bold"><Money m={exp.cashSales} /></div></div>
            <div className="card"><div className="muted text-sm">مصاريف من الدرج</div><div className="font-bold"><Money m={-exp.drawerExpenses} /></div></div>
            <div className="card"><div className="muted text-sm">الكاش المتوقع · تذاكر</div><div className="font-bold"><Money m={exp.expectedCash} /> · <span className="num">{exp.ticketsExpected}</span></div></div>
          </div>
          {exp.owedByWorker > 0 && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 mb-3">
              <b>على العامل ({worker}): <Money m={exp.owedByWorker} /></b> — {exp.owedCount} طلبات قُدّمت في هذا الشيفت ولم تُدفع.
              {" "}<a className="underline" href={`/admin/orders?day=${day}&shift=${shift}&pay=pending`}>عرضها</a>
            </div>
          )}
          <form action={cashCountAction} className="grid md:grid-cols-5 gap-3 items-end">
            <Back value={back} /><input type="hidden" name="day" value={day} /><input type="hidden" name="shift" value={shift} />
            <label><span className="lbl">الكاش المعدود (DT)</span><input className="inp" name="counted" required inputMode="decimal" dir="ltr" /></label>
            <label><span className="lbl">أوراق التذاكر في الدرج</span><input className="inp" name="tickets" type="number" min={0} defaultValue={0} required /></label>
            <label><span className="lbl">وقت العدّ</span><input className="inp" type="datetime-local" name="ts" defaultValue={toTunisLocalInput(new Date())} /></label>
            <label><span className="lbl">من عدّ</span><input className="inp" name="countedBy" /></label>
            <button className="btn">تسجيل</button>
          </form>
          <h3 className="font-bold mt-4 mb-1">طلبات التذاكر في هذا الشيفت (للمطابقة مع الأوراق)</h3>
          <table className="tbl">
            <thead><tr><th>الطلب</th><th>الوقت</th><th>الرمز</th><th>الزبون</th><th>النوع</th><th>القيمة</th></tr></thead>
            <tbody>
              {recon.length === 0 && <tr><td colSpan={6} className="muted text-center">لا توجد</td></tr>}
              {recon.map((r) => (
                <tr key={r.id}><td className="num">{r.label}</td><td className="num">{formatTunis(r.ts)}</td><td className="font-mono" dir="ltr">{r.ticketCode ?? "؟"}</td><td>{r.customer ?? "—"}</td><td>{r.type === "credit" ? "كريدي" : r.type === "free" ? "مجاني" : "—"}</td><td><Money m={r.total} /></td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2 className="h2 mb-3">المسؤول الافتراضي</h2>
          <form action={defaultWorkersAction} className="space-y-2 mb-5">
            <Back value="/admin/shifts" />
            <label className="block"><span className="lbl">الصباحية</span><input className="inp" name="morning" defaultValue={s.default_worker_morning} /></label>
            <label className="block"><span className="lbl">المسائية</span><input className="inp" name="evening" defaultValue={s.default_worker_evening} /></label>
            <button className="btn">حفظ</button>
          </form>
          <h2 className="h2 mb-2">جدول المسؤولين</h2>
          <div className="space-y-2">
            {roster.map((r) => (
              <form key={r.d} action={rosterAction} className="flex gap-1 items-center text-sm">
                <Back value="/admin/shifts" /><input type="hidden" name="day" value={r.d} />
                <span className={`num w-24 ${r.d === cur.businessDay ? "font-bold" : ""}`}>{r.d}</span>
                <input className="inp" name="morning" defaultValue={r.m === "—" ? "" : r.m} placeholder="صباحية" />
                <input className="inp" name="evening" defaultValue={r.e === "—" ? "" : r.e} placeholder="مسائية" />
                <button className="btn btn-ghost btn-sm">✓</button>
              </form>
            ))}
          </div>
        </section>

        <section className="card xl:col-span-3 overflow-x-auto">
          <h2 className="h2 mb-2">آخر 14 يوماً</h2>
          <table className="tbl">
            <thead><tr><th>اليوم</th><th>الشيفت</th><th>المسؤول</th><th>طلبات</th><th>كاش</th><th>تذاكر</th><th>ملغاة</th><th>مراجعة</th><th>على العامل</th><th>هامش مستعمل (متوسط/أقصى)</th><th>فرق الكاش</th><th>تذاكر مطابقة</th><th>النقاط</th><th>الحالة</th></tr></thead>
            <tbody>
              {rows.slice().reverse().map((r) => (
                <tr key={r.businessDay + r.shift}>
                  <td className="num">{r.businessDay}</td><td>{SHIFT_AR[r.shift]}</td><td>{r.worker}</td><td className="num">{r.orders}</td>
                  <td><Money m={r.salesCash} /></td><td className="num">{r.ticketOrders}</td><td className="num">{r.voids}</td><td className="num">{r.pending}</td><td>{r.unpaid ? <span className="badge badge-red"><Money m={r.owedByWorker} /> ({r.unpaid})</span> : <span className="num">—</span>}</td>
                  <td className="num">{r.marginUsedAvg ?? "—"}{r.marginUsedMax !== null ? ` / ${r.marginUsedMax}` : ""}</td>
                  <td>{r.cashVariance === null ? <span className="muted">—</span> : <Money m={r.cashVariance} />}</td>
                  <td>{r.ticketMismatch === null ? "—" : r.ticketMismatch ? <span className="badge badge-red">لا</span> : <span className="badge badge-green">نعم</span>}</td>
                  <td className="num">{r.risk}</td><td><RiskDot color={r.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="font-bold mt-4 mb-1">سجل عدّ الكاش</h3>
          <table className="tbl">
            <thead><tr><th>الوقت</th><th>الشيفت</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th><th>تذاكر (متوقع/في الدرج)</th><th>من عدّ</th></tr></thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.id}><td className="num">{formatTunis(c.ts)}</td><td>{c.businessDay} {SHIFT_AR[c.shift as Shift]}</td><td><Money m={c.expectedCashMillimes} /></td><td><Money m={c.countedCashMillimes} /></td><td><Money m={c.varianceMillimes} /></td><td className="num">{c.ticketsExpected} / {c.ticketsInDrawer}</td><td>{c.countedBy}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
