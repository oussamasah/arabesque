// One-off import of the café catalogue (names, categories, tablet colours, images, prices).
// Idempotent: a product whose Arabic name already exists is skipped.
// Local (embedded DB): run with the server STOPPED:  node scripts/import-products.mjs
// PostgreSQL (VPS):     DATABASE_URL=postgres://… node scripts/import-products.mjs
import { openDb } from "./db.mjs";

const PRODUCTS = [
  // [name, category, colour, image, price in millimes]
  ["اكسبراس", "قهوة", "#6b3a1f", "espresso", 1700],
  ["ديراكت", "قهوة", "#8a5a3b", "direct", 2200],
  ["كابوسان", "قهوة", "#a0522d", "cappuccino", 1800],
  ["شاي", "مشروبات ساخنة", "#b45309", "tea", 1000],
  ["عصير", "مشروبات", "#ea580c", "juice", 2500],
  ["ماء كبير", "مشروبات", "#1d6fb8", "water-big", 2000],
  ["ماء صغير", "مشروبات", "#2b88d8", "water-small", 1200],
  ["مشروبات غازية كانات", "مشروبات", "#c81e1e", "soda-can", 2500],
  ["مشروبات غازية بلار", "مشروبات", "#15803d", "soda-bottle", 2000],
  ["كرواسون", "أكل", "#c2850c", "croissant", 1700],
  ["جيراك كبير", "شيشة", "#4338ca", "jirak-big", 5000],
  ["جيراك صغير", "شيشة", "#6366f1", "jirak-small", 3500],
  ["شيشة معطر", "شيشة", "#7c3aed", "shisha-flavored", 4500],
  ["شيشة فارغة", "شيشة", "#64748b", "shisha-empty", 2000],
  ["قوبلي", "إضافات", "#78716c", "gobelet", 200], // take-away cup: add-on shown in every category tab
];

const client = await openDb();

const now = new Date().toISOString();
let added = 0;
await client.transaction(async (tx) => {
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, category, color, image, price] = PRODUCTS[i];
    const exists = await tx.query("select id from products where name_ar = $1", [name]);
    if (exists.rows.length) { console.log("skip (exists):", name); continue; }
    const { rows } = await tx.query(
      "insert into products (name_ar, category, color, image, sort_order, active) values ($1,$2,$3,$4,$5,true) returning id",
      [name, category, color, `/products/${image}.svg`, i + 1],
    );
    const id = rows[0].id;
    await tx.query("insert into product_prices (product_id, price_millimes, effective_from, created_by) values ($1,$2,$3,'import')", [id, price, now]);
    await tx.query(
      "insert into audit_log (actor, action, entity, entity_id, after) values ('import','product.import','product',$1,$2)",
      [String(id), JSON.stringify({ name, category, price_millimes: price, image })],
    );
    added++;
    console.log(`added #${id} ${name} — ${(price / 1000).toFixed(3)} DT`);
  }
});
await client.close();
console.log(`done: ${added} added`);
