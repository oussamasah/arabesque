// One-off import of stock items and product recipes.
// Values marked "estimate" are industry estimates — adjust them in admin (Products → recipe) after measuring.
// Idempotent: existing stock items are reused; products that already have a recipe are skipped.
// Local: run with the server STOPPED. PostgreSQL: set DATABASE_URL.   node scripts/import-recipes.mjs
import { openDb } from "./db.mjs";

// Base units: weight = mg, volume = ml, piece = piece. min = low-stock alert threshold (base units).
const STOCK = [
  ["بن", "weight", 2_000_000],
  ["حليب", "volume", 5_000],
  ["سكر", "weight", 3_000_000],
  ["شاي", "weight", 500_000],
  ["نعناع", "weight", 200_000],
  ["برتقال", "weight", 5_000_000],
  ["جيراك", "weight", 1_000_000],
  ["معسل (معطر)", "weight", 500_000],
  ["فحم", "weight", 15_000_000],
  ["ماء كبير", "piece", 12],
  ["ماء صغير", "piece", 24],
  ["مشروبات غازية كانات", "piece", 24],
  ["مشروبات غازية بلار", "piece", 24],
  ["كرواسون", "piece", 10],
  ["قوبلي", "piece", 50],
];

const COFFEE = ["بن", 12_500, 11_111.111];          // accounted 80 cups/kg, real 90 (confirmed)
const CHARCOAL = ["فحم", 1_200_000, 1_000_000];     // sack 30 kg → accounted 25 shishas, real 30 (confirmed)

// product → [stock item, nominal qty (deducted), real qty]
const RECIPES = {
  "اكسبراس": [COFFEE, ["سكر", 10_000, 10_000]],                                  // sugar ≈ 2 cubes (estimate)
  "ديراكت": [COFFEE, ["حليب", 150, 150], ["سكر", 10_000, 10_000]],               // milk 150 ml (estimate)
  "كابوسان": [COFFEE, ["حليب", 100, 100], ["سكر", 10_000, 10_000]],              // milk 100 ml (confirmed)
  "شاي": [["شاي", 3_000, 2_500], ["سكر", 15_000, 15_000], ["نعناع", 3_000, 3_000]], // estimate
  "عصير": [["برتقال", 500_000, 450_000], ["سكر", 10_000, 10_000]],               // fresh orange (estimate)
  "ماء كبير": [["ماء كبير", 1, 1]],
  "ماء صغير": [["ماء صغير", 1, 1]],
  "مشروبات غازية كانات": [["مشروبات غازية كانات", 1, 1]],
  "مشروبات غازية بلار": [["مشروبات غازية بلار", 1, 1]],
  "كرواسون": [["كرواسون", 1, 1]],
  "قوبلي": [["قوبلي", 1, 1]],
  "جيراك كبير": [["جيراك", 66_667, 62_500], CHARCOAL],                           // 15/kg accounted, 16 real (confirmed)
  "جيراك صغير": [["جيراك", 45_455, 41_666.667], CHARCOAL],                       // 22/kg accounted, 24 real (estimate)
  "شيشة معطر": [["معسل (معطر)", 20_000, 18_181.818], CHARCOAL],                  // 50/kg accounted, 55 real (estimate)
  "شيشة فارغة": [CHARCOAL],
};

const client = await openDb();
const now = new Date().toISOString();

await client.transaction(async (tx) => {
  const ids = {};
  for (const [name, kind, min] of STOCK) {
    const ex = await tx.query("select id from stock_items where name_ar = $1", [name]);
    if (ex.rows.length) { ids[name] = ex.rows[0].id; console.log("stock exists:", name); continue; }
    const { rows } = await tx.query("insert into stock_items (name_ar, kind, min_qty_base) values ($1,$2,$3) returning id", [name, kind, min]);
    ids[name] = rows[0].id;
    await tx.query("insert into audit_log (actor, action, entity, entity_id, after) values ('import','stock_item.import','stock_item',$1,$2)", [String(rows[0].id), JSON.stringify({ name, kind, min })]);
    console.log("stock added:", name);
  }
  for (const [product, lines] of Object.entries(RECIPES)) {
    const p = await tx.query("select id from products where name_ar = $1", [product]);
    if (!p.rows.length) { console.log("!! product not found:", product); continue; }
    const pid = p.rows[0].id;
    const has = await tx.query("select 1 from recipe_versions where product_id = $1 limit 1", [pid]);
    if (has.rows.length) { console.log("recipe exists, skipped:", product); continue; }
    const { rows } = await tx.query("insert into recipe_versions (product_id, effective_from, created_by) values ($1,$2,'import') returning id", [pid, now]);
    for (const [item, nominal, real] of lines) {
      if (real > nominal) throw new Error(`real > nominal for ${product}/${item}`);
      await tx.query("insert into recipe_lines (recipe_version_id, stock_item_id, qty_base, real_qty_base) values ($1,$2,$3,$4)", [rows[0].id, ids[item], nominal, real.toFixed(3)]);
    }
    await tx.query("insert into audit_log (actor, action, entity, entity_id, after) values ('import','product.recipe','product',$1,$2)", [String(pid), JSON.stringify({ version: rows[0].id, lines })]);
    console.log("recipe added:", product);
  }
});
await client.close();
console.log("done");
