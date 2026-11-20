import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { productPrices, products, recipeLines, recipeVersions, stockItems } from "@/db/schema";
import type { Exec } from "@/db";
import { audit } from "./audit";
import { assertInt } from "@/lib/money";

export interface ProductInput {
  nameAr: string; nameFr?: string | null; category?: string | null; color?: string | null; image?: string | null;
  sortOrder?: number; active?: boolean;
}

export async function createProduct(db: Exec, p: ProductInput, actor: string) {
  if (!p.nameAr.trim()) throw new Error("اسم المنتج مطلوب");
  const [row] = await db.insert(products).values({
    nameAr: p.nameAr.trim(), nameFr: p.nameFr || null, category: p.category || null,
    color: p.color || "#7c4a2d", image: p.image || null, sortOrder: p.sortOrder ?? 0, active: p.active ?? true,
  }).returning();
  await audit(db, actor, "product.create", "product", row.id, null, row);
  return row;
}

export async function updateProduct(db: Exec, id: number, p: ProductInput, actor: string) {
  const [before] = await db.select().from(products).where(eq(products.id, id));
  if (!before) throw new Error("منتج غير موجود");
  const [row] = await db.update(products).set({
    nameAr: p.nameAr.trim(), nameFr: p.nameFr || null, category: p.category || null,
    color: p.color || before.color, image: p.image === undefined ? before.image : p.image || null, sortOrder: p.sortOrder ?? before.sortOrder, active: p.active ?? before.active,
  }).where(eq(products.id, id)).returning();
  await audit(db, actor, "product.update", "product", id, before, row);
  return row;
}

/** New price = new row with effective time (history is never rewritten). */
export async function setPrice(db: Exec, productId: number, priceMillimes: number, effectiveFrom: Date, actor: string) {
  assertInt(priceMillimes, "price");
  if (priceMillimes < 0) throw new Error("السعر لا يمكن أن يكون سالباً");
  const [row] = await db.insert(productPrices).values({ productId, priceMillimes, effectiveFrom, createdBy: actor }).returning();
  await audit(db, actor, "product.price", "product", productId, null, row);
  return row;
}

export async function priceAt(db: Exec, productId: number, at: Date): Promise<number | null> {
  const [row] = await db.select().from(productPrices)
    .where(and(eq(productPrices.productId, productId), lte(productPrices.effectiveFrom, at), isNull(productPrices.voidedAt)))
    .orderBy(desc(productPrices.effectiveFrom), desc(productPrices.id)).limit(1);
  return row ? row.priceMillimes : null;
}

export interface RecipeLineInput { stockItemId: number; qtyBase: number; realQtyBase: number }

/** Saving a recipe always creates a new version (past orders keep their version). */
export async function saveRecipe(db: Exec, productId: number, lines: RecipeLineInput[], effectiveFrom: Date, actor: string) {
  const seen = new Set<number>();
  for (const l of lines) {
    assertInt(l.qtyBase, "qty");
    if (l.qtyBase <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
    if (l.realQtyBase < 0) throw new Error("الكمية الحقيقية لا يمكن أن تكون سالبة");
    if (l.realQtyBase > l.qtyBase) throw new Error("الاستهلاك الحقيقي لا يمكن أن يتجاوز الكمية المحسوبة (الهامش سالب)");
    if (seen.has(l.stockItemId)) throw new Error("مادة مكررة في الوصفة");
    seen.add(l.stockItemId);
  }
  if (lines.length) {
    const items = await db.select().from(stockItems).where(inArray(stockItems.id, [...seen]));
    for (const l of lines) {
      const it = items.find((i) => i.id === l.stockItemId);
      if (!it) throw new Error("مادة مخزون غير موجودة");
      if (it.kind === "piece" && l.realQtyBase !== l.qtyBase) throw new Error(`"${it.nameAr}" بالقطعة: لا هامش (الحقيقي = المحسوب)`);
    }
  }
  const [v] = await db.insert(recipeVersions).values({ productId, effectiveFrom, createdBy: actor }).returning();
  if (lines.length) {
    await db.insert(recipeLines).values(lines.map((l) => ({
      recipeVersionId: v.id, stockItemId: l.stockItemId, qtyBase: l.qtyBase, realQtyBase: l.realQtyBase.toFixed(3),
    })));
  }
  await audit(db, actor, "product.recipe", "product", productId, null, { version: v.id, effectiveFrom, lines });
  return v;
}

export async function recipeAt(db: Exec, productId: number, at: Date) {
  const [v] = await db.select().from(recipeVersions)
    .where(and(eq(recipeVersions.productId, productId), lte(recipeVersions.effectiveFrom, at)))
    .orderBy(desc(recipeVersions.effectiveFrom), desc(recipeVersions.id)).limit(1);
  if (!v) return null;
  const lines = await db.select().from(recipeLines).where(eq(recipeLines.recipeVersionId, v.id));
  return { versionId: v.id, lines: lines.map((l) => ({ stockItemId: l.stockItemId, qtyBase: l.qtyBase, realQtyBase: Number(l.realQtyBase) })) };
}

export async function listProducts(db: Exec, onlyActive = false) {
  const q = db.select().from(products);
  const rows = onlyActive ? await q.where(and(eq(products.active, true), isNull(products.deletedAt))).orderBy(asc(products.sortOrder), asc(products.id))
    : await q.where(isNull(products.deletedAt)).orderBy(asc(products.sortOrder), asc(products.id));
  return rows;
}
