import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { stockItems, stockMovements } from "@/db/schema";
import { avgDailyConsumption, daysLeft } from "@/server/stock";
import { getSettings } from "@/server/settings";
import { Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { bigUnitLabel, formatQty, KIND_AR, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

type Status = { label: string; cls: string; order: number };

function statusOf(qty: number, min: number, dl: number | null, reorderDays: number): Status {
  if (qty < 0) return { label: "سالب — سجّل الشراء", cls: "bg-red-600 text-white", order: 0 };
  if (qty === 0) return { label: "فارغ", cls: "bg-red-600 text-white", order: 1 };
  if (min > 0 && qty < min) return { label: "يجب الشراء", cls: "bg-red-100 text-red-800", order: 2 };
  if (dl !== null && dl <= reorderDays) return { label: `يكفي ${dl < 1 ? "أقل من يوم" : `${Math.floor(dl)} يوم`}`, cls: "bg-amber-100 text-amber-800", order: 3 };
  return { label: "متوفر", cls: "bg-green-100 text-green-800", order: 4 };
}

export default async function StockPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const items = await db.select().from(stockItems).orderBy(asc(stockItems.nameAr));
  const [{ n: moves }] = await db.select({ n: sql<string>`count(*)` }).from(stockMovements);
  const rows = await Promise.all(items.filter((i) => i.active).map(async (it) => {
    const avg = await avgDailyConsumption(db, it.id, s.consumption_window_days);
    const dl = daysLeft(it.qtyBase, avg);
    return { it, avg, dl, st: statusOf(it.qtyBase, it.minQtyBase, dl, s.reorder_days_ahead) };
  }));
  rows.sort((a, b) => a.st.order - b.st.order || a.it.nameAr.localeCompare(b.it.nameAr, "ar"));
  const toBuy = rows.filter((r) => r.st.order <= 3).length;
  const totalValue = rows.reduce((a, r) => a + Math.max(0, r.it.qtyBase) * Number(r.it.costPerBase), 0);
  const empty = Number(moves) === 0 || rows.every((r) => r.it.qtyBase === 0);

  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="المخزون" sub={toBuy ? `${toBuy} مواد يجب شراؤها قريباً` : "كل المواد متوفرة ✓"} />

      {empty && (
        <div className="card mb-4 bg-amber-50 border-amber-200 flex flex-wrap items-center gap-3">
          <span className="font-semibold">المخزون فارغ. ابدأ بإدخال ما هو موجود الآن في المقهى (مرة واحدة).</span>
          <Link href="/admin/stock/opening" className="btn">إدخال المخزون الافتتاحي</Link>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Link href="/admin/stock/purchase" className="card text-center hover:bg-[#fbf6f0] py-5">
          <div className="text-3xl">📦</div><div className="font-bold mt-1">شراء</div><div className="muted text-xs">سلعة دخلت المقهى</div>
        </Link>
        <Link href="/admin/stock/count" className="card text-center hover:bg-[#fbf6f0] py-5">
          <div className="text-3xl">📋</div><div className="font-bold mt-1">جرد</div><div className="muted text-xs">ما كتبه شخص الثقة</div>
        </Link>
        <Link href="/admin/stock/shifts" className="card text-center hover:bg-[#fbf6f0] py-5">
          <div className="text-3xl">📊</div><div className="font-bold mt-1">الجرد حسب الشيفت</div><div className="muted text-xs">أي شيفت فيه نقص</div>
        </Link>
        <Link href="/admin/stock/loss" className="card text-center hover:bg-[#fbf6f0] py-5">
          <div className="text-3xl">🗑️</div><div className="font-bold mt-1">تالف / للعمال</div><div className="muted text-xs">سلعة خرجت بدون بيع</div>
        </Link>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
        {rows.map(({ it, st }) => {
          const k = it.kind as StockKind;
          return (
            <Link key={it.id} href={`/admin/stock/${it.id}`} className="card hover:shadow-md transition-shadow flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="font-bold text-lg leading-tight">{it.nameAr}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap ${st.cls}`}>{st.label}</span>
              </div>
              <div className="text-2xl font-black num">{formatQty(k, it.qtyBase)}</div>
              {it.minQtyBase > 0 && <div className="muted text-xs">الحد الأدنى: <span className="num">{formatQty(k, it.minQtyBase)}</span></div>}
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        <Link href="/admin/stock/new" className="btn btn-ghost">+ مادة جديدة</Link>
        <Link href="/admin/stock/opening" className="btn btn-ghost">المخزون الافتتاحي</Link>
      </div>

      <details className="card mt-5">
        <summary className="cursor-pointer font-semibold">تفاصيل التكلفة والاستهلاك (لصاحب المقهى)</summary>
        <p className="muted text-sm my-2">قيمة المخزون الحالي: <Money m={totalValue} /></p>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>المادة</th><th>النوع</th><th>الكمية</th><th>متوسط التكلفة</th><th>القيمة</th><th>الاستهلاك/يوم</th><th>يكفي لـ</th></tr></thead>
            <tbody>
              {rows.map(({ it, avg, dl }) => {
                const k = it.kind as StockKind;
                return (
                  <tr key={it.id}>
                    <td>{it.nameAr}</td><td>{KIND_AR[k]}</td><td className="num">{formatQty(k, it.qtyBase)}</td>
                    <td className="num">{(Number(it.costPerBase) * (k === "weight" ? 1_000_000 : k === "volume" ? 1000 : 1) / 1000).toFixed(3)} DT/{bigUnitLabel(k)}</td>
                    <td><Money m={Math.max(0, it.qtyBase) * Number(it.costPerBase)} /></td>
                    <td className="num">{avg ? formatQty(k, Math.round(avg)) : "—"}</td>
                    <td className="num">{dl === null ? "—" : `${dl.toFixed(1)} يوم`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
