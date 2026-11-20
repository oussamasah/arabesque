import { getDb } from "@/db";
import { redeemPairingCode, rateLimit } from "@/server/devices";
import { json, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (!rateLimit(`pair:${ip}`, 10, 10 * 60_000)) return json({ error: "rate_limited" }, 429);
  try {
    const body = (await readJson(req, 2000)) as { code?: string };
    const db = await getDb();
    const res = await redeemPairingCode(db, String(body.code ?? ""));
    return json({ ...res, server_time: Date.now() });
  } catch {
    return json({ error: "invalid_code" }, 400);
  }
}
