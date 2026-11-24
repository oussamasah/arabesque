import Link from "next/link";
import { getDb } from "@/db";
import { weekReport } from "@/server/wages";
import {
  addWorkerAction, advanceAction, attendanceAction, cancelAdvanceAction, cancelPaymentAction, payWageAction, updateWorkerAction,
} from "@/admin/actions/main";
import { Back, CancelForm, Flash, Money, PageTitle, one, type SP } from "@/admin/ui";
import { millimesToInput } from "@/lib/money";
import { addDays, formatTunis, toTunisLocalInput, weekStart } from "@/lib/time";

export const dynamic = "force-dynamic";

const DOW = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const dow = (day: string) => DOW[new Date(`${day}T00:00:00Z`).getUTCDay()];

export default async function WagesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const probe = await weekReport(db, weekStart("2000-01-03"));
  const today = probe.today;
  const ws = weekStart(one(sp.week) || today);
  const { rows, advancesList, paymentsList } = await weekReport(db, ws);
  const we = addDays(ws, 6);
  const payday = addDays(ws, 7);
  const back = `/admin/wages?week=${ws}`;
  const totalRemaining = rows.reduce((a, r) => a + Math.max(r.remaining, 0), 0);
  const totalEarned = rows.reduce((a, r) => a + r.earned, 0);
  const totalAdv = rows.reduce((a, r) => a + r.advances, 0);
  const totalPaid = rows.reduce((a, r) => a + r.paid, 0);
  const nameOf = (id: number) => rows.find((r) => r.worker.id === id)?.worker.nameAr ?? "";
  const due = today >= payday && totalRemaining > 0;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="أجور العمال" sub="الأجر يُحسب يومياً ويُدفع كل اثنين عن الأسبوع الماضي (من الاثنين إلى الأحد). التسبقة تُخصم من الأسبوع، وما لم يُدفع يُرحَّل للأسبوع التالي.">
        <Link className="btn btn-ghost" href={`/admin/wages?week=${addDays(ws, -7)}`}>← الأسبوع السابق</Link>
        <Link className="btn btn-ghost" href="/admin/wages">هذا الأسبوع</Link>
        <Link className="btn btn-ghost" href={`/admin/wages?week=${addDays(ws, 7)}`}>الأسبوع التالي →</Link>
      </PageTitle>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="card text-center"><div className="muted text-sm">الأسبوع</div><div className="font-bold num" dir="ltr">{ws} → {we}</div><div className="muted text-xs">يوم الخلاص: الاثنين {payday}</div></div>
        <div className="card text-center"><div className="muted text-sm">أجور الأسبوع</div><div className="text-2xl font-black"><Money m={totalEarned} /></div></div>
        <div className="card text-center"><div className="muted text-sm">تسبقات ومدفوع</div><div className="text-2xl font-black"><Money m={totalAdv + totalPaid} /></div></div>
        <div className={`card text-center ${due ? "border-2 border-red-500" : ""}`}><div className="muted text-sm">المطلوب للخلاص (المتبقي)</div><div className="text-3xl font-black"><Money m={totalRemaining} /></div>{due && <div className="text-red-700 text-xs font-bold">حان موعد الخلاص</div>}</div>
      </div>

      <section className="card mb-4 overflow-x-auto">
        <h2 className="h2 mb-2">حساب كل عامل</h2>
        <table className="tbl">
          <thead><tr><th>العامل</th><th>الأجر اليومي</th><th>مرحّل من قبل</th><th>أجر الأسبوع</th><th>تسبقات</th><th>مدفوع</th><th>المتبقي</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="muted text-center">لا عمال بعد — أضفهم من الأسفل</td></tr>}
            {rows.map((r) => (
              <tr key={r.worker.id}>
                <td className="font-semibold">{r.worker.nameAr}{r.worker.endDay ? <span className="badge badge-gray mr-1">توقف {r.worker.endDay}</span> : null}</td>
                <td><Money m={r.worker.dailyWageMillimes} /></td>
                <td>{r.carry ? <Money m={r.carry} /> : "—"}</td>
                <td><Money m={r.earned} /></td>
                <td>{r.advances ? <Money m={r.advances} /> : "—"}</td>
                <td>{r.paid ? <Money m={r.paid} /> : "—"}</td>
                <td className="font-black"><Money m={r.remaining} />{r.remaining > 0 && today >= payday && <span className="badge badge-yellow mr-1">مؤجَّل / مستحق</span>}</td>
                <td className="space-y-1">
                  <details>
                    <summary className="btn btn-ghost btn-sm list-none cursor-pointer">💵 دفع</summary>
                    <form action={payWageAction} className="flex flex-wrap gap-1 mt-1 items-end">
                      <Back value={back} /><input type="hidden" name="workerId" value={r.worker.id} /><input type="hidden" name="week" value={ws} />
                      <label><span className="lbl">المبلغ</span><input className="inp w-28" name="amount" inputMode="decimal" dir="ltr" defaultValue={r.remaining > 0 ? millimesToInput(r.remaining) : ""} required /></label>
                      <label><span className="lbl">ملاحظة</span><input className="inp w-32" name="note" /></label>
                      <button className="btn btn-sm">تسجيل الدفع</button>
                    </form>
                    <p className="muted text-xs">ادفع أقل من المتبقي لتأجيل الباقي؛ يظهر مرحَّلاً في الأسبوع التالي.</p>
                  </details>
                  <details>
                    <summary className="btn btn-ghost btn-sm list-none cursor-pointer">➕ تسبقة</summary>
                    <form action={advanceAction} className="flex flex-wrap gap-1 mt-1 items-end">
                      <Back value={back} /><input type="hidden" name="workerId" value={r.worker.id} />
                      <label><span className="lbl">المبلغ</span><input className="inp w-28" name="amount" inputMode="decimal" dir="ltr" required /></label>
                      <label><span className="lbl">الوقت</span><input className="inp" type="datetime-local" name="ts" defaultValue={toTunisLocalInput(new Date())} /></label>
                      <label><span className="lbl">ملاحظة</span><input className="inp w-32" name="note" /></label>
                      <button className="btn btn-sm">تسجيل التسبقة</button>
                    </form>
                  </details>
                </td>
              </tr>
            ))}
            {rows.length > 0 && (
              <tr className="font-bold"><td>المجموع</td><td></td><td></td><td><Money m={totalEarned} /></td><td><Money m={totalAdv} /></td><td><Money m={totalPaid} /></td><td><Money m={totalRemaining} /></td><td></td></tr>
            )}
          </tbody>
        </table>
        <p className="muted text-xs mt-2">المتبقي = المرحّل + أجر الأسبوع − التسبقات − المدفوع. الأيام غير المسجَّلة تُحسب حضوراً كاملاً: سجّل الغياب أو نصف اليوم أدناه.</p>
      </section>

      <section className="card mb-4 overflow-x-auto">
        <h2 className="h2 mb-2">الحضور (غياب / نصف يوم)</h2>
        <form action={attendanceAction}>
          <Back value={back} />
          <table className="tbl">
            <thead><tr><th>العامل</th>{rows[0]?.days.map((d) => <th key={d.day}>{dow(d.day)}<div className="muted text-xs num" dir="ltr">{d.day.slice(5)}</div></th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.worker.id}>
                  <td className="font-semibold">{r.worker.nameAr}</td>
                  {r.days.map((d) => (
                    <td key={d.day}>
                      <select className="inp" name={`att_${r.worker.id}_${d.day}`} defaultValue={String(d.halves)} disabled={!d.counted && d.day > today}>
                        <option value="2">حضر</option><option value="1">نصف يوم</option><option value="0">غائب</option>
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn mt-3">حفظ الحضور</button>
        </form>
      </section>

      <div className="grid md:grid-cols-2 gap-4 mb-4">
        <section className="card overflow-x-auto">
          <h2 className="h2 mb-2">تسبقات الأسبوع</h2>
          <table className="tbl"><thead><tr><th>الوقت</th><th>العامل</th><th>المبلغ</th><th>ملاحظة</th><th></th></tr></thead><tbody>
            {advancesList.length === 0 && <tr><td colSpan={5} className="muted text-center">لا توجد</td></tr>}
            {advancesList.map((a) => (
              <tr key={a.id} className={a.cancelledAt ? "opacity-50" : ""}>
                <td className="num">{formatTunis(a.ts)}</td><td>{nameOf(a.workerId)}</td><td><Money m={a.amountMillimes} /></td><td className="text-xs">{a.note}</td>
                <td>{a.cancelledAt ? <span className="badge badge-gray">ملغاة</span> : <CancelForm action={cancelAdvanceAction} back={back} id={a.id} withReason={false} />}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
        <section className="card overflow-x-auto">
          <h2 className="h2 mb-2">دفعات الخلاص لهذا الأسبوع</h2>
          <table className="tbl"><thead><tr><th>وقت الدفع</th><th>العامل</th><th>المبلغ</th><th>ملاحظة</th><th></th></tr></thead><tbody>
            {paymentsList.length === 0 && <tr><td colSpan={5} className="muted text-center">لم يُدفع شيء بعد</td></tr>}
            {paymentsList.map((p) => (
              <tr key={p.id} className={p.cancelledAt ? "opacity-50" : ""}>
                <td className="num">{formatTunis(p.ts)}</td><td>{nameOf(p.workerId)}</td><td><Money m={p.amountMillimes} /></td><td className="text-xs">{p.note}</td>
                <td>{p.cancelledAt ? <span className="badge badge-gray">ملغاة</span> : <CancelForm action={cancelPaymentAction} back={back} id={p.id} withReason={false} />}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
      </div>

      <section className="card">
        <h2 className="h2 mb-2">العمال</h2>
        <div className="space-y-2">
          {rows.map((r) => (
            <form key={r.worker.id} action={updateWorkerAction} className="flex flex-wrap gap-2 items-end">
              <Back value={back} /><input type="hidden" name="id" value={r.worker.id} />
              <label><span className="lbl">الاسم</span><input className="inp" name="nameAr" defaultValue={r.worker.nameAr} /></label>
              <label><span className="lbl">الأجر اليومي (DT)</span><input className="inp w-28" name="wage" inputMode="decimal" dir="ltr" defaultValue={millimesToInput(r.worker.dailyWageMillimes)} /></label>
              <label><span className="lbl">آخر يوم عمل (للتوقف)</span><input className="inp" type="date" name="endDay" defaultValue={r.worker.endDay ?? ""} /></label>
              <button className="btn btn-ghost btn-sm">حفظ</button>
            </form>
          ))}
        </div>
        <p className="muted text-xs mt-1">تغيير الأجر يسري من اليوم، ولا يغيّر أجور الأيام الماضية.</p>
        <form action={addWorkerAction} className="flex flex-wrap gap-2 items-end mt-4 border-t pt-3">
          <Back value={back} />
          <label><span className="lbl">عامل جديد</span><input className="inp" name="nameAr" required /></label>
          <label><span className="lbl">الأجر اليومي (DT)</span><input className="inp w-28" name="wage" inputMode="decimal" dir="ltr" required /></label>
          <label><span className="lbl">يبدأ من</span><input className="inp" type="date" name="startDay" defaultValue={today} /></label>
          <button className="btn">إضافة</button>
        </form>
      </section>
    </>
  );
}
