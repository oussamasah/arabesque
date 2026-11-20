import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stockItems } from "@/db/schema";
import { purchaseInvoiceAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { bigUnitLabel, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

const ROWS = 6;

export default async function PurchasePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const items = await (await getDb()).select().from(stockItems).where(eq(stockItems.active, true)).orderBy(asc(stockItems.nameAr));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="📦 تسجيل شراء" sub="اكتب ما في الفاتورة: المادة، الكمية والمبلغ. عدّ البضاعة قبل التسجيل.">
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>
      <form action={purchaseInvoiceAction} className="card max-w-3xl space-y-4">
        <Back value="/admin/stock/purchase" />
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_8rem_8rem] gap-2 muted text-sm px-1">
            <span>المادة</span><span>الكمية</span><span>المبلغ (DT)</span>
          </div>
          {Array.from({ length: ROWS }, (_, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_8rem] gap-2">
              <select name={`item_${i}`} className="inp text-base" defaultValue="">
                <option value="">— اختر —</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.nameAr} ({bigUnitLabel(it.kind as StockKind)})</option>)}
              </select>
              <input name={`qty_${i}`} className="inp text-base" inputMode="decimal" dir="ltr" placeholder="مثال 5" />
              <input name={`total_${i}`} className="inp text-base" inputMode="decimal" dir="ltr" placeholder="مثال 40" />
            </div>
          ))}
          <p className="muted text-xs">الكمية بالكيلو للوزن، باللتر للسوائل، أو بالعدد للقطع (الوحدة بين قوسين).</p>
        </div>

        <div className="group rounded-xl border p-3">
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" name="fromDrawer" className="w-5 h-5" /> دُفع من درج الشيفت (كاش المقهى)
          </label>
          <div className="hidden group-has-[:checked]:block mt-2">
            <label className="block"><span className="lbl">رقم الفاتورة (مطلوب عند الدفع من الدرج)</span><input name="invoiceRef" className="inp" dir="ltr" /></label>
          </div>
          <p className="muted text-xs mt-1 group-has-[:checked]:hidden">بدون تحديد = دفعته أنت من مالك (لا يؤثر على كاش الشيفت).</p>
        </div>

        <details>
          <summary className="cursor-pointer muted text-sm">خيارات أخرى (وقت مختلف، ملاحظة)</summary>
          <div className="grid md:grid-cols-2 gap-3 mt-2">
            <label><span className="lbl">وقت الاستلام (اتركه فارغاً = الآن)</span><input className="inp" type="datetime-local" name="ts" /></label>
            <label><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
          </div>
        </details>

        <button className="btn text-lg px-8 py-3">تسجيل الشراء</button>
      </form>
    </>
  );
}
