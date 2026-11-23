import Link from "next/link";
import { getDb } from "@/db";
import { listProducts, priceAt } from "@/server/catalog";
import { OrderItemsPicker } from "@/admin/OrderItemsPicker";
import { manualOrderAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { toTunisLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function NewOrderPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const now = new Date();
  const prods = await listProducts(db, true);
  const picker = await Promise.all(prods.map(async (p) => ({ id: p.id, name: p.nameAr, category: p.category, price: await priceAt(db, p.id, now) })));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="طلب يدوي" sub="للتصحيح بعد إلغاء طلب خاطئ، أو عند تعطل التابلت. يُسجَّل باسمك في سجل التدقيق ويحمل علامة «يدوي».">
        <Link className="btn btn-ghost" href="/admin/orders">← الطلبات</Link>
      </PageTitle>
      <form action={manualOrderAction} className="card space-y-3 max-w-3xl">
        <Back value="/admin/orders/new" />
        <OrderItemsPicker products={picker} />
        <div className="grid md:grid-cols-3 gap-3">
          <label><span className="lbl">وقت الطلب الحقيقي</span><input className="inp" type="datetime-local" name="at" defaultValue={toTunisLocalInput(new Date())} /></label>
          <label><span className="lbl">الدفع</span><select className="inp" name="payment"><option value="cash">كاش</option><option value="ticket">تذكرة</option><option value="later">لاحقاً (غير مدفوع)</option></select></label>
          <label><span className="lbl">رمز التذكرة (إن كان بتذكرة)</span><input className="inp" name="ticketCode" dir="ltr" /></label>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="block"><span className="lbl">الطاولة / الزبون</span><input className="inp" name="tableRef" maxLength={20} /></label>
          <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
        </div>
        <button className="btn">تسجيل الطلب</button>
      </form>
    </>
  );
}
