// Moves the take-away cup (قوبلي) to the "إضافات" add-ons category (shown in every tablet category tab).
// Local: run with the server STOPPED. PostgreSQL: set DATABASE_URL.   node scripts/set-gobelet-addon.mjs
import { openDb } from "./db.mjs";

const client = await openDb();
const before = await client.query("select id, category, sort_order from products where name_ar = 'قوبلي'");
if (!before.rows.length) { console.log("قوبلي not found"); process.exit(0); }
const p = before.rows[0];
await client.query("update products set category = 'إضافات', sort_order = 99 where id = $1", [p.id]);
await client.query(
  "insert into audit_log (actor, action, entity, entity_id, before, after) values ('import','product.update','product',$1,$2,$3)",
  [String(p.id), JSON.stringify({ category: p.category, sort_order: p.sort_order }), JSON.stringify({ category: "إضافات", sort_order: 99 })],
);
await client.close();
console.log("قوبلي → إضافات");
