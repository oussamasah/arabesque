import Link from "next/link";
import { getDb } from "@/db";
import { creditAging } from "@/server/finance";
import { getSettings } from "@/server/settings";
import { saveCustomerAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { shiftInfo } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const today = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const rows = await creditAging(db, today);
  const total = rows.reduce((a, r) => a + r.balance, 0);
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الكريدي والزبائن" sub={`مجموع الديون غير المسددة: ${(total / 1000).toFixed(3)} DT. السداد يذهب مباشرة للمالك ولا يدخل درج الشيفت.`} />
      <div className="card overflow-x-auto mb-5">
        <table className="tbl">
          <thead><tr><th>الزبون</th><th>الهاتف</th><th>الرصيد (دين)</th><th>أقدم دين غير مسدد</th><th>العمر (يوم)</th><th>تذاكر متبقية</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customerId} className={!r.active ? "opacity-50" : ""}>
                <td className="font-semibold">{r.name}</td><td className="num">{r.phone ?? "—"}</td>
                <td><Money m={r.balance} /></td><td className="num">{r.oldestUnpaidDay ?? "—"}</td>
                <td>{r.ageDays === null ? "—" : <span className={`badge ${r.ageDays > 30 ? "badge-red" : r.ageDays > 14 ? "badge-yellow" : "badge-gray"}`}>{r.ageDays}</span>}</td>
                <td>{r.remainingTickets <= s.low_tickets_threshold ? <span className="badge badge-yellow">{r.remainingTickets}</span> : <span className="num">{r.remainingTickets}</span>}</td>
                <td><Link className="btn btn-ghost btn-sm" href={`/admin/customers/${r.customerId}`}>الحساب</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="card max-w-xl">
        <h2 className="h2 mb-3">زبون جديد</h2>
        <form action={saveCustomerAction} className="grid grid-cols-2 gap-3">
          <Back value="/admin/customers" />
          <label><span className="lbl">الاسم *</span><input className="inp" name="name" required /></label>
          <label><span className="lbl">الهاتف</span><input className="inp" name="phone" dir="ltr" /></label>
          <label><span className="lbl">تنبيه عند بقاء (تذاكر)</span><input className="inp" name="lowTicketsThreshold" type="number" min={0} placeholder={String(s.low_tickets_threshold)} /></label>
          <label><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
          <div className="col-span-2"><button className="btn">إضافة</button></div>
        </form>
      </section>
    </>
  );
}
