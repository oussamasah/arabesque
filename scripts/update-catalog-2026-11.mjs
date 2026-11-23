// Catalogue + stock update of 2026-11-23 (Owner's physical count). Idempotent: re-running changes nothing.
//  - one "قازوز" product replaces "مشروبات غازية كانات" and "مشروبات غازية بلار"
//  - "شيشة معطر" is split into 4 flavours, each with its own stock of ready heads (عمارة جاهزة)
//  - jirak is counted as ready heads (عمارة جيراك, 1 per shisha, big or small)
//  - aluminium foil: 1 piece = 30 cm per shisha (a 100 m pack = 333 pieces)
//  - "قوبلي" is split into 3 sizes (big / medium / small) at 0.100 DT
//  - counted stock is set with a "correction" movement (ref "opening")
// Old products / stock items are soft-deleted (history kept). Local: server STOPPED. PostgreSQL: set DATABASE_URL.
import { openDb } from "./db.mjs";

const ACTOR = "owner-count";
const now = new Date().toISOString();

// stock items: [name, kind, min alert]
const ITEMS = [
  ["قازوز", "piece", 24],
  ["عمارة جيراك", "piece", 10],
  ["معطر تفاح", "piece", 3],
  ["معطر منت", "piece", 3],
  ["معطر لوف", "piece", 3],
  ["معطر شيخ ماني", "piece", 3],
  ["ألمنيوم (قطعة 30 صم)", "piece", 333],
  ["قوبلي كبير", "piece", 20],
  ["قوبلي متوسط", "piece", 20],
  ["قوبلي صغير", "piece", 20],
];

// new products: [name, category, colour, image, price millimes, sort]
const NEW_PRODUCTS = [
  ["قازوز", "مشروبات", "#c81e1e", "soda-can", 2500, 8],
  ["معطر تفاح", "شيشة", "#16a34a", "shisha-flavored", 4500, 13],
  ["معطر منت", "شيشة", "#0d9488", "shisha-flavored", 4500, 13],
  ["معطر لوف", "شيشة", "#db2777", "shisha-flavored", 5000, 13],
  ["معطر شيخ ماني", "شيشة", "#b45309", "shisha-flavored", 5000, 13],
  ["قوبلي كبير", "إضافات", "#57534e", "gobelet", 100, 97],
  ["قوبلي متوسط", "إضافات", "#78716c", "gobelet", 100, 98],
  ["قوبلي صغير", "إضافات", "#a8a29e", "gobelet", 100, 99],
];

const OLD_PRODUCTS = ["مشروبات غازية كانات", "مشروبات غازية بلار", "شيشة معطر", "قوبلي"];
const OLD_ITEMS = ["مشروبات غازية كانات", "مشروبات غازية بلار", "معسل (معطر)", "جيراك", "قوبلي"];

const CHARCOAL = ["فحم", 1_200_000, 1_000_000];
const FOIL = ["ألمنيوم (قطعة 30 صم)", 1, 1];
const RECIPES = {
  "قازوز": [["قازوز", 1, 1]],
  "جيراك كبير": [["عمارة جيراك", 1, 1], CHARCOAL, FOIL],
  "جيراك صغير": [["عمارة جيراك", 1, 1], CHARCOAL, FOIL],
  "معطر تفاح": [["معطر تفاح", 1, 1], CHARCOAL, FOIL],
  "معطر منت": [["معطر منت", 1, 1], CHARCOAL, FOIL],
  "معطر لوف": [["معطر لوف", 1, 1], CHARCOAL, FOIL],
  "معطر شيخ ماني": [["معطر شيخ ماني", 1, 1], CHARCOAL, FOIL],
  "شيشة فارغة": [CHARCOAL, FOIL],
  "قوبلي كبير": [["قوبلي كبير", 1, 1]],
  "قوبلي متوسط": [["قوبلي متوسط", 1, 1]],
  "قوبلي صغير": [["قوبلي صغير", 1, 1]],
};

// counted stock (base units: piece / ml / mg)
const COUNT = {
  "ماء كبير": 44,
  "ماء صغير": 29,
  "قازوز": 63,
  "بن": 3_500_000,          // 3.5 kg ≈ 280 coffees
  "عمارة جيراك": 58,
  "معطر تفاح": 0,
  "معطر منت": 12,
  "معطر لوف": 0,
  "معطر شيخ ماني": 0,
  "ألمنيوم (قطعة 30 صم)": 1500, // 4.5 packs × 100 m / 0.30 m
  "قوبلي كبير": 0,
  "قوبلي متوسط": 30,
  "قوبلي صغير": 6,
  "حليب": 4_000,             // 4 L
};

const audit = (tx, action, entity, id, after, before = null) =>
  tx.query("insert into audit_log (actor, action, entity, entity_id, before, after) values ($1,$2,$3,$4,$5,$6)",
    [ACTOR, action, entity, String(id), before && JSON.stringify(before), JSON.stringify(after)]);

