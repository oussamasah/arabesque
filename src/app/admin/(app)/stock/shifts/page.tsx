import Link from "next/link";
import { getDb } from "@/db";
import { shiftStockReport, theoreticalAt } from "@/server/stock";
import { stockItems } from "@/db/schema";
import { eq } from "drizzle-orm";
import { workerFor } from "@/server/finance";
import { getSettings } from "@/server/settings";
import { Flash, Money, PageTitle, one, type SP } from "@/admin/ui";
import { addDays, formatTunis, shiftEnd, shiftInfo, SHIFT_AR } from "@/lib/time";
import { formatQty, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

/** Per shift: stock count vs what the orders say should be left. A shortage is filed under the shift the count closes. */
export default async function ShiftStockPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const today = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const to = one(sp.to) || today;
  const from = one(sp.from) || addDays(to, -6);
  const rows = await shiftStockReport(db, from, to);
  const cur = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour);
  const bad = rows.filter((r) => r.shortages > 0);
  const missing = rows.filter((r) => !r.counted && r.orders > 0 && !(r.businessDay === cur.businessDay && r.shift === cur.shift));
  const items = await db.select().from(stockItems).where(eq(stockItems.active, true)).orderBy(stockItems.nameAr);
  // remaining stock at the END of each shift as the system sees it (orders, purchases, losses; for the current shift: now)
  const withWorker = await Promise.all(rows.map(async (r) => {
    const end = new Date(Math.min(shiftEnd(r.businessDay, r.shift, s.morning_start_hour, s.evening_start_hour).getTime(), Date.now()));
    const remaining = await Promise.all(items.map(async (it) => ({ it, qty: await theoreticalAt(db, it.id, end) })));
    return { r, worker: await workerFor(db, r.businessDay, r.shift, s), remaining };
  }));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="📊 الجرد حسب الشيفت" sub="كل جرد يُنسب إلى الشيفت الذي أغلقه: فإذا ظهر نقص فهو في ذلك الشيفت.">
        <Link href="/admin/stock/count" className="btn">📋 تسجيل جرد</Link>
        <Link href="/admin/stock" className="btn btn-ghost">← المخزون</Link>
      </PageTitle>

      <form className="card mb-4 flex flex-wrap items-end gap-3" action="/admin/stock/shifts">
        <label><span className="lbl">من</span><input className="inp" type="date" name="from" defaultValue={from} /></label>
        <label><span className="lbl">إلى</span><input className="inp" type="date" name="to" defaultValue={to} /></label>
        <button className="btn">عرض</button>
      </form>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card text-center"><div className="muted text-sm">شيفتات بها نقص</div><div className={`text-3xl font-black ${bad.length ? "text-red-700" : "text-green-700"}`}>{bad.length}</div></div>
        <div className="card text-center"><div className="muted text-sm">شيفتات بلا جرد</div><div className={`text-3xl font-black ${missing.length ? "text-amber-700" : "text-green-700"}`}>{missing.length}</div></div>
        <div className="card text-center"><div className="muted text-sm">شيفتات في الفترة</div><div className="text-3xl font-black">{rows.length}</div></div>
      </div>

      {rows.length === 0 && <p className="muted">لا توجد طلبات ولا جرد في هذه الفترة.</p>}
      <div className="space-y-4">
        {withWorker.map(({ r, worker, remaining }) => {
          const isCur = r.businessDay === cur.businessDay && r.shift === cur.shift;
          const badge = !r.counted ? (isCur ? { t: "الشيفت الحالي", c: "badge-gray" } : { t: "لم يُجرد", c: "badge-yellow" })
            : r.shortages ? { t: `نقص في ${r.shortages}`, c: "badge-red" } : { t: "مطابق ✓", c: "badge-green" };
          return (
            <section key={`${r.businessDay}:${r.shift}`} className={`card ${r.shortages ? "border-red-300" : ""}`}>
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <h2 className="h2">{r.businessDay} — {SHIFT_AR[r.shift]}</h2>
                <span className={`badge ${badge.c}`}>{badge.t}</span>
                <span className="muted text-sm">المسؤول: {worker} · {r.orders} طلب</span>
                <Link className="underline text-sm mr-auto" href={`/admin/orders?day=${r.businessDay}`}>الطلبات</Link>
              </div>
              <details className="mb-2">
                <summary className="cursor-pointer font-semibold text-sm">📦 المخزون المتبقي في نهاية الشيفت (حسب النظام)</summary>
                <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
                  {remaining.map(({ it, qty }) => (
                    <div key={it.id} className={`rounded-lg border px-3 py-2 text-sm ${qty < 0 ? "bg-red-50 border-red-200" : "bg-gray-50"}`}>
                      <span className="font-semibold">{it.nameAr}</span>: <span className="num font-bold">{formatQty(it.kind as StockKind, qty)}</span>
                    </div>
                  ))}
                </div>
              </details>
              {r.counted && (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>المادة</th><th>المتوقع (حسب الطلبات)</th><th>المعدود</th><th>الفرق</th><th>القيمة</th><th>وقت الجرد</th></tr></thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={l.itemId} className={l.variance < 0 ? "bg-red-50" : ""}>
                          <td className="font-semibold">{l.name}</td>
                          <td className="num">{formatQty(l.kind, l.theoretical)}</td>
                          <td className="num">{formatQty(l.kind, l.counted)}</td>
                          <td className={`num font-bold ${l.variance < 0 ? "text-red-700" : l.variance > 0 ? "text-blue-700" : "text-green-700"}`} dir="ltr">
                            {l.variance === 0 ? "0 ✓" : `${l.variance > 0 ? "+" : "−"}${formatQty(l.kind, Math.abs(l.variance))}`}
                          </td>
                          <td>{l.variance < 0 ? <Money m={l.value} /> : "—"}</td>
                          <td className="num text-xs">{formatTunis(l.countedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
