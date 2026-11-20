import { getDb } from "@/db";
import { authDevice, rateLimit } from "@/server/devices";
import { json, readJson } from "@/server/http";
import { checkTicketOnline } from "@/server/tickets";

export const dynamic = "force-dynamic";

/** Returns only {valid}. The worker never learns the customer, type or value. */
export async function POST(req: Request) {
  const db = await getDb();
  const dev = await authDevice(db, req);
  if (!dev) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`tk:${dev.id}`, 30)) return json({ error: "rate_limited" }, 429);
  const body = (await readJson(req, 1000).catch(() => ({}))) as { token_hash?: string; code_hash?: string };
  const ok = (v?: string) => (v && /^[0-9a-f]{64}$/.test(v) ? v : null);
  const valid = await checkTicketOnline(db, { tokenHash: ok(body.token_hash), codeHash: ok(body.code_hash) }, dev.id);
  return json({ valid, server_time: Date.now() });
}
