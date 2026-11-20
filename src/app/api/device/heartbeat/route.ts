import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { devices } from "@/db/schema";
import { authDevice } from "@/server/devices";
import { json, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = await getDb();
  const dev = await authDevice(db, req);
  if (!dev) return json({ error: "unauthorized" }, 401);
  const body = (await readJson(req, 1000).catch(() => ({}))) as { app_version?: string; pending?: number };
  await db.update(devices).set({
    lastSeenAt: new Date(), appVersion: String(body.app_version ?? "").slice(0, 20) || null,
    pendingReported: Number.isInteger(body.pending) ? body.pending : null,
  }).where(eq(devices.id, dev.id));
  return json({ ok: true, server_time: Date.now() });
}
