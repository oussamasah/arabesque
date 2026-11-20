import Link from "next/link";
import { getDb } from "@/db";
import { listProducts, priceAt, recipeAt } from "@/server/catalog";
import { costAt } from "@/server/stock";
import { saveProductAction } from "@/admin/actions/main";
import { Back, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { roundHalfUp } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function ProductsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const prods = await listProducts(db);
  const now = new Date();
  const rows = await Promise.all(prods.map(async (p) => {
    const price = await priceAt(db, p.id, now);
    const r = await recipeAt(db, p.id, now);
    let cost = 0;
    for (const l of r?.lines ?? []) cost += l.qtyBase * (await costAt(db, l.stockItemId, now));
    cost = roundHalfUp(cost, 3);
    return { p, price, cost, hasRecipe: !!r?.lines.length, margin: price === null ? null : price - cost };
  }));
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="المنتجات والوصفات" sub="السعر الجديد يُسجَّل كنسخة جديدة، والوصفة كذلك — الطلبات القديمة لا تتغير أبداً." />
      <div className="card overflow-x-auto mb-6">
        <table className="tbl">
          <thead><tr><th>#</th><th>المنتج</th><th>الفئة</th><th>السعر الحالي</th><th>تكلفة الوحدة</th><th>هامش الوحدة</th><th>الوصفة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {rows.map(({ p, price, cost, hasRecipe, margin }) => (
              <tr key={p.id}>
                <td className="num">{p.sortOrder}</td>
                <td className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.image ? <img src={p.image} alt="" width={32} height={32} className="rounded" style={{ background: p.color ?? "#999", padding: 2 }} /> : <span className="dot" style={{ background: p.color ?? "#999" }} />}
                  {p.nameAr}
                </td>
                <td>{p.category ?? "—"}</td>
                <td>{price === null ? <span className="badge badge-red">بدون سعر</span> : <Money m={price} />}</td>
                <td><Money m={cost} /></td>
                <td>{margin === null ? "—" : <span className={margin < 0 ? "badge badge-red" : ""}><Money m={margin} /></span>}</td>
                <td>{hasRecipe ? <span className="badge badge-green">موجودة</span> : <span className="badge badge-yellow">بدون وصفة</span>}</td>
                <td>{p.active ? <span className="badge badge-green">مفعّل</span> : <span className="badge badge-gray">موقوف</span>}</td>
                <td><Link className="btn btn-ghost btn-sm" href={`/admin/products/${p.id}`}>تعديل</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card max-w-2xl">
        <h2 className="h2 mb-3">منتج جديد</h2>
        <form action={saveProductAction} className="grid md:grid-cols-2 gap-3">
          <Back value="/admin/products" />
          <label><span className="lbl">الاسم بالعربية *</span><input className="inp" name="nameAr" required /></label>
          <label><span className="lbl">الاسم بالفرنسية</span><input className="inp" name="nameFr" dir="ltr" /></label>
          <label><span className="lbl">الفئة (قهوة، شيشة، مشروبات…)</span><input className="inp" name="category" list="cats" /></label>
          <label><span className="lbl">السعر (DT)</span><input className="inp" name="price" inputMode="decimal" placeholder="1.800" dir="ltr" /></label>
          <label><span className="lbl">اللون على التابلت</span><input className="inp h-10" type="color" name="color" defaultValue="#7c4a2d" /></label>
          <label><span className="lbl">الترتيب</span><input className="inp" name="sortOrder" type="number" defaultValue={prods.length + 1} /></label>
          <datalist id="cats">{[...new Set(prods.map((p) => p.category).filter(Boolean))].map((c) => <option key={c} value={c!} />)}</datalist>
          <div className="md:col-span-2"><button className="btn">إضافة</button></div>
        </form>
      </div>
    </>
  );
}
