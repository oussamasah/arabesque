import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stockItems } from "@/db/schema";
import { openingStockAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { bigUnitLabel, formatQty, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function OpeningPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const items = await (await getDb()).select().from(stockItems).where(eq(stockItems.active, true)).orderBy(asc(stockItems.nameAr));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="المخزون الافتتاحي" sub="مرة واحدة عند البداية: اكتب ما هو موجود الآن في المقهى. القيمة اختيارية لكنها تجعل حساب التكلفة والربح صحيحاً.">
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>
      <form action={openingStockAction} className="card max-w-3xl space-y-3">
        <Back value="/admin/stock/opening" />
        <div className="grid grid-cols-[1fr_8rem_8rem] gap-2 muted text-sm px-1">
          <span>المادة</span><span>الكمية الموجودة</span><span>قيمتها (DT)</span>
        </div>
        {items.map((it) => {
          const k = it.kind as StockKind;
          return (
            <div key={it.id} className="grid grid-cols-[1fr_8rem_8rem] gap-2 items-center">
              <div>
                <div className="font-semibold">{it.nameAr} <span className="muted text-sm">({bigUnitLabel(k)})</span></div>
                {it.qtyBase !== 0 && <div className="text-xs text-amber-700">مسجّل حالياً: <span className="num">{formatQty(k, it.qtyBase)}</span> — ما تكتبه يُضاف إليه</div>}
              </div>
              <input name={`qty_${it.id}`} className="inp" inputMode="decimal" dir="ltr" />
              <input name={`value_${it.id}`} className="inp" inputMode="decimal" dir="ltr" />
            </div>
          );
        })}
        <p className="muted text-xs">اترك الخانة فارغة للمواد غير الموجودة. لا يُسجَّل أي مصروف (البضاعة كانت موجودة قبل النظام).</p>
        <button className="btn text-lg px-8 py-3">حفظ المخزون الافتتاحي</button>
      </form>
    </>
  );
}
