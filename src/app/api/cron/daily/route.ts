import { getDb } from "@/db";
import { runPeriodicChecks, sendDailyReport } from "@/server/checks";
import { cronAuthorized } from "@/server/cron";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const db = await getDb();
  await runPeriodicChecks(db);
  try {
    await sendDailyReport(db);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}
