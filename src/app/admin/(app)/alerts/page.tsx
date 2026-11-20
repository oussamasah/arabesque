import { and, desc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { alerts } from "@/db/schema";
import { ackAlertAction, runChecksAction } from "@/admin/actions/main";
import { ALERT_TYPE_AR } from "@/server/audit";
import { Back, Flash, PageTitle, Pager, one, type SP } from "@/admin/ui";
import { formatTunis, SHIFT_AR, type Shift } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AlertsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const view = one(sp.view) ?? "open";
  const type = one(sp.type) ?? "";
  const page = Math.max(1, Number(one(sp.page) ?? 1));
  const db = await getDb();
  const conds: SQL[] = [];
  if (view === "open") conds.push(and(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt))!);
  if (view === "closed") conds.push(or(isNotNull(alerts.acknowledgedAt), isNotNull(alerts.resolvedAt))!);
  if (type) conds.push(eq(alerts.type, type));
  const rows = await db.select().from(alerts).where(conds.length ? and(...conds) : undefined).orderBy(desc(alerts.ts)).limit(101).offset((page - 1) * 100);
  const back = `/admin/alerts?view=${view}&type=${type}`;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="التنبيهات" sub="التنبيه إشارة تحتاج مراجعة، وليس دليلاً. انظر إلى الأنماط المتكررة عبر الشيفتات.">
        <form action={runChecksAction}><Back value={back} /><button className="btn btn-ghost">فحص الآن</button></form>
        {view === "open" && <form action={ackAlertAction}><Back value={back} /><button className="btn">تمّت مراجعة الكل</button></form>}
      </PageTitle>
      <form className="flex flex-wrap gap-2 mb-4" action="/admin/alerts">
        <select className="inp w-auto" name="view" defaultValue={view}><option value="open">مفتوحة</option><option value="closed">مغلقة</option><option value="all">الكل</option></select>
        <select className="inp w-auto" name="type" defaultValue={type}><option value="">كل الأنواع</option>{Object.entries(ALERT_TYPE_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="btn btn-ghost">تصفية</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>الوقت</th><th>الخطورة</th><th>النوع</th><th>الشيفت</th><th>الرسالة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="muted text-center">لا توجد تنبيهات ✓</td></tr>}
            {rows.slice(0, 100).map((a) => (
              <tr key={a.id}>
                <td className="num">{formatTunis(a.ts)}</td>
                <td><span className={`badge ${a.severity === "critical" ? "badge-red" : a.severity === "warn" ? "badge-yellow" : "badge-blue"}`}>{a.severity === "critical" ? "مهم جداً" : a.severity === "warn" ? "تحذير" : "معلومة"}</span></td>
                <td>{ALERT_TYPE_AR[a.type] ?? a.type}</td>
                <td className="text-xs">{a.businessDay ? `${a.businessDay} ${a.shift ? SHIFT_AR[a.shift as Shift] : ""}` : "—"}</td>
                <td>{a.message}</td>
                <td className="text-xs">{a.acknowledgedAt ? `روجع (${a.acknowledgedBy})` : a.resolvedAt ? "زال تلقائياً" : "مفتوح"}</td>
                <td>{!a.acknowledgedAt && !a.resolvedAt && <form action={ackAlertAction}><Back value={back} /><input type="hidden" name="id" value={a.id} /><button className="btn btn-ghost btn-sm">تمت المراجعة</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} hasMore={rows.length > 100} base={back} />
      </div>
    </>
  );
}
