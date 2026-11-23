import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { customers, orders, tickets, ticketSheets } from "@/db/schema";
import { deleteSheetAction, updateSheetAction, updateTicketNoteAction, voidTicketAction } from "@/admin/actions/main";
import { Back, CancelForm, Flash, PageTitle, type SP } from "@/admin/ui";
import { millimesToInput } from "@/lib/money";
import { formatTunis } from "@/lib/time";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { text: string; cls: string }> = {
  issued: { text: "صالحة", cls: "badge-green" }, used: { text: "مستعملة", cls: "badge-blue" }, void: { text: "ملغاة", cls: "badge-gray" },
};

export default async function SheetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [sheet] = await db.select().from(ticketSheets).where(eq(ticketSheets.id, Number(id)));
  if (!sheet || sheet.deletedAt) notFound();
  const [cust] = await db.select().from(customers).where(eq(customers.id, sheet.customerId));
  const rows = await db.select({ t: tickets, label: orders.orderLabel }).from(tickets).leftJoin(orders, eq(orders.id, tickets.usedOrderId))
    .where(eq(tickets.sheetId, sheet.id)).orderBy(asc(tickets.shortCode));
  const left = rows.filter((r) => r.t.status === "issued").length;
  const back = `/admin/tickets/${sheet.id}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={`ورقة التذاكر #${sheet.id}`} sub={`${cust?.name ?? ""} — ${rows.length} تذكرة، متبقية ${left}`}>
        <Link className="btn btn-ghost" href="/admin/tickets">← التذاكر</Link>
        <Link className="btn" href={`/admin/print/sheet/${sheet.id}`} target="_blank">🖨️ طباعة</Link>
      </PageTitle>
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card space-y-3">
          <h2 className="h2">تعديل الورقة</h2>
          <form action={updateSheetAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="sheetId" value={sheet.id} />
            <label className="block"><span className="lbl">النوع</span>
              <select className="inp" name="type" defaultValue={sheet.type}><option value="credit">كريدي (دين على الزبون)</option><option value="free">مجاني</option></select></label>
            <label className="block"><span className="lbl">عدد التذاكر في الورقة (المستعملة لا تُحذف)</span><input className="inp" name="count" type="number" min={1} max={200} defaultValue={rows.filter((r) => r.t.status !== "void").length} required /></label>
            <label className="block"><span className="lbl">سقف لكل تذكرة (DT، اختياري)</span><input className="inp" name="cap" inputMode="decimal" dir="ltr" defaultValue={millimesToInput(sheet.maxAmountMillimes)} /></label>
            <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" defaultValue={sheet.note ?? ""} /></label>
            <button className="btn w-full">حفظ</button>
            <p className="muted text-xs">النوع والسقف والملاحظة تسري على التذاكر الصالحة فقط. زيادة العدد تضيف تذاكر جديدة (اطبع الورقة من جديد)، وتقليله يلغي تذاكر صالحة غير مستعملة.</p>
          </form>
          <div className="border-t pt-3">
            <CancelForm action={deleteSheetAction} back={back} id={sheet.id} idName="sheetId" label="حذف الورقة" confirm="تأكيد الحذف" withReason={false} />
            <p className="muted text-xs mt-1">تُلغى كل تذاكرها غير المستعملة فلا يقبلها التابلت. التذاكر المستعملة وطلباتها تبقى في السجل.</p>
          </div>
        </section>
        <section className="card lg:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">التذاكر</h2>
          <table className="tbl">
            <thead><tr><th>الرمز</th><th>الحالة</th><th>الطلب</th><th>ملاحظة</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ t, label }) => {
                const st = STATUS[t.status] ?? STATUS.void;
                return (
                  <tr key={t.id}>
                    <td className="font-mono" dir="ltr">{t.shortCode}</td>
                    <td><span className={`badge ${st.cls}`}>{st.text}</span>{t.usedAt && <span className="muted text-xs num mr-1">{formatTunis(t.usedAt)}</span>}</td>
                    <td>{t.usedOrderId ? <Link className="underline num" href={`/admin/orders/${t.usedOrderId}`}>{label ?? "الطلب"}</Link> : "—"}</td>
                    <td>
                      <form action={updateTicketNoteAction} className="flex gap-1">
                        <Back value={back} /><input type="hidden" name="ticketId" value={t.id} />
                        <input className="inp py-1 text-sm w-40" name="note" defaultValue={t.note ?? ""} />
                        <button className="btn btn-ghost btn-sm">حفظ</button>
                      </form>
                    </td>
                    <td>{t.status === "issued" && <CancelForm action={voidTicketAction} back={back} id={t.id} idName="ticketId" label="حذف التذكرة" confirm="تأكيد" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">لإعادة تذكرة مستعملة، احذف الطلب الذي استعملها من صفحة الطلب فتعود صالحة.</p>
        </section>
      </div>
    </>
  );
}
