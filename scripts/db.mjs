// Shared DB access for the one-off scripts: PostgreSQL when DATABASE_URL is set (VPS / cloud),
// otherwise the local embedded database in ./data/db (server must be stopped).
import path from "node:path";
import fs from "node:fs";

const migrationsFolder = path.join(process.cwd(), "drizzle");

export async function openDb() {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { default: pg } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder });
    const q = { query: (text, params) => client.query(text, params) };
    return {
      ...q,
      async transaction(fn) {
        await client.query("BEGIN");
        try { const r = await fn(q); await client.query("COMMIT"); return r; }
        catch (e) { await client.query("ROLLBACK"); throw e; }
      },
      close: () => client.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "db");
  fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  await migrate(drizzle(client), { migrationsFolder });
  return {
    query: (text, params) => client.query(text, params),
    transaction: (fn) => client.transaction((tx) => fn(tx)),
    close: () => client.close(),
  };
}
