import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stockItems } from "@/db/schema";
import { lossAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { bigUnitLabel, smallUnitLabel, type StockKind } from "@/lib/units";
import { RecentMovements } from "@/admin/RecentMovements";

export const dynamic = "force-dynamic";

export default async function LossPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const items = await (await getDb()).select().from(stockItems).where(eq(stockItems.active, true)).orderBy(asc(stockItems.nameAr));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="🗑️ سلعة خرجت بدون بيع" sub="تالف، مكسور، منتهي الصلاحية، أو استهلاك العمال المسموح به.">
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>
      <form action={lossAction} className="card max-w-xl space-y-4">
        <Back value="/admin/stock/loss" />
        <fieldset className="grid grid-cols-2 gap-2">
          <label className="rounded-xl border p-3 flex items-center gap-2 cursor-pointer has-[:checked]:bg-[#fbf6f0] has-[:checked]:border-[var(--brand)]">
            <input type="radio" name="type" value="waste" defaultChecked /> تالف / ضائع
          </label>
          <label className="rounded-xl border p-3 flex items-center gap-2 cursor-pointer has-[:checked]:bg-[#fbf6f0] has-[:checked]:border-[var(--brand)]">
            <input type="radio" name="type" value="staff_consumption" /> استهلاك العمال
          </label>
        </fieldset>
        <label className="block"><span className="lbl">المادة</span>
          <select name="stockItemId" className="inp" required defaultValue="">
            <option value="" disabled>— اختر —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.nameAr}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label><span className="lbl">الكمية</span><input className="inp" name="qty" required inputMode="decimal" dir="ltr" /></label>
          <label><span className="lbl">الوحدة</span>
            <select name="unit" className="inp" defaultValue="big">
              <option value="big">{`${bigUnitLabel("weight")} / ${bigUnitLabel("volume")} / ${bigUnitLabel("piece")}`}</option>
              <option value="small">{`${smallUnitLabel("weight")} / ${smallUnitLabel("volume")}`}</option>
            </select>
          </label>
        </div>
        <label className="block"><span className="lbl">السبب (مطلوب)</span><input className="inp" name="note" required placeholder="مثال: قارورة مكسورة" /></label>
        <details>
          <summary className="cursor-pointer muted text-sm">وقت مختلف</summary>
          <label className="block mt-2"><span className="lbl">الوقت (فارغ = الآن)</span><input className="inp" type="datetime-local" name="ts" /></label>
        </details>
        <button className="btn text-lg px-8 py-3">تسجيل</button>
      </form>
      <RecentMovements types={["waste", "staff_consumption"]} back="/admin/stock/loss" title="آخر التالف / استهلاك العمال" />
      <p className="muted text-xs mt-3 max-w-xl">{items.length ? "" : "لا توجد مواد."} هذه الخسائر «مُفسَّرة»: لا تُحسب كنقص في الجرد.</p>
    </>
  );
}
