import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { stockCounts, stockItems } from "@/db/schema";
import { countAction } from "@/admin/actions/main";
import { HANDOVER_AR, type Handover } from "@/server/stock";
import { Back, Flash, Money, PageTitle, one, type SP } from "@/admin/ui";
import { SHIFT_AR, toTunisLocalInput, type Shift } from "@/lib/time";
import { bigUnitLabel, formatQty, formatSmall, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

/** Plain-language reading of one count line. */
function reading(kind: StockKind, variance: number, marginPct: number | null): { text: string; cls: string } {
  if (kind === "piece" || marginPct === null) {
    if (variance < 0) return { text: `ناقص ${formatSmall(kind, -variance)} — يحتاج مراجعة`, cls: "bg-red-50 border-red-200" };
    if (variance > 0) return { text: `زائد ${formatSmall(kind, variance)}`, cls: "bg-blue-50 border-blue-200" };
    return { text: "مطابق ✓", cls: "bg-green-50 border-green-200" };
  }
  if (marginPct >= 100) return { text: `الهامش المسموح كله استُهلك (${marginPct}%) — يحتاج مراجعة`, cls: "bg-red-50 border-red-200" };
  if (marginPct >= 90) return { text: `استُهلك ${marginPct}% من الهامش المسموح — انتبه`, cls: "bg-amber-50 border-amber-200" };
  return { text: `عادي ✓ (استُهلك ${Math.max(0, marginPct)}% من الهامش المسموح)`, cls: "bg-green-50 border-green-200" };
}

export default async function CountPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const items = await db.select().from(stockItems).where(eq(stockItems.active, true)).orderBy(asc(stockItems.nameAr));
  const doneIds = (one(sp.done) ?? "").split(",").map(Number).filter(Boolean);
  const done = doneIds.length ? await db.select().from(stockCounts).where(inArray(stockCounts.id, doneIds)) : [];
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="📋 الجرد" sub="انقل الأرقام من ورقة شخص الثقة. اكتب فقط المواد التي عُدّت.">
        <Link href="/admin/stock/shifts" className="btn btn-ghost">📊 الجرد حسب الشيفت</Link>
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>

      {done.length > 0 && (
        <section className="mb-5 space-y-2">
          <h2 className="h2">النتيجة — {done[0].businessDay} {SHIFT_AR[done[0].evaluatedShift as Shift]}</h2>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {done.map((c) => {
              const it = items.find((x) => x.id === c.stockItemId);
              const k = (it?.kind ?? "weight") as StockKind;
              const r = reading(k, c.varianceBase, c.marginUsedPct === null ? null : Number(c.marginUsedPct));
              return (
                <div key={c.id} className={`rounded-xl border p-3 ${r.cls}`}>
                  <div className="font-bold">{it?.nameAr}</div>
                  <div className="text-sm">{r.text}</div>
                  <div className="muted text-xs mt-1">المتوقع <span className="num">{formatQty(k, c.theoreticalBase)}</span> · المعدود <span className="num">{formatQty(k, c.countedBase)}</span>{c.varianceBase < 0 && <> · القيمة <Money m={c.valueMillimes} /></>}</div>
                </div>
              );
            })}
          </div>
          <p className="muted text-xs">بعد الجرد أصبح المخزون في النظام = الكمية المعدودة.</p>
        </section>
      )}

      <form action={countAction} className="card max-w-2xl space-y-3">
        <Back value="/admin/stock/count" />
        <input type="hidden" name="handover" value="auto" />
        <label className="block max-w-sm"><span className="lbl">وقت الجرد — اتركه فارغاً إن عُدّ الآن، أو اكتب الوقت المكتوب على الورقة</span>
          <input className="inp" type="datetime-local" name="ts" max={toTunisLocalInput(new Date(Date.now() + 60_000))} /></label>
        <div className="grid grid-cols-[1fr_9rem] gap-2 muted text-sm px-1"><span>المادة</span><span>الكمية المعدودة</span></div>
        {items.map((it) => (
          <div key={it.id} className="grid grid-cols-[1fr_9rem] gap-2 items-center">
            <span className="font-semibold">{it.nameAr} <span className="muted text-sm font-normal">({bigUnitLabel(it.kind as StockKind)})</span></span>
            <input className="inp" name={`count_${it.id}`} inputMode="decimal" dir="ltr" />
          </div>
        ))}
        <details>
          <summary className="cursor-pointer muted text-sm">خيارات أخرى (نوع الجرد، من عدّ، ملاحظة)</summary>
          <div className="grid md:grid-cols-3 gap-3 mt-2">
            <label><span className="lbl">نوع الجرد</span>
              <select name="handoverOverride" className="inp" defaultValue="">
                <option value="">تلقائي حسب الوقت</option>
                {(Object.keys(HANDOVER_AR) as Handover[]).map((k) => <option key={k} value={k}>{HANDOVER_AR[k]}</option>)}
              </select></label>
            <label><span className="lbl">من قام بالجرد</span><input className="inp" name="countedBy" /></label>
            <label><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
          </div>
          <p className="muted text-xs mt-2">تلقائي: قرب 15:00 = تسليم الصباحية، قرب 06:00 = تسليم المسائية، غير ذلك = جرد مفاجئ.</p>
        </details>
        <button className="btn text-lg px-8 py-3">تسجيل الجرد</button>
      </form>
    </>
  );
}
