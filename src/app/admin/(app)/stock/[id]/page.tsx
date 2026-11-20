import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stockCounts, stockItems, stockMovements } from "@/db/schema";
import { saveStockItemAction } from "@/admin/actions/main";
import { HANDOVER_AR, type Handover } from "@/server/stock";
import { Back, Flash, Money, PageTitle, Pager, one, type SP } from "@/admin/ui";
import { formatTunis, SHIFT_AR, type Shift } from "@/lib/time";
import { formatQty, formatSmall, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

const MV_AR: Record<string, string> = {
  sale: "بيع", void: "إلغاء طلب", purchase: "شراء", count_adjust: "تسوية جرد", waste: "تالف", staff_consumption: "استهلاك العمال", correction: "تصحيح",
};

export default async function StockItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(one(sp.page) ?? 1));
  const db = await getDb();
  const [it] = await db.select().from(stockItems).where(eq(stockItems.id, Number(id)));
  if (!it) notFound();
  const k = it.kind as StockKind;
  const mvs = await db.select().from(stockMovements).where(eq(stockMovements.stockItemId, it.id)).orderBy(desc(stockMovements.ts), desc(stockMovements.id)).limit(51).offset((page - 1) * 50);
  const counts = await db.select().from(stockCounts).where(eq(stockCounts.stockItemId, it.id)).orderBy(desc(stockCounts.ts)).limit(60);
  const back = `/admin/stock/${it.id}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={it.nameAr} sub={`الكمية النظرية: ${formatQty(k, it.qtyBase)}`}>
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">تعديل</h2>
          <form action={saveStockItemAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="id" value={it.id} />
            <label className="block"><span className="lbl">الاسم</span><input className="inp" name="nameAr" defaultValue={it.nameAr} required /></label>
            <label className="block"><span className="lbl">الحد الأدنى للتنبيه (كغ / لتر / قطعة)</span><input className="inp" name="min" dir="ltr" defaultValue={it.minQtyBase ? String(k === "piece" ? it.minQtyBase : it.minQtyBase / (k === "weight" ? 1e6 : 1e3)) : ""} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={it.active} /> مفعّلة</label>
            <button className="btn">حفظ</button>
          </form>
        </section>
        <section className="card lg:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">سجل الجرد والهامش</h2>
          <table className="tbl">
            <thead><tr><th>الوقت</th><th>النوع</th><th>الشيفت المعني</th><th>نظري</th><th>معدود</th><th>الفرق</th><th>المبيعات</th><th>الفائض المتوقع</th><th>الهامش المستعمل</th><th>القيمة</th></tr></thead>
            <tbody>
              {counts.length === 0 && <tr><td colSpan={10} className="muted text-center">لا جرد بعد</td></tr>}
              {counts.map((c) => {
                const m = c.marginUsedPct === null ? null : Number(c.marginUsedPct);
                return (
                  <tr key={c.id}>
                    <td className="num">{formatTunis(c.ts)}</td><td className="text-xs">{HANDOVER_AR[c.handover as Handover]}</td>
                    <td className="text-xs">{c.businessDay} {SHIFT_AR[c.evaluatedShift as Shift]}</td>
                    <td className="num">{formatQty(k, c.theoreticalBase)}</td><td className="num">{formatQty(k, c.countedBase)}</td>
                    <td className={`num ${c.varianceBase < 0 ? "text-red-700 font-bold" : ""}`}>{formatSmall(k, c.varianceBase)}</td>
                    <td className="num">{c.unitsSold}</td><td className="num">{formatSmall(k, Number(c.expectedSurplusBase))}</td>
                    <td>{m === null ? "—" : <span className={`badge ${m >= 100 ? "badge-red" : m >= 90 ? "badge-yellow" : "badge-green"}`}>{m}%</span>}</td>
                    <td><Money m={c.valueMillimes} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">0% = كل الهامش موجود (كل شيء محسوب) · 100% = الهامش كله استُهلك · أكثر من 100% = نقص يتجاوز الهامش.</p>
        </section>
        <section className="card lg:col-span-3 overflow-x-auto">
          <h2 className="h2 mb-2">الحركات (سجل غير قابل للتعديل)</h2>
          <table className="tbl">
            <thead><tr><th>الوقت</th><th>النوع</th><th>الكمية</th><th>المرجع</th><th>ملاحظة</th><th>بواسطة</th></tr></thead>
            <tbody>
              {mvs.slice(0, 50).map((m) => (
                <tr key={m.id}>
                  <td className="num">{formatTunis(m.ts)}</td><td>{MV_AR[m.type] ?? m.type}</td>
                  <td className={`num ${m.deltaBase < 0 ? "text-red-700" : "text-green-700"}`}>{m.deltaBase > 0 ? "+" : ""}{formatSmall(k, m.deltaBase)}</td>
                  <td className="text-xs">{m.refType === "order" ? <Link className="underline" href={`/admin/orders/${m.refId}`}>طلب</Link> : m.refType ?? ""}</td>
                  <td className="text-xs">{m.note}</td><td className="muted text-xs">{m.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} hasMore={mvs.length > 50} base={back} />
        </section>
      </div>
    </>
  );
}
