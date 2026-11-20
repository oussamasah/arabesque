import { and, desc, ilike, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { PageTitle, Pager, one, type SP } from "@/admin/ui";
import { formatTunis } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const action = one(sp.action) ?? "";
  const page = Math.max(1, Number(one(sp.page) ?? 1));
  const db = await getDb();
  const conds: SQL[] = [];
  if (action) conds.push(ilike(auditLog.action, `%${action.replace(/[%_]/g, "")}%`));
  const rows = await db.select().from(auditLog).where(conds.length ? and(...conds) : undefined).orderBy(desc(auditLog.ts), desc(auditLog.id)).limit(101).offset((page - 1) * 100);
  return (
    <>
      <PageTitle title="سجل التدقيق" sub="كل تعديل من الإدارة مسجّل مع الحالة قبل وبعد. لا يمكن حذف أي سجل." />
      <form className="flex gap-2 mb-4" action="/admin/audit">
        <input className="inp w-64" name="action" defaultValue={action} placeholder="مثال: order.void أو stock" dir="ltr" />
        <button className="btn btn-ghost">بحث</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>الوقت</th><th>من</th><th>العملية</th><th>الكيان</th><th>قبل</th><th>بعد</th><th>IP</th></tr></thead>
          <tbody>
            {rows.slice(0, 100).map((r) => (
              <tr key={r.id}>
                <td className="num">{formatTunis(r.ts, true)}</td><td className="text-xs" dir="ltr">{r.actor}</td><td className="font-mono text-xs" dir="ltr">{r.action}</td>
                <td className="text-xs" dir="ltr">{r.entity}{r.entityId ? `#${r.entityId.slice(0, 40)}` : ""}</td>
                <td className="text-[11px] max-w-xs break-all font-mono" dir="ltr">{r.before ? JSON.stringify(r.before).slice(0, 300) : ""}</td>
                <td className="text-[11px] max-w-xs break-all font-mono" dir="ltr">{r.after ? JSON.stringify(r.after).slice(0, 300) : ""}</td>
                <td className="text-xs num">{r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} hasMore={rows.length > 100} base={`/admin/audit?action=${encodeURIComponent(action)}`} />
      </div>
    </>
  );
}
