import Link from "next/link";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { customers, tickets, ticketSheets } from "@/db/schema";
import { issueSheetAction, voidTicketAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, one, type SP } from "@/admin/ui";
import { formatTunis } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function TicketsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const custs = await db.select().from(customers).where(eq(customers.active, true)).orderBy(asc(customers.name));
  const sheets = await db.select({
    id: ticketSheets.id, customer: customers.name, customerId: customers.id, type: ticketSheets.type, count: ticketSheets.ticketCount,
    cap: ticketSheets.maxAmountMillimes, issuedAt: ticketSheets.issuedAt,
    left: sql<string>`(select count(*) from ${tickets} t where t.sheet_id = ${ticketSheets.id} and t.status = 'issued')`,
  }).from(ticketSheets).innerJoin(customers, eq(customers.id, ticketSheets.customerId)).where(isNull(ticketSheets.deletedAt)).orderBy(desc(ticketSheets.issuedAt)).limit(100);
  const code = one(sp.code)?.toUpperCase();
  const found = code ? await db.select().from(tickets).where(eq(tickets.shortCode, code)) : [];
  const printed = one(sp.printed);
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="التذاكر (مجاني / كريدي)" sub="ورقة لكل زبون فيها عدة تذاكر. كل تذكرة = طلب واحد، مرة واحدة، بدون تاريخ انتهاء. عند نفادها يدفع الزبون كاش.">
        <Link className="btn btn-ghost" href="/admin/shifts">مطابقة أوراق التذاكر بالشيفت</Link>
      </PageTitle>
      {printed && (
        <div className="card mb-4 bg-green-50 border-green-200 flex flex-wrap items-center gap-3">
          <span className="font-bold">الورقة جاهزة للطباعة.</span>
          <Link className="btn" href={`/admin/print/sheet/${printed}`} target="_blank">🖨️ طباعة الورقة</Link>
        </div>
      )}
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">إصدار ورقة تذاكر</h2>
          {custs.length === 0 ? <p className="muted">أضف زبوناً أولاً من <Link className="underline" href="/admin/customers">الكريدي والزبائن</Link>.</p> : (
            <form action={issueSheetAction} className="space-y-2">
              <Back value="/admin/tickets" />
              <label className="block"><span className="lbl">الزبون</span>
                <select className="inp" name="customerId" required>{custs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label className="block"><span className="lbl">النوع</span>
                <select className="inp" name="type"><option value="credit">كريدي (دين على الزبون)</option><option value="free">مجاني</option></select></label>
              <label className="block"><span className="lbl">عدد التذاكر في الورقة</span><input className="inp" name="count" type="number" min={1} max={200} defaultValue={30} required /></label>
              <label className="block"><span className="lbl">سقف لكل تذكرة (DT، اختياري)</span><input className="inp" name="cap" inputMode="decimal" dir="ltr" /></label>
              <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
              <button className="btn w-full">إصدار وطباعة</button>
            </form>
          )}
        </section>

        <section className="card lg:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">الأوراق المُصدرة</h2>
          <table className="tbl">
            <thead><tr><th>#</th><th>الزبون</th><th>النوع</th><th>تذاكر</th><th>متبقية</th><th>السقف</th><th>تاريخ الإصدار</th><th></th></tr></thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.id}>
                  <td className="num">{s.id}</td><td><Link className="underline" href={`/admin/customers/${s.customerId}`}>{s.customer}</Link></td>
                  <td>{s.type === "credit" ? <span className="badge badge-blue">كريدي</span> : <span className="badge badge-gray">مجاني</span>}</td>
                  <td className="num">{s.count}</td><td className="num">{Number(s.left) <= 5 ? <span className="badge badge-yellow">{s.left}</span> : s.left}</td>
                  <td>{s.cap ? <Money m={s.cap} /> : "—"}</td><td className="num">{formatTunis(s.issuedAt)}</td>
                  <td className="whitespace-nowrap"><Link className="btn btn-ghost btn-sm" href={`/admin/print/sheet/${s.id}`} target="_blank">طباعة</Link> <Link className="btn btn-ghost btn-sm" href={`/admin/tickets/${s.id}`}>تعديل / حذف</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card lg:col-span-3">
          <h2 className="h2 mb-2">البحث عن تذكرة بالرمز</h2>
          <form className="flex gap-2 mb-3" action="/admin/tickets">
            <input className="inp w-48" name="code" defaultValue={code ?? ""} dir="ltr" placeholder="ABCD1234" />
            <button className="btn">بحث</button>
          </form>
          {code && found.length === 0 && <p className="muted">لا توجد تذكرة بهذا الرمز.</p>}
          {found.map((t) => (
            <div key={t.id} className="flex flex-wrap gap-4 items-center">
              <span className="font-mono" dir="ltr">{t.shortCode}</span><span>{t.customerName}</span>
              <span className="badge">{t.type === "credit" ? "كريدي" : "مجاني"}</span>
              <span className={`badge ${t.status === "issued" ? "badge-green" : t.status === "used" ? "badge-blue" : "badge-gray"}`}>{t.status === "issued" ? "صالحة" : t.status === "used" ? "مستعملة" : "ملغاة"}</span>
              {t.usedOrderId && <Link className="underline" href={`/admin/orders/${t.usedOrderId}`}>الطلب</Link>}
              {t.status === "issued" && (
                <form action={voidTicketAction} className="flex gap-2">
                  <Back value={`/admin/tickets?code=${t.shortCode}`} /><input type="hidden" name="ticketId" value={t.id} />
                  <input className="inp w-48" name="reason" placeholder="سبب الإلغاء" required />
                  <button className="btn btn-danger btn-sm">إلغاء التذكرة</button>
                </form>
              )}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
