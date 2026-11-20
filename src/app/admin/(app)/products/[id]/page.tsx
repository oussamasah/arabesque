import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { productPrices, products, recipeLines, recipeVersions, stockItems } from "@/db/schema";
import { recipeAt } from "@/server/catalog";
import { costAt } from "@/server/stock";
import { deleteProductAction, saveProductAction, saveRecipeAction, setPriceAction, voidPriceAction } from "@/admin/actions/main";
import { Back, CancelForm, Flash, Money, PageTitle, type SP } from "@/admin/ui";
import { formatTunis, toTunisLocalInput } from "@/lib/time";
import { baseToYield, formatSmall, KIND_AR, smallUnitLabel, bigUnitLabel, type StockKind } from "@/lib/units";
import { millimesToInput, roundHalfUp } from "@/lib/money";
import { PRODUCT_IMAGES } from "@/lib/productImages";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [p] = await db.select().from(products).where(eq(products.id, Number(id)));
  if (!p) notFound();
  const prices = await db.select().from(productPrices).where(eq(productPrices.productId, p.id)).orderBy(desc(productPrices.effectiveFrom));
  const versions = await db.select().from(recipeVersions).where(eq(recipeVersions.productId, p.id)).orderBy(desc(recipeVersions.effectiveFrom), desc(recipeVersions.id));
  const allLines = versions.length ? await db.select().from(recipeLines) : [];
  const items = await db.select().from(stockItems).orderBy(asc(stockItems.nameAr));
  const now = new Date();
  const current = await recipeAt(db, p.id, now);
  const back = `/admin/products/${p.id}`;
  const currentPrice = prices.find((x) => x.effectiveFrom <= now)?.priceMillimes ?? null;
  let unitCost = 0;
  for (const l of current?.lines ?? []) unitCost += l.qtyBase * (await costAt(db, l.stockItemId, now));
  unitCost = roundHalfUp(unitCost, 3);
  const editLines = [...(current?.lines ?? []), ...Array(Math.max(1, 4 - (current?.lines.length ?? 0))).fill(null)];

  return (
    <>
      <Flash sp={sp} />
      <PageTitle title={p.nameAr} sub={`تكلفة الوحدة الحالية ${roundHalfUp(unitCost / 1000, 3).toFixed(3)} DT — السعر ${currentPrice === null ? "غير محدد" : millimesToInput(currentPrice) + " DT"}`}>
        <Link href="/admin/products" className="btn btn-ghost">← المنتجات</Link>
      </PageTitle>
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">البيانات</h2>
          <form action={saveProductAction} className="grid grid-cols-2 gap-3">
            <Back value={back} /><input type="hidden" name="id" value={p.id} />
            <label><span className="lbl">الاسم بالعربية</span><input className="inp" name="nameAr" defaultValue={p.nameAr} required /></label>
            <label><span className="lbl">الاسم بالفرنسية</span><input className="inp" name="nameFr" defaultValue={p.nameFr ?? ""} dir="ltr" /></label>
            <label><span className="lbl">الفئة</span><input className="inp" name="category" defaultValue={p.category ?? ""} /></label>
            <label><span className="lbl">الترتيب</span><input className="inp" name="sortOrder" type="number" defaultValue={p.sortOrder} /></label>
            <label><span className="lbl">اللون</span><input className="inp h-10" type="color" name="color" defaultValue={p.color ?? "#7c4a2d"} /></label>
            <label className="flex items-center gap-2 mt-6"><input type="checkbox" name="active" defaultChecked={p.active} /> مفعّل (يظهر على التابلت)</label>
            <fieldset className="col-span-2">
              <span className="lbl">الصورة على التابلت</span>
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-col items-center gap-1 border rounded-lg p-1 cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-[var(--brand)]">
                  <input type="radio" name="image" value="" defaultChecked={!p.image} className="sr-only" />
                  <span className="w-12 h-12 flex items-center justify-center text-xs muted">بدون</span>
                </label>
                {PRODUCT_IMAGES.map((img) => (
                  <label key={img.src} title={img.label} className="flex flex-col items-center border rounded-lg p-1 cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-[var(--brand)]">
                    <input type="radio" name="image" value={img.src} defaultChecked={p.image === img.src} className="sr-only" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.src} alt={img.label} width={48} height={48} />
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="col-span-2"><button className="btn">حفظ</button></div>
          </form>
          <div className="mt-4 border-t pt-3">
            <CancelForm action={deleteProductAction} back={back} id={p.id} label="حذف المنتج" confirm="تأكيد الحذف" withReason={false} />
            <p className="muted text-xs mt-1">يختفي من التابلت والقوائم، ومبيعاته السابقة تبقى في التقارير.</p>
          </div>
        </section>

        <section className="card">
          <h2 className="h2 mb-3">السعر</h2>
          <form action={setPriceAction} className="flex flex-wrap gap-3 items-end mb-4">
            <Back value={back} /><input type="hidden" name="productId" value={p.id} />
            <label><span className="lbl">السعر الجديد (DT)</span><input className="inp w-32" name="price" required inputMode="decimal" dir="ltr" placeholder="1.800" /></label>
            <label><span className="lbl">ساري من (توقيت تونس)</span><input className="inp" type="datetime-local" name="effectiveFrom" defaultValue={toTunisLocalInput(now)} /></label>
            <button className="btn">تسجيل</button>
          </form>
          <table className="tbl"><thead><tr><th>ساري من</th><th>السعر</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>{prices.map((x) => (
              <tr key={x.id} className={x.voidedAt ? "opacity-50 line-through" : ""}>
                <td className="num">{formatTunis(x.effectiveFrom)}</td><td><Money m={x.priceMillimes} /></td><td className="muted text-xs">{x.createdBy}</td>
                <td className="no-underline">{x.voidedAt ? <span className="badge badge-gray">محذوف</span> : <CancelForm action={voidPriceAction} back={back} id={x.id} label="حذف" withReason={false} />}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>

        <section className="card lg:col-span-2">
          <h2 className="h2 mb-1">الوصفة (ما يُنقص من المخزون لكل وحدة مباعة)</h2>
          <p className="muted text-sm mb-3">
            لكل مادة اختر طريقة الإدخال: <b>إنتاج للكيلو/اللتر</b> (مثلاً القهوة: محسوب 80 — حقيقي 90 فنجان/كغ؛ الجيراك: محسوب 15 — حقيقي 16 شيشة/كغ)
            أو <b>كمية للوحدة</b> بالغرام/المل. الفرق بين المحسوب والحقيقي هو الهامش المسموح. المواد بالقطعة لا هامش لها.
          </p>
          <form action={saveRecipeAction} className="space-y-2">
            <Back value={back} /><input type="hidden" name="productId" value={p.id} />
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>المادة</th><th>طريقة الإدخال</th><th>المحسوب (يُنقص)</th><th>الحقيقي (المقاس)</th></tr></thead>
                <tbody>
                  {editLines.map((l, i) => {
                    const it = l ? items.find((x) => x.id === l.stockItemId) : null;
                    const kind = (it?.kind ?? "weight") as StockKind;
                    const isPiece = kind === "piece";
                    // large per-unit quantities (charcoal 1200 g, milk 150 ml…) are clearer and exact in g/ml
                    const yieldMode = !!l && !isPiece && kind === "weight" && l.qtyBase <= 100_000;
                    const small = (b: number) => String(kind === "weight" ? b / 1000 : b);
                    const nomDefault = !l ? "" : isPiece ? String(l.qtyBase) : yieldMode ? String(baseToYield(kind, l.qtyBase)) : small(l.qtyBase);
                    const realDefault = !l || isPiece ? "" : yieldMode ? String(baseToYield(kind, l.realQtyBase)) : small(l.realQtyBase);
                    return (
                      <tr key={i}>
                        <td>
                          <select name="line_item" className="inp" defaultValue={l?.stockItemId ?? ""}>
                            <option value="">—</option>
                            {items.filter((x) => x.active || x.id === l?.stockItemId).map((x) => <option key={x.id} value={x.id}>{x.nameAr} ({KIND_AR[x.kind as StockKind]})</option>)}
                          </select>
                        </td>
                        <td>
                          <select name="line_mode" className="inp" defaultValue={l ? (yieldMode ? "yield" : "qty") : "yield"}>
                            <option value="yield">وحدات لكل كغ/لتر</option>
                            <option value="qty">كمية للوحدة (غ / مل / قطعة)</option>
                          </select>
                        </td>
                        <td><input name="line_nominal" className="inp w-28" dir="ltr" inputMode="decimal" defaultValue={nomDefault} /></td>
                        <td><input name="line_real" className="inp w-28" dir="ltr" inputMode="decimal" defaultValue={realDefault} placeholder="= المحسوب" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label><span className="lbl">سارية من</span><input className="inp" type="datetime-local" name="effectiveFrom" defaultValue={toTunisLocalInput(now)} /></label>
              <button className="btn">حفظ نسخة جديدة</button>
            </div>
            <p className="muted text-xs">لإضافة أسطر أكثر احفظ ثم أعد فتح الصفحة (يظهر سطر فارغ دائماً).</p>
          </form>

          {current && current.lines.length > 0 && (
            <div className="mt-4">
              <h3 className="font-bold mb-1">الوصفة الحالية بالتفصيل</h3>
              <table className="tbl">
                <thead><tr><th>المادة</th><th>المحسوب/وحدة</th><th>الحقيقي/وحدة</th><th>الهامش/وحدة</th><th>إنتاج محسوب</th><th>إنتاج حقيقي</th></tr></thead>
                <tbody>
                  {current.lines.map((l) => {
                    const it = items.find((x) => x.id === l.stockItemId)!;
                    const k = it.kind as StockKind;
                    return (
                      <tr key={l.stockItemId}>
                        <td>{it.nameAr}</td><td className="num">{formatSmall(k, l.qtyBase)}</td><td className="num">{formatSmall(k, l.realQtyBase)}</td>
                        <td className="num">{formatSmall(k, l.qtyBase - l.realQtyBase)}</td>
                        <td className="num">{k === "piece" ? "—" : `${baseToYield(k, l.qtyBase)} / ${bigUnitLabel(k)}`}</td>
                        <td className="num">{k === "piece" ? "—" : `${baseToYield(k, l.realQtyBase)} / ${bigUnitLabel(k)}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="font-bold mt-4 mb-1">نسخ الوصفة</h3>
          <table className="tbl">
            <thead><tr><th>النسخة</th><th>سارية من</th><th>المواد</th><th>بواسطة</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="num">#{v.id}</td><td className="num">{formatTunis(v.effectiveFrom)}</td>
                  <td className="text-xs">{allLines.filter((l) => l.recipeVersionId === v.id).map((l) => {
                    const it = items.find((x) => x.id === l.stockItemId);
                    const k = (it?.kind ?? "weight") as StockKind;
                    return `${it?.nameAr ?? "?"}: ${formatSmall(k, l.qtyBase)} (حقيقي ${formatSmall(k, Number(l.realQtyBase))})`;
                  }).join(" · ") || "بدون مواد"}</td>
                  <td className="muted text-xs">{v.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs mt-2">الوحدات: وزن بالـ{smallUnitLabel("weight")}، حجم بالـ{smallUnitLabel("volume")}.</p>
        </section>
      </div>
    </>
  );
}
