import Link from "next/link";
import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { stockItems } from "@/db/schema";
import { avgDailyConsumption, daysLeft } from "@/server/stock";
import { getSettings } from "@/server/settings";
import { lossAction, purchaseAction, saveStockItemAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { toTunisLocalInput } from "@/lib/time";
import { bigUnitLabel, formatQty, KIND_AR, type StockKind } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function StockPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await getSettings(db);
  const items = await db.select().from(stockItems).orderBy(asc(stockItems.nameAr));
  const rows = await Promise.all(items.map(async (it) => {
    const avg = await avgDailyConsumption(db, it.id, s.consumption_window_days);
    return { it, avg, dl: daysLeft(it.qtyBase, avg) };
  }));
  const now = toTunisLocalInput(new Date());
  const active = items.filter((i) => i.active);
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="المخزون" sub={`الكمية النظرية = مجموع الحركات. تنبيه مبكر عندما يكفي المخزون ${s.reorder_days_ahead} أيام أو أقل (حسب استهلاك آخر ${s.consumption_window_days} أيام).`}>
        <Link href="/admin/stock/count" className="btn">جرد / تسليم شيفت</Link>
      </PageTitle>
      <div className="card overflow-x-auto mb-5">
        <table className="tbl">
          <thead><tr><th>المادة</th><th>النوع</th><th>الكمية النظرية</th><th>الحد الأدنى</th><th>متوسط التكلفة</th><th>القيمة</th><th>الاستهلاك/يوم</th><th>يكفي لـ</th><th></th></tr></thead>
          <tbody>
            {rows.map(({ it, avg, dl }) => {
              const k = it.kind as StockKind;
              const low = it.minQtyBase > 0 && it.qtyBase < it.minQtyBase;
              const soon = dl !== null && dl <= s.reorder_days_ahead;
              return (
                <tr key={it.id} className={!it.active ? "opacity-50" : ""}>
                  <td className="font-semibold">{it.nameAr}</td>
                  <td>{KIND_AR[k]}</td>
                  <td className="num">{it.qtyBase < 0 ? <span className="badge badge-red">{formatQty(k, it.qtyBase)}</span> : low ? <span className="badge badge-yellow">{formatQty(k, it.qtyBase)}</span> : formatQty(k, it.qtyBase)}</td>
                  <td className="num">{it.minQtyBase ? formatQty(k, it.minQtyBase) : "—"}</td>
                  <td className="num">{(Number(it.costPerBase) * (k === "weight" ? 1_000_000 : k === "volume" ? 1000 : 1) / 1000).toFixed(3)} DT/{bigUnitLabel(k)}</td>
                  <td><Money m={Math.max(0, it.qtyBase) * Number(it.costPerBase)} /></td>
                  <td className="num">{avg ? formatQty(k, Math.round(avg)) : "—"}</td>
                  <td>{dl === null ? "—" : soon ? <span className="badge badge-red">{dl.toFixed(1)} يوم — اشترِ الآن</span> : <span className="num">{dl.toFixed(1)} يوم</span>}</td>
                  <td><Link className="btn btn-ghost btn-sm" href={`/admin/stock/${it.id}`}>التفاصيل</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">شراء (فاتورة)</h2>
          <form action={purchaseAction} className="space-y-2">
            <Back value="/admin/stock" />
            <label className="block"><span className="lbl">المادة</span>
              <select name="stockItemId" className="inp" required>{active.map((i) => <option key={i.id} value={i.id}>{i.nameAr} ({bigUnitLabel(i.kind as StockKind)})</option>)}</select></label>
            <div className="grid grid-cols-2 gap-2">
              <label><span className="lbl">الكمية (كغ / لتر / قطعة)</span><input className="inp" name="qty" required inputMode="decimal" dir="ltr" /></label>
              <label><span className="lbl">السعر الجملي (DT)</span><input className="inp" name="total" required inputMode="decimal" dir="ltr" /></label>
            </div>
            <label className="block"><span className="lbl">وقت الاستلام</span><input className="inp" type="datetime-local" name="ts" defaultValue={now} /></label>
            <label className="block"><span className="lbl">رقم الفاتورة</span><input className="inp" name="invoiceRef" dir="ltr" /></label>
            <fieldset className="flex gap-4 text-sm">
              <label className="flex gap-1 items-center"><input type="radio" name="paidFrom" value="owner" defaultChecked /> من مال المالك</label>
              <label className="flex gap-1 items-center"><input type="radio" name="paidFrom" value="drawer" /> من درج الشيفت</label>
            </fieldset>
            <label className="block"><span className="lbl">وقت الدفع من الدرج (إن كان من الدرج)</span><input className="inp" type="datetime-local" name="paidAt" /></label>
            <label className="block"><span className="lbl">ملاحظة</span><input className="inp" name="note" /></label>
            <label className="flex gap-2 items-center text-sm"><input type="checkbox" name="opening" /> مخزون افتتاحي (بدون مصروف)</label>
            <p className="muted text-xs">عدّ البضاعة عند الاستلام قبل التسجيل. مصروف من الدرج يتطلب رقم الفاتورة.</p>
            <button className="btn w-full">تسجيل الشراء</button>
          </form>
        </section>

        <section className="card">
          <h2 className="h2 mb-3">تالف / استهلاك العمال</h2>
          <form action={lossAction} className="space-y-2">
            <Back value="/admin/stock" />
            <label className="block"><span className="lbl">النوع</span>
              <select name="type" className="inp"><option value="waste">تالف / ضائع</option><option value="staff_consumption">استهلاك العمال</option></select></label>
            <label className="block"><span className="lbl">المادة</span>
              <select name="stockItemId" className="inp" required>{active.map((i) => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-2">
              <label><span className="lbl">الكمية</span><input className="inp" name="qty" required inputMode="decimal" dir="ltr" /></label>
              <label><span className="lbl">الوحدة</span><select name="unit" className="inp"><option value="big">كغ / لتر / قطعة</option><option value="small">غ / مل</option></select></label>
            </div>
            <label className="block"><span className="lbl">الوقت</span><input className="inp" type="datetime-local" name="ts" defaultValue={now} /></label>
            <label className="block"><span className="lbl">ملاحظة (مطلوبة)</span><input className="inp" name="note" required /></label>
            <button className="btn w-full">تسجيل</button>
          </form>
        </section>

        <section className="card">
          <h2 className="h2 mb-3">مادة مخزون جديدة</h2>
          <form action={saveStockItemAction} className="space-y-2">
            <Back value="/admin/stock" />
            <label className="block"><span className="lbl">الاسم *</span><input className="inp" name="nameAr" required placeholder="بن، جيراك، حليب، فحم، ماء 0.5…" /></label>
            <label className="block"><span className="lbl">النوع</span>
              <select name="kind" className="inp"><option value="weight">وزن (كغ)</option><option value="volume">حجم (لتر)</option><option value="piece">قطعة</option></select></label>
            <label className="block"><span className="lbl">الحد الأدنى للتنبيه (كغ / لتر / قطعة)</span><input className="inp" name="min" inputMode="decimal" dir="ltr" /></label>
            <div className="grid grid-cols-2 gap-2">
              <label><span className="lbl">مخزون افتتاحي</span><input className="inp" name="openingQty" inputMode="decimal" dir="ltr" /></label>
              <label><span className="lbl">قيمته (DT)</span><input className="inp" name="openingValue" inputMode="decimal" dir="ltr" /></label>
            </div>
            <button className="btn w-full">إضافة</button>
          </form>
        </section>
      </div>
    </>
  );
}
