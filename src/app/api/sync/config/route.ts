import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { devices } from "@/db/schema";
import { authDevice, rateLimit } from "@/server/devices";
import { buildDeviceConfig } from "@/server/deviceConfig";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = await getDb();
  const dev = await authDevice(db, req);
  if (!dev) return json({ error: "unauthorized" }, 401);
  if (!rateLimit(`cfg:${dev.id}`, 60)) return json({ error: "rate_limited" }, 429);
  const cfg = await buildDeviceConfig(db, dev);
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, dev.id));
  return json({ ...cfg, server_time: Date.now() });
}
