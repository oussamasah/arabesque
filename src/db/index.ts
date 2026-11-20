import "server-only";
import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Exec = DB | Tx;

type G = typeof globalThis & { __cafeDb?: Promise<DB> };
const g = globalThis as G;

const migrationsFolder = path.join(process.cwd(), "drizzle");

async function createDb(): Promise<DB> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    return db as unknown as DB;
  }
  // Local / single-PC mode: embedded Postgres (PGlite) persisted in ./data/db
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "db");
  fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as DB;
}

export function getDb(): Promise<DB> {
  if (!g.__cafeDb) {
    g.__cafeDb = createDb().catch((e) => {
      g.__cafeDb = undefined;
      throw e;
    });
  }
  return g.__cafeDb;
}

/** Tests only: inject an in-memory database. */
export function __setDbForTests(db: DB) {
  g.__cafeDb = Promise.resolve(db);
}

export { schema };
