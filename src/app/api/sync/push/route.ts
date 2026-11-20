import { getDb } from "@/db";
import { authDevice, rateLimit } from "@/server/devices";
import { json, readJson } from "@/server/http";
import { MAX_BATCH, processPush } from "@/server/sync";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = await getDb();
  const dev = await authDevice(db, req);
  if (!dev) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`push:${dev.id}`, 120)) return json({ error: "rate_limited" }, 429);
  let body: { device_id?: string; events?: unknown[] };
  try { body = (await readJson(req)) as typeof body; } catch { return json({ error: "bad_json" }, 400); }
  if (body.device_id !== dev.id) return json({ error: "device_mismatch" }, 400);
  if (!Array.isArray(body.events) || body.events.length > MAX_BATCH) return json({ error: "bad_batch" }, 400);
  const res = await processPush(db, dev, body.events);
  return json(res);
}
