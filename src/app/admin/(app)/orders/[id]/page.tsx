import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, devices, orderItems, orders, tickets } from "@/db/schema";
import { listProducts, priceAt } from "@/server/catalog";
import { OrderItemsPicker } from "@/admin/OrderItemsPicker";
import { orderLinesFor, workerFor } from "@/server/finance";
import { adminPayAction, approveOrderAction, editOrderAction, unpaidLossAction, voidOrderAction } from "@/admin/actions/main";
import { Back, FLAG_AR, Flash, Money, PAYMENT_AR, PageTitle, STATUS_AR, type SP } from "@/admin/ui";
import { formatTunis, SHIFT_AR, toTunisLocalInput, type Shift } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) notFound();
  const lines = await orderLinesFor(db, [o.id]);
  const [t] = o.ticketId ? await db.select().from(tickets).where(eq(tickets.id, o.ticketId)) : [];
  const [d] = o.deviceId ? await db.select().from(devices).where(eq(devices.id, o.deviceId)) : [];
  const worker = await workerFor(db, o.businessDay, o.shift as Shift);
  const log = await db.select().from(auditLog).where(and(eq(auditLog.entity, "order"), eq(auditLog.entityId, o.id)));
  const back = `/admin/orders/${o.id}`;
  const qtyOf = new Map((await db.select().from(orderItems).where(eq(orderItems.orderId, o.id))).map((i) => [i.productId, i.qty]));
  const allProducts = await listProducts(db, true);
  const picker = await Promise.all(allProducts.map(async (p) => ({ id: p.id, name: p.nameAr, category: p.category, price: await priceAt(db, p.id, o.effectiveTs) })));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={`الطلب ${o.orderLabel}`} sub={`${o.businessDay} ${SHIFT_AR[o.shift as Shift]} — المسؤول: ${worker}`}>
        <Link className="btn btn-ghost" href={`/admin/orders?day=${o.businessDay}`}>← الطلبات</Link>
      </PageTitle>
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card lg:col-span-2">
          <table className="tbl mb-3">
            <thead><tr><th>المنتج</th><th>الكمية</th><th>سعر الوحدة (وقت البيع)</th><th>تكلفة الوحدة</th><th>المجموع</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}><td>{l.name}</td><td className="num">{l.qty}</td><td><Money m={l.price} /></td><td><Money m={l.cost} /></td><td><Money m={l.price * l.qty} /></td></tr>
              ))}
              <tr className="font-bold"><td colSpan={4}>المجموع</td><td><Money m={o.totalMillimes} /></td></tr>
            </tbody>
          </table>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div><dt className="muted">الحالة</dt><dd><span className={`badge ${o.status === "ok" ? "badge-green" : o.status === "void" ? "badge-gray" : "badge-yellow"}`}>{STATUS_AR[o.status]}</span></dd></div>
            <div><dt className="muted">الدفع</dt><dd>{o.paymentType === "ticket" ? `تذكرة ${t ? `${t.shortCode} — ${t.customerName} (${t.type === "credit" ? "كريدي" : "مجاني"})` : "غير معروفة"}` : PAYMENT_AR[o.paymentType] ?? o.paymentType}</dd></div>
            <div><dt className="muted">وقت الدفع (شيفت الكاش)</dt><dd className="num">{o.paidAt ? `${formatTunis(o.paidAt)} — ${o.paidBusinessDay} ${SHIFT_AR[o.paidShift as Shift]}` : "—"}</dd></div>
            {o.tableRef && <div><dt className="muted">الطاولة / الزبون</dt><dd>{o.tableRef}</dd></div>}
            <div><dt className="muted">الجهاز</dt><dd>{d?.name ?? "إدخال يدوي"}</dd></div>
            <div><dt className="muted">الوقت الفعلي (مصحَّح)</dt><dd className="num">{formatTunis(o.effectiveTs, true)}</dd></div>
            <div><dt className="muted">ساعة الجهاز</dt><dd className="num">{formatTunis(o.clientTs, true)}</dd></div>
            <div><dt className="muted">وصل للخادم</dt><dd className="num">{formatTunis(o.receivedAt, true)}</dd></div>
            <div><dt className="muted">التكلفة</dt><dd><Money m={o.costMillimes} /></dd></div>
            <div className="col-span-2"><dt className="muted">علامات</dt><dd>{o.flags.length ? o.flags.map((f) => <span key={f} className="badge badge-yellow ml-1">{FLAG_AR[f] ?? f}</span>) : "—"}</dd></div>
            {o.status === "void" && <div className="col-span-3"><dt className="muted">سبب الإلغاء</dt><dd>{o.voidReason} — {o.voidedBy} — <span className="num">{formatTunis(o.voidedAt)}</span></dd></div>}
            {o.reviewNote && <div className="col-span-3"><dt className="muted">ملاحظة المراجعة</dt><dd>{o.reviewNote}</dd></div>}
          </dl>
        </section>
        <section className="card space-y-5">
          {(o.paymentType === "pending" || o.paymentType === "loss") && o.status !== "void" && (
            <>
              <p className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm">هذا الطلب على مسؤولية عامل الشيفت ({worker}) حتى يُدفع.</p>
              <form action={adminPayAction} className="space-y-2">
                <h2 className="h2">تسجيل الدفع (كاش)</h2>
                <Back value={back} /><input type="hidden" name="orderId" value={o.id} />
                <label className="block"><span className="lbl">وقت الدفع</span><input className="inp" type="datetime-local" name="at" defaultValue={toTunisLocalInput(new Date())} /></label>
                <fieldset className="flex gap-4 text-sm">
                  <label className="flex gap-1 items-center"><input type="radio" name="paidTo" value="drawer" defaultChecked /> في درج الشيفت</label>
                  <label className="flex gap-1 items-center"><input type="radio" name="paidTo" value="owner" /> الزبون دفع للمالك</label>
                  <label className="flex gap-1 items-center"><input type="radio" name="paidTo" value="worker" defaultChecked={o.paymentType === "loss"} /> دفعه العامل</label>
                </fieldset>
                <button className="btn w-full">تسجيل الدفع</button>
              </form>
              {o.paymentType === "pending" && <form action={unpaidLossAction} className="space-y-2">
                <h2 className="h2">خرج دون دفع</h2>
                <p className="muted text-xs">المخزون يبقى منقوصاً (البضاعة قُدّمت). المبلغ يبقى على عامل الشيفت حتى يدفعه.</p>
                <Back value={back} /><input type="hidden" name="orderId" value={o.id} />
                <input className="inp" name="reason" placeholder="السبب (مطلوب)" required />
                <button className="btn btn-danger w-full">تسجيل كغير مدفوع</button>
              </form>}
            </>
          )}
          {o.status === "pending_review" && (
            <form action={approveOrderAction} className="space-y-2">
              <h2 className="h2">موافقة بعد المراجعة</h2>
              <Back value={back} /><input type="hidden" name="orderId" value={o.id} />
              <input className="inp" name="note" placeholder="ملاحظة" />
              <button className="btn w-full">موافقة</button>
            </form>
          )}
          {o.status !== "void" && o.paymentType !== "loss" && (
            <details open>
              <summary className="btn w-full cursor-pointer list-none text-center">✏️ تعديل المنتجات أو الكمية</summary>
              <form action={editOrderAction} className="space-y-2 mt-2">
                <Back value={back} /><input type="hidden" name="orderId" value={o.id} />
                <OrderItemsPicker products={picker} initial={Object.fromEntries(qtyOf)} />
                <p className="muted text-xs">يُلغى هذا الطلب ويُنشأ طلب مصحَّح بنفس الوقت ونفس طريقة الدفع (الاثنان يبقيان ظاهرين).</p>
                <button className="btn w-full">حفظ التعديل</button>
              </form>
            </details>
          )}
          {o.status !== "void" && (
            <form action={voidOrderAction} className="space-y-2">
              <h2 className="h2">حذف الطلب</h2>
              <p className="muted text-xs">يختفي من قائمة الطلبات ومن التابلت، يُرجع المخزون، يعيد التذكرة صالحة، ويعكس دين الكريدي. يبقى في «المحذوفة» وسجل التدقيق.</p>
              <Back value={back} /><input type="hidden" name="orderId" value={o.id} />
              <input className="inp" name="reason" placeholder="السبب (اختياري)" />
              <button className="btn btn-danger w-full">حذف الطلب</button>
            </form>
          )}
          <div>
            <h2 className="h2 mb-1">سجل التدقيق</h2>
            <ul className="text-xs space-y-1">{log.map((l) => <li key={l.id}><span className="num">{formatTunis(l.ts)}</span> — {l.action} — {l.actor}</li>)}</ul>
          </div>
        </section>
      </div>
    </>
  );
}
