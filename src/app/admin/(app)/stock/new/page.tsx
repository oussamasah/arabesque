import Link from "next/link";
import { saveStockItemAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";

export const dynamic = "force-dynamic";

export default async function NewStockItemPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const kinds: [string, string, string][] = [
    ["weight", "بالوزن (كغ)", "بن، سكر، جيراك، فحم…"],
    ["volume", "بالحجم (لتر)", "حليب، عصير…"],
    ["piece", "بالقطعة", "قوارير، كانات، كرواسون…"],
  ];
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="مادة مخزون جديدة">
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>
      <form action={saveStockItemAction} className="card max-w-xl space-y-4">
        <Back value="/admin/stock/new" />
        <label className="block"><span className="lbl">الاسم</span><input className="inp" name="nameAr" required /></label>
        <fieldset className="space-y-2">
          <span className="lbl">كيف تُحسب؟</span>
          {kinds.map(([v, l, ex], i) => (
            <label key={v} className="rounded-xl border p-3 flex items-center gap-3 cursor-pointer has-[:checked]:bg-[#fbf6f0] has-[:checked]:border-[var(--brand)]">
              <input type="radio" name="kind" value={v} defaultChecked={i === 0} />
              <span><b>{l}</b> <span className="muted text-sm">— {ex}</span></span>
            </label>
          ))}
        </fieldset>
        <label className="block"><span className="lbl">نبّهني للشراء عندما ينزل تحت (اختياري)</span><input className="inp" name="min" inputMode="decimal" dir="ltr" /></label>
        <details>
          <summary className="cursor-pointer muted text-sm">الكمية الموجودة الآن (اختياري)</summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label><span className="lbl">الكمية</span><input className="inp" name="openingQty" inputMode="decimal" dir="ltr" /></label>
            <label><span className="lbl">قيمتها (DT)</span><input className="inp" name="openingValue" inputMode="decimal" dir="ltr" /></label>
          </div>
        </details>
        <button className="btn text-lg px-8 py-3">إضافة</button>
      </form>
    </>
  );
}
