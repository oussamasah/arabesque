import { getDb } from "@/db";
import { runPeriodicChecks } from "@/server/checks";
import { cronAuthorized } from "@/server/cron";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return json({ error: "unauthorized" }, 401);
  await runPeriodicChecks(await getDb());
  return json({ ok: true });
}
