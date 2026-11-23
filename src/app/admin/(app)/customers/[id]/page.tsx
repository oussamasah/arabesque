import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { creditLedger, customers, orders, ticketSheets } from "@/db/schema";
import { customerBalance, remainingTickets } from "@/server/tickets";
import { creditAdjustAction, deleteCustomerAction, repaymentAction, saveCustomerAction } from "@/admin/actions/main";
import { Back, CancelForm, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { formatTunis, toTunisLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

const TYPE_AR: Record<string, string> = { charge: "دين (طلب)", payment: "سداد", adjustment: "تعديل" };

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [c] = await db.select().from(customers).where(eq(customers.id, Number(id)));
  if (!c) notFound();
  const balance = await customerBalance(db, c.id);
  const left = await remainingTickets(db, c.id);
  const ledger = await db.select({ l: creditLedger, label: orders.orderLabel }).from(creditLedger).leftJoin(orders, eq(orders.id, creditLedger.orderId))
    .where(eq(creditLedger.customerId, c.id)).orderBy(desc(creditLedger.ts), desc(creditLedger.id)).limit(200);
  const sheets = await db.select().from(ticketSheets).where(and(eq(ticketSheets.customerId, c.id), isNull(ticketSheets.deletedAt))).orderBy(desc(ticketSheets.issuedAt));
  const back = `/admin/customers/${c.id}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={c.name} sub={`الرصيد: ${(balance / 1000).toFixed(3)} DT · تذاكر متبقية: ${left}`}>
        <Link className="btn btn-ghost" href="/admin/customers">← الزبائن</Link>
        <Link className="btn" href="/admin/tickets">إصدار ورقة تذاكر</Link>
      </PageTitle>
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">تسجيل سداد</h2>
          <form action={repaymentAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="customerId" value={c.id} />
            <label className="block"><span className="lbl">المبلغ (DT)</span><input className="inp" name="amount" required inputMode="decimal" dir="ltr" /></label>
            <label className="block"><span className="lbl">الوقت</span><input className="inp" type="datetime-local" name="ts" defaultValue={toTunisLocalInput(new Date())} /></label>
            <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
            <button className="btn w-full">تسجيل السداد</button>
          </form>
          <h2 className="h2 mt-5 mb-3">تعديل الرصيد</h2>
          <form action={creditAdjustAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="customerId" value={c.id} />
            <label className="block"><span className="lbl">المبلغ (+ يزيد الدين، − ينقصه)</span><input className="inp" name="amount" required dir="ltr" /></label>
            <label className="block"><span className="lbl">السبب</span><input className="inp" name="note" required /></label>
            <button className="btn btn-ghost w-full">تسجيل التعديل</button>
          </form>
        </section>
        <section className="card lg:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">كشف الحساب</h2>
          <table className="tbl">
            <thead><tr><th>الوقت</th><th>النوع</th><th>المبلغ</th><th>الطلب</th><th>ملاحظة</th></tr></thead>
            <tbody>
              {ledger.map(({ l, label }) => (
                <tr key={l.id}>
                  <td className="num">{formatTunis(l.ts)}</td><td>{TYPE_AR[l.type]}</td>
                  <td><Money m={l.type === "payment" ? -l.amountMillimes : l.amountMillimes} /></td>
                  <td>{l.orderId ? <Link className="underline num" href={`/admin/orders/${l.orderId}`}>{label}</Link> : "—"}</td>
                  <td className="text-xs">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">البيانات</h2>
          <form action={saveCustomerAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="id" value={c.id} />
            <label className="block"><span className="lbl">الاسم</span><input className="inp" name="name" defaultValue={c.name} required /></label>
            <label className="block"><span className="lbl">الهاتف</span><input className="inp" name="phone" defaultValue={c.phone ?? ""} dir="ltr" /></label>
            <label className="block"><span className="lbl">تنبيه عند بقاء (تذاكر)</span><input className="inp" name="lowTicketsThreshold" type="number" min={0} defaultValue={c.lowTicketsThreshold ?? ""} /></label>
            <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" defaultValue={c.note ?? ""} /></label>
            <label className="flex gap-2 items-center"><input type="checkbox" name="active" defaultChecked={c.active} /> نشط</label>
            <button className="btn">حفظ</button>
          </form>
          <div className="mt-4 border-t pt-3">
            <CancelForm action={deleteCustomerAction} back={back} id={c.id} label="حذف الزبون" confirm="تأكيد الحذف" withReason={false} />
            <p className="muted text-xs mt-1">ممكن فقط إن لم يكن عليه دين. تذاكره غير المستعملة تُلغى.</p>
          </div>
        </section>
        <section className="card lg:col-span-2">
          <h2 className="h2 mb-2">أوراق التذاكر</h2>
          <ul className="text-sm space-y-1">
            {sheets.map((s) => (
              <li key={s.id} className="flex gap-3 items-center"><span className="num">#{s.id}</span><span>{s.type === "credit" ? "كريدي" : "مجاني"}</span><span className="num">{s.ticketCount} تذكرة</span><span className="muted num">{formatTunis(s.issuedAt)}</span><Link className="underline" target="_blank" href={`/admin/print/sheet/${s.id}`}>طباعة</Link><Link className="underline" href={`/admin/tickets/${s.id}`}>تعديل / حذف</Link></li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
