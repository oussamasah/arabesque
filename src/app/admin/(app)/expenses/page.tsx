import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { expenses } from "@/db/schema";
import { getSettings } from "@/server/settings";
import { expenseAction, expenseDeactivateAction, expenseEndAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { formatTunis, shiftInfo, toTunisLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function ExpensesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const today = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const fixed = await db.select().from(expenses).where(eq(expenses.kind, "fixed")).orderBy(desc(expenses.startDay));
  const variable = await db.select().from(expenses).where(eq(expenses.kind, "variable")).orderBy(desc(expenses.startDay), desc(expenses.id)).limit(200);
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="المصاريف" sub="الثابتة (شهرية: أجور، كراء…) توزَّع يومياً حسب عدد أيام كل شهر. المتغيرة: المشتريات تُضاف تلقائياً من صفحة المخزون." />
      <div className="grid lg:grid-cols-2 gap-4 mb-5">
        <section className="card">
          <h2 className="h2 mb-3">مصروف ثابت شهري</h2>
          <form action={expenseAction} className="grid grid-cols-2 gap-2">
            <Back value="/admin/expenses" /><input type="hidden" name="kind" value="fixed" />
            <label><span className="lbl">الفئة</span><input className="inp" name="category" placeholder="أجور، كراء، كهرباء…" /></label>
            <label><span className="lbl">الوصف *</span><input className="inp" name="label" required /></label>
            <label><span className="lbl">المبلغ الشهري (DT)</span><input className="inp" name="amount" required inputMode="decimal" dir="ltr" /></label>
            <label><span className="lbl">من يوم</span><input className="inp" type="date" name="startDay" defaultValue={today.slice(0, 8) + "01"} required /></label>
            <label><span className="lbl">إلى يوم (اختياري)</span><input className="inp" type="date" name="endDay" /></label>
            <div className="col-span-2"><button className="btn">إضافة</button></div>
          </form>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">مصروف متغير (غير الشراء)</h2>
          <form action={expenseAction} className="grid grid-cols-2 gap-2">
            <Back value="/admin/expenses" /><input type="hidden" name="kind" value="variable" />
            <label><span className="lbl">الفئة</span><input className="inp" name="category" placeholder="صيانة، تنظيف…" /></label>
            <label><span className="lbl">الوصف *</span><input className="inp" name="label" required /></label>
            <label><span className="lbl">المبلغ (DT)</span><input className="inp" name="amount" required inputMode="decimal" dir="ltr" /></label>
            <label><span className="lbl">رقم الفاتورة</span><input className="inp" name="invoiceRef" dir="ltr" /></label>
            <fieldset className="col-span-2 flex gap-4 text-sm">
              <label className="flex gap-1 items-center"><input type="radio" name="paidFrom" value="owner" defaultChecked /> من مال المالك</label>
              <label className="flex gap-1 items-center"><input type="radio" name="paidFrom" value="drawer" /> من درج الشيفت (فاتورة مطلوبة)</label>
            </fieldset>
            <label><span className="lbl">وقت الدفع</span><input className="inp" type="datetime-local" name="paidAt" defaultValue={toTunisLocalInput(new Date())} /></label>
            <div className="col-span-2"><button className="btn">إضافة</button></div>
          </form>
        </section>
      </div>
      <section className="card overflow-x-auto mb-5">
        <h2 className="h2 mb-2">الثابتة</h2>
        <table className="tbl">
          <thead><tr><th>الفئة</th><th>الوصف</th><th>شهرياً</th><th>من</th><th>إلى</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {fixed.map((e) => (
              <tr key={e.id} className={!e.active ? "opacity-50" : ""}>
                <td>{e.category}</td><td>{e.label}</td><td><Money m={e.amountMillimes} /></td><td className="num">{e.startDay}</td><td className="num">{e.endDay ?? "—"}</td>
                <td>{e.active ? <span className="badge badge-green">نشط</span> : <span className="badge badge-gray">موقوف</span>}</td>
                <td className="flex gap-1">
                  {e.active && !e.endDay && (
                    <form action={expenseEndAction} className="flex gap-1"><Back value="/admin/expenses" /><input type="hidden" name="id" value={e.id} /><input className="inp w-36" type="date" name="endDay" defaultValue={today} /><button className="btn btn-ghost btn-sm">إنهاء</button></form>
                  )}
                  {e.active && <form action={expenseDeactivateAction}><Back value="/admin/expenses" /><input type="hidden" name="id" value={e.id} /><button className="btn btn-ghost btn-sm">إيقاف (خطأ)</button></form>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="h2 mb-2">المتغيرة (آخر 200)</h2>
        <table className="tbl">
          <thead><tr><th>اليوم</th><th>الفئة</th><th>الوصف</th><th>المبلغ</th><th>الدفع</th><th>وقت الدفع</th><th>فاتورة</th><th></th></tr></thead>
          <tbody>
            {variable.map((e) => (
              <tr key={e.id} className={!e.active ? "opacity-50 line-through" : ""}>
                <td className="num">{e.startDay}</td><td>{e.category}{e.isPurchase && <span className="badge badge-blue mr-1">شراء</span>}</td><td>{e.label}</td><td><Money m={e.amountMillimes} /></td>
                <td>{e.paidFrom === "drawer" ? <span className="badge badge-yellow">درج الشيفت</span> : "المالك"}</td><td className="num">{formatTunis(e.paidAt)}</td><td className="num">{e.invoiceRef ?? "—"}</td>
                <td>{e.active && !e.isPurchase && <form action={expenseDeactivateAction}><Back value="/admin/expenses" /><input type="hidden" name="id" value={e.id} /><button className="btn btn-ghost btn-sm">إيقاف (خطأ)</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
