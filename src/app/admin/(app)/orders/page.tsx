import Link from "next/link";
import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { orders } from "@/db/schema";
import { orderLinesFor } from "@/server/finance";
import { getSettings } from "@/server/settings";
import { Back, FLAG_AR, Flash, Money, PageTitle, Pager, PaymentBadge, STATUS_AR, one, type SP } from "@/admin/ui";
import { deleteOrdersAction } from "@/admin/actions/main";
import { SelectAll } from "@/admin/SelectAll";
import { formatTunis, shiftInfo, SHIFT_AR, type Shift } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const day = one(sp.day) ?? shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const shift = one(sp.shift) ?? "";
  // deleted (cancelled) orders are hidden unless asked for
  const status = one(sp.status) ?? "active";
  const flag = one(sp.flag) ?? "";
  const pay = one(sp.pay) ?? "";
  const page = Math.max(1, Number(one(sp.page) ?? 1));
  const conds: SQL[] = [];
  if (day !== "all") conds.push(eq(orders.businessDay, day));
  if (shift) conds.push(eq(orders.shift, shift));
  if (status === "active") conds.push(ne(orders.status, "void"));
  else if (status && status !== "all") conds.push(eq(orders.status, status));
  if (flag) conds.push(sql`${flag} = any(${orders.flags})`);
  if (pay) conds.push(eq(orders.paymentType, pay));
  const rows = await db.select().from(orders).where(conds.length ? and(...conds) : undefined).orderBy(desc(orders.effectiveTs)).limit(101).offset((page - 1) * 100);
  const lines = await orderLinesFor(db, rows.slice(0, 100).map((r) => r.id));
  const base = `/admin/orders?day=${day}&shift=${shift}&status=${status}&flag=${flag}&pay=${pay}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الطلبات" sub="أوقات الطلبات بتوقيت تونس — للرجوع إلى نفس الدقيقة في تسجيل الكاميرا.">
        <Link href="/admin/orders/new" className="btn">+ طلب يدوي</Link>
      </PageTitle>
      <form className="card flex flex-wrap gap-2 items-end mb-4" action="/admin/orders">
        <label><span className="lbl">يوم العمل</span><input className="inp" type="date" name="day" defaultValue={day === "all" ? "" : day} /></label>
        <label><span className="lbl">الشيفت</span><select className="inp" name="shift" defaultValue={shift}><option value="">الكل</option><option value="morning">صباحية</option><option value="evening">مسائية</option></select></label>
        <label><span className="lbl">الحالة</span><select className="inp" name="status" defaultValue={status}><option value="active">الطلبات (بدون المحذوفة)</option><option value="ok">مقبول</option><option value="pending_review">يحتاج مراجعة</option><option value="void">المحذوفة</option><option value="all">الكل</option></select></label>
        <label><span className="lbl">علامة</span><select className="inp" name="flag" defaultValue={flag}><option value="">—</option>{Object.entries(FLAG_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span className="lbl">الدفع</span><select className="inp" name="pay" defaultValue={pay}><option value="">الكل</option><option value="cash">كاش</option><option value="ticket">تذكرة</option><option value="pending">غير مدفوع</option><option value="loss">خرج دون دفع</option></select></label>
        <button className="btn">تصفية</button>
        <Link className="btn btn-ghost" href="/admin/orders?day=all&pay=pending">كل غير المدفوعة</Link>
        <Link className="btn btn-ghost" href="/admin/orders?day=all&status=pending_review">كل ما يحتاج مراجعة</Link>
      </form>
      {status !== "void" && (
        <form id="bulk" action={deleteOrdersAction} className="card mb-3 flex flex-wrap items-center gap-2 bg-red-50 border-red-100">
          <Back value={base} />
          <span className="text-sm">حذف الطلبات المحددة:</span>
          <input name="reason" className="inp w-56 py-1" placeholder="السبب (اختياري)" />
          <button className="btn btn-danger btn-sm">حذف المحدد</button>
          <span className="muted text-xs">يُرجع المخزون، يعيد التذكرة، ويعكس الدين. الطلب المحذوف يبقى في «المحذوفة» وسجل التدقيق.</span>
        </form>
      )}
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead><tr>{status !== "void" && <th><SelectAll form="bulk" name="ids" /></th>}<th>الطلب</th><th>الوقت (تونس)</th><th>الشيفت</th><th>المنتجات</th><th>الدفع</th><th>المبلغ</th><th>التكلفة</th><th>الحالة</th><th>علامات</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} className="muted text-center">لا توجد طلبات</td></tr>}
            {rows.slice(0, 100).map((o) => (
              <tr key={o.id} className={o.status === "void" ? "opacity-50" : ""}>
                {status !== "void" && <td>{o.status !== "void" && <input type="checkbox" form="bulk" name="ids" value={o.id} className="w-4 h-4" aria-label="تحديد" />}</td>}
                <td><Link className="underline num" href={`/admin/orders/${o.id}`}>{o.orderLabel}</Link></td>
                <td className="num">{formatTunis(o.effectiveTs, true)}</td>
                <td className="text-xs">{o.businessDay} {SHIFT_AR[o.shift as Shift]}</td>
                <td className="text-xs">{lines.filter((l) => l.orderId === o.id).map((l) => `${l.name} ×${l.qty}`).join("، ")}</td>
                <td><PaymentBadge type={o.paymentType} />{o.tableRef && <div className="text-xs muted">{o.tableRef}</div>}</td>
                <td><Money m={o.totalMillimes} /></td><td><Money m={o.costMillimes} /></td>
                <td><span className={`badge ${o.status === "ok" ? "badge-green" : o.status === "void" ? "badge-gray" : "badge-yellow"}`} title={o.voidReason ?? ""}>{o.status === "void" ? "محذوف" : STATUS_AR[o.status]}</span></td>
                <td className="text-xs">{o.flags.map((f) => <span key={f} className="badge badge-yellow ml-1">{FLAG_AR[f] ?? f}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} hasMore={rows.length > 100} base={base} />
      </div>
    </>
  );
}
