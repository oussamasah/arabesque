import { getDb } from "@/db";
import { creditAging, productStats, profitSummary, salesByHour, workerStats } from "@/server/finance";
import { getSettings } from "@/server/settings";
import { Money, PageTitle, RangeForm, Stat, one, type SP } from "@/admin/ui";
import { monthStart, shiftInfo } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function StatsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const today = shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
  const from = one(sp.from) || monthStart(today);
  const to = one(sp.to) || today;
  const [sum, prods, hours, workers, credit] = await Promise.all([
    profitSummary(db, from, to), productStats(db, from, to), salesByHour(db, from, to), workerStats(db, from, to), creditAging(db, today),
  ]);
  const maxH = Math.max(1, ...hours.map((h) => h.orders));
  const best = prods.filter((p) => p.units > 0).slice(0, 5);
  const worst = prods.filter((p) => p.units > 0).slice(-5).reverse();
  const q = `from=${from}&to=${to}`;
  return (
    <>
      <PageTitle title="الإحصائيات" sub={`${from} → ${to} (حسب يوم العمل)`}>
        <RangeForm from={from} to={to} action="/admin/stats" />
      </PageTitle>
      <div className="flex flex-wrap gap-2 mb-4 no-print text-sm">
        <span className="muted">تصدير CSV:</span>
        {[["orders", "الطلبات"], ["products", "المنتجات"], ["shifts", "الشيفتات"], ["counts", "الجرد"], ["expenses", "المصاريف"], ["credit", "الكريدي"]].map(([k, l]) => (
          <a key={k} className="btn btn-ghost btn-sm" href={`/admin/export/${k}?${q}`}>{l}</a>
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Stat label="الإيراد النقدي" value={<Money m={sum.revenueCash} />} />
        <Stat label="الربح (نقدي)" value={<Money m={sum.profitCash} />} tone={sum.profitCash >= 0 ? "good" : "bad"} />
        <Stat label="الربح (استهلاك)" value={<Money m={sum.profitConsumption} />} tone={sum.profitConsumption >= 0 ? "good" : "bad"} />
        <Stat label="تكلفة المبيعات" value={<Money m={sum.cogs} />} hint={`مجاني: ${(sum.freeGiveawaysCost / 1000).toFixed(3)} DT`} />
      </div>

      <section className="card overflow-x-auto mb-5">
        <h2 className="h2 mb-2">ربحية المنتجات</h2>
        <table className="tbl">
          <thead><tr><th>المنتج</th><th>الوحدات</th><th>مدفوعة</th><th>مجانية</th><th>كريدي</th><th>غير مدفوعة</th><th>الإيراد</th><th>التكلفة</th><th>الربح المحقق</th><th>السعر الحالي</th><th>تكلفة الوحدة</th><th>هامش الوحدة</th></tr></thead>
          <tbody>
            {prods.map((p) => (
              <tr key={p.productId} className={p.lossMaking ? "bg-red-50" : ""}>
                <td className="font-semibold">{p.name} {p.lossMaking && <span className="badge badge-red">خاسر</span>}</td>
                <td className="num">{p.units}</td><td className="num">{p.paidUnits}</td><td className="num">{p.freeUnits}</td><td className="num">{p.creditUnits}</td><td className="num">{p.unpaidUnits}</td>
                <td><Money m={p.revenue} /></td><td><Money m={p.cost} /></td><td><Money m={p.profit} /></td>
                <td><Money m={p.currentPrice} /></td><td><Money m={p.currentUnitCost} /></td><td><Money m={p.unitMargin} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs mt-2">الربح المحقق = (الوحدات المدفوعة × السعر) − (كل الوحدات × التكلفة). الكريدي يُحسب إيراداً يوم السداد.</p>
      </section>

      <div className="grid lg:grid-cols-2 gap-4 mb-5">
        <section className="card">
          <h2 className="h2 mb-2">الأكثر مبيعاً</h2>
          <ol className="list-decimal pr-5 space-y-1">{best.map((p) => <li key={p.productId}>{p.name} — <span className="num">{p.units}</span></li>)}</ol>
          <h2 className="h2 mt-4 mb-2">الأقل مبيعاً</h2>
          <ol className="list-decimal pr-5 space-y-1">{worst.map((p) => <li key={p.productId}>{p.name} — <span className="num">{p.units}</span></li>)}</ol>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">الطلبات حسب الساعة (توقيت تونس)</h2>
          <div className="space-y-1">
            {hours.map((h) => (
              <div key={h.hour} className="flex items-center gap-2 text-xs">
                <span className="num w-10">{String(h.hour).padStart(2, "0")}:00</span>
                <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden"><div className="h-4 bg-[var(--brand-2)]" style={{ width: `${(h.orders / maxH) * 100}%` }} /></div>
                <span className="num w-10 text-left">{h.orders}</span>
                <span className="w-24"><Money m={h.salesCash} /></span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card overflow-x-auto mb-5">
        <h2 className="h2 mb-2">حسب المسؤول عن الشيفت</h2>
        <table className="tbl">
          <thead><tr><th>المسؤول</th><th>شيفتات</th><th>طلبات</th><th>ملغاة</th><th>تذاكر</th><th>مبيعات كاش</th><th>متوسط الهامش المستعمل</th><th>مجموع فروق الكاش</th><th>🔴 / 🟡</th></tr></thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.worker}><td className="font-semibold">{w.worker}</td><td className="num">{w.shifts}</td><td className="num">{w.orders}</td><td className="num">{w.voids}</td><td className="num">{w.ticketOrders}</td><td><Money m={w.salesCash} /></td><td className="num">{w.marginAvg === null ? "—" : `${w.marginAvg}%`}</td><td><Money m={w.cashVariance} /></td><td className="num">{w.red} / {w.yellow}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs mt-2">إشارة وليست دليلاً: انظر إلى النمط عبر عدة شيفتات، لا إلى فرق واحد.</p>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="h2 mb-2">أعمار ديون الكريدي</h2>
        <table className="tbl">
          <thead><tr><th>الزبون</th><th>الرصيد</th><th>أقدم دين</th><th>العمر (يوم)</th></tr></thead>
          <tbody>{credit.filter((c) => c.balance !== 0).map((c) => <tr key={c.customerId}><td>{c.name}</td><td><Money m={c.balance} /></td><td className="num">{c.oldestUnpaidDay ?? "—"}</td><td className="num">{c.ageDays ?? "—"}</td></tr>)}</tbody>
        </table>
      </section>
    </>
  );
}
