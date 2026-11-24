import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { expenses, stockItems, stockMovements } from "@/db/schema";
import { editPurchaseAction } from "@/admin/actions/main";
import { cancelledMovementIds } from "@/server/corrections";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { millimesToInput } from "@/lib/money";
import { toTunisLocalInput } from "@/lib/time";
import { basePerBig, bigUnitLabel, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

/** Edit a recorded purchase: the old one is cancelled (reversing movement, audited) and a corrected one is recorded. */
export default async function EditPurchase({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [m] = await db.select().from(stockMovements).where(eq(stockMovements.id, Number(id)));
  if (!m || m.type !== "purchase" || m.refType === "opening") notFound();
  if ((await cancelledMovementIds(db, [m.id])).size) notFound();
  const [it] = await db.select().from(stockItems).where(eq(stockItems.id, m.stockItemId));
  const [e] = await db.select().from(expenses).where(and(eq(expenses.purchaseRef, m.id), eq(expenses.isPurchase, true)));
  const kind = it.kind as StockKind;
  const qty = String(m.deltaBase / basePerBig(kind));
  const back = "/admin/stock/purchase";
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={`✏️ تعديل شراء: ${it.nameAr}`} sub="يُلغى الشراء القديم ويُسجَّل الجديد مكانه، ويبقى كل ذلك في سجل التدقيق.">
        <Link href={back} className="btn btn-ghost">← تسجيل شراء</Link>
      </PageTitle>
      <form action={editPurchaseAction} className="card max-w-xl space-y-3">
        <Back value={back} /><input type="hidden" name="id" value={m.id} />
        <label className="block"><span className="lbl">الكمية ({bigUnitLabel(kind)})</span><input className="inp" name="qty" inputMode="decimal" dir="ltr" defaultValue={qty} required /></label>
        <label className="block"><span className="lbl">المبلغ (DT)</span><input className="inp" name="total" inputMode="decimal" dir="ltr" defaultValue={millimesToInput(e?.amountMillimes ?? 0)} required /></label>
        <label className="block"><span className="lbl">وقت الاستلام</span><input className="inp" type="datetime-local" name="ts" defaultValue={toTunisLocalInput(m.ts)} /></label>
        <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" defaultValue={m.note ?? ""} /></label>
        <div className="group rounded-xl border p-3">
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" name="fromDrawer" className="w-5 h-5" defaultChecked={e?.paidFrom === "drawer"} /> دُفع من درج الشيفت</label>
          <label className="block mt-2"><span className="lbl">رقم الفاتورة (مطلوب عند الدفع من الدرج)</span><input name="invoiceRef" className="inp" dir="ltr" defaultValue={e?.invoiceRef ?? ""} /></label>
        </div>
        <button className="btn w-full">حفظ التعديل</button>
      </form>
    </>
  );
}