const client = await openDb();
await client.transaction(async (tx) => {
  const item = {};
  for (const [name, kind, min] of ITEMS) {
    const ex = await tx.query("select id from stock_items where name_ar = $1 and deleted_at is null", [name]);
    if (ex.rows.length) { item[name] = ex.rows[0].id; continue; }
    const { rows } = await tx.query("insert into stock_items (name_ar, kind, min_qty_base) values ($1,$2,$3) returning id", [name, kind, min]);
    item[name] = rows[0].id;
    await audit(tx, "stock_item.create", "stock_item", rows[0].id, { name, kind, min });
    console.log("stock item added:", name);
  }
  for (const r of (await tx.query("select id, name_ar from stock_items where deleted_at is null")).rows) item[r.name_ar] ??= r.id;

  for (const [name, category, color, image, price, sort] of NEW_PRODUCTS) {
    const ex = await tx.query("select id from products where name_ar = $1 and deleted_at is null", [name]);
    if (ex.rows.length) continue;
    const { rows } = await tx.query(
      "insert into products (name_ar, category, color, image, sort_order, active) values ($1,$2,$3,$4,$5,true) returning id",
      [name, category, color, `/products/${image}.svg`, sort]);
    await tx.query("insert into product_prices (product_id, price_millimes, effective_from, created_by) values ($1,$2,$3,$4)", [rows[0].id, price, now, ACTOR]);
    await audit(tx, "product.create", "product", rows[0].id, { name, category, price_millimes: price });
    console.log(`product added: ${name} ${(price / 1000).toFixed(3)}`);
  }

  for (const [product, lines] of Object.entries(RECIPES)) {
    const p = await tx.query("select id from products where name_ar = $1 and deleted_at is null", [product]);
    if (!p.rows.length) { console.log("!! product not found:", product); continue; }
    const pid = p.rows[0].id;
    // skip if the latest recipe already has exactly these stock items
    const cur = await tx.query(
      `select rl.stock_item_id from recipe_lines rl where rl.recipe_version_id =
         (select id from recipe_versions where product_id = $1 order by effective_from desc, id desc limit 1)`, [pid]);
    const want = lines.map(([n]) => item[n]).sort().join(",");
    if (cur.rows.map((r) => r.stock_item_id).sort().join(",") === want) continue;
    const { rows } = await tx.query("insert into recipe_versions (product_id, effective_from, created_by) values ($1,$2,$3) returning id", [pid, now, ACTOR]);
    for (const [n, nominal, real] of lines) {
      if (!item[n]) throw new Error("missing stock item " + n);
      await tx.query("insert into recipe_lines (recipe_version_id, stock_item_id, qty_base, real_qty_base) values ($1,$2,$3,$4)", [rows[0].id, item[n], nominal, real.toFixed(3)]);
    }
    await audit(tx, "product.recipe", "product", pid, { version: rows[0].id, lines });
    console.log("recipe set:", product);
  }

  for (const name of OLD_PRODUCTS) {
    const r = await tx.query("update products set deleted_at = $2, active = false where name_ar = $1 and deleted_at is null returning id", [name, now]);
    for (const row of r.rows) { await audit(tx, "product.delete", "product", row.id, { deleted_at: now }); console.log("product removed:", name); }
  }
  for (const name of OLD_ITEMS) {
    const r = await tx.query("update stock_items set deleted_at = $2, active = false where name_ar = $1 and deleted_at is null returning id", [name, now]);
    for (const row of r.rows) { await audit(tx, "stock_item.delete", "stock_item", row.id, { deleted_at: now }); console.log("stock item removed:", name); }
    delete item[name];
  }

  // counted stock: one correction movement per item so qty = counted (skipped when already equal)
  for (const [name, target] of Object.entries(COUNT)) {
    const r = await tx.query("select id, qty_base from stock_items where name_ar = $1 and deleted_at is null", [name]);
    if (!r.rows.length) throw new Error("stock item not found: " + name);
    const { id, qty_base } = r.rows[0];
    const delta = target - Number(qty_base);
    if (delta === 0) continue;
    await tx.query(
      "insert into stock_movements (ts, stock_item_id, delta_base, type, ref_type, ref_id, note, created_by) values ($1,$2,$3,'correction','opening',null,$4,$5)",
      [now, id, delta, "جرد المالك 2026-11-23 (مخزون افتتاحي)", ACTOR]);
    await tx.query("update stock_items set qty_base = qty_base + $2 where id = $1", [id, delta]);
    await audit(tx, "stock.opening_count", "stock_item", id, { qty_base: target }, { qty_base: Number(qty_base) });
    console.log(`stock ${name}: ${qty_base} → ${target}`);
  }
  // alerts about removed items are no longer relevant
  await tx.query("update alerts set resolved_at = $1 where resolved_at is null and type in ('low_stock','negative_stock','stock_running_out')", [now]);
});
await client.close();
console.log("done");
