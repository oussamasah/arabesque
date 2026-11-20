import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { stockCounts, stockItems } from "@/db/schema";
import { countAction } from "@/admin/actions/main";
import { HANDOVER_AR, type Handover } from "@/server/stock";
import { getSettings } from "@/server/settings";
import { Back, Flash, Money, PageTitle, one, type SP } from "@/admin/ui";
import { shiftInfo, SHIFT_AR, toTunisLocalInput, type Shift } from "@/lib/time";
import { bigUnitLabel, formatQty, formatSmall, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function CountPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const items = await db.select().from(stockItems).where(eq(stockItems.active, true)).orderBy(asc(stockItems.nameAr));
  const doneIds = (one(sp.done) ?? "").split(",").map(Number).filter(Boolean);
  const done = doneIds.length ? await db.select().from(stockCounts).where(inArray(stockCounts.id, doneIds)) : [];
  const now = new Date();
  const h = shiftInfo(now, s.morning_start_hour, s.evening_start_hour).shift === "evening" ? "morning_to_evening" : "evening_to_morning";
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الجرد" sub="انقل ما كتبه شخص الثقة على الورقة، مع الوقت الحقيقي للجرد. النظام يحسب الكمية النظرية في ذلك الوقت بالضبط.">
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>

      {done.length > 0 && (
        <section className="card mb-5 overflow-x-auto">
          <h2 className="h2 mb-2">نتيجة الجرد</h2>
          <table className="tbl">
            <thead><tr><th>المادة</th><th>الشيفت المعني</th><th>نظري</th><th>معدود</th><th>الفرق</th><th>مبيعات</th><th>الهامش المستعمل</th><th>القيمة</th><th>القراءة</th></tr></thead>
            <tbody>
              {done.map((c) => {
                const it = items.find((x) => x.id === c.stockItemId);
                const k = (it?.kind ?? "weight") as StockKind;
                const m = c.marginUsedPct === null ? null : Number(c.marginUsedPct);
                const reading = k === "piece"
                  ? (c.varianceBase < 0 ? "نقص — يحتاج مراجعة" : c.varianceBase > 0 ? "زيادة" : "مطابق ✓")
                  : m === null ? (c.varianceBase < 0 ? "نقص — يحتاج مراجعة" : "—")
                  : m >= 100 ? "الهامش كله استُهلك أو أكثر — يحتاج مراجعة" : m >= 90 ? "هامش مستعمل مرتفع" : "عادي";
                return (
                  <tr key={c.id}>
                    <td className="font-semibold">{it?.nameAr}</td><td className="text-xs">{c.businessDay} {SHIFT_AR[c.evaluatedShift as Shift]}</td>
                    <td className="num">{formatQty(k, c.theoreticalBase)}</td><td className="num">{formatQty(k, c.countedBase)}</td>
                    <td className={`num ${c.varianceBase < 0 ? "text-red-700 font-bold" : ""}`}>{formatSmall(k, c.varianceBase)}</td>
                    <td className="num">{c.unitsSold}</td>
                    <td>{m === null ? "—" : <span className={`badge ${m >= 100 ? "badge-red" : m >= 90 ? "badge-yellow" : "badge-green"}`}>{m}%</span>}</td>
                    <td><Money m={c.valueMillimes} /></td><td className="text-xs">{reading}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <form action={countAction} className="card space-y-3">
        <Back value="/admin/stock/count" />
        <div className="grid md:grid-cols-4 gap-3">
          <label><span className="lbl">نوع الجرد</span>
            <select name="handover" className="inp" defaultValue={h}>
              {(Object.keys(HANDOVER_AR) as Handover[]).map((k) => <option key={k} value={k}>{HANDOVER_AR[k]}</option>)}
            </select></label>
          <label><span className="lbl">وقت الجرد الحقيقي (من الورقة)</span><input className="inp" type="datetime-local" name="ts" defaultValue={toTunisLocalInput(now)} required /></label>
          <label><span className="lbl">من قام بالجرد</span><input className="inp" name="countedBy" /></label>
          <label><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
        </div>
        <table className="tbl">
          <thead><tr><th>المادة</th><th>الكمية المعدودة</th><th>الوحدة</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="font-semibold">{it.nameAr}</td>
                <td><input className="inp w-40" name={`count_${it.id}`} inputMode="decimal" dir="ltr" placeholder="اتركه فارغاً إن لم يُعد" /></td>
                <td>{bigUnitLabel(it.kind as StockKind)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs">الكمية النظرية لا تظهر هنا عمداً: أدخل ما هو مكتوب على الورقة فقط. بعد التسجيل يضبط النظام المخزون على الكمية المعدودة (حركة تسوية جرد).</p>
        <button className="btn">تسجيل الجرد</button>
      </form>
    </>
  );
}
