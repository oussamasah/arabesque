import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { devices } from "@/db/schema";
import { pairCodeAction, revokeDeviceAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, one, type SP } from "@/admin/ui";
import { formatTunis } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function DevicesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = await getDb();
  const rows = await db.select().from(devices).orderBy(desc(devices.pairedAt));
  const code = one(sp.code);
  const exp = Number(one(sp.exp) ?? 0);
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الأجهزة (التابلت)" sub="افتح على التابلت العنوان /pos ثم أدخل رمز الربط. كل جهاز يحصل على مفتاح سري خاص به يمكن إلغاؤه." />
      {code && exp > Date.now() && (
        <div className="card mb-4 text-center bg-amber-50 border-amber-200">
          <div className="muted">رمز ربط الجهاز {one(sp.name)} (صالح حتى {formatTunis(new Date(exp))}، مرة واحدة)</div>
          <div className="text-5xl font-mono font-black tracking-[0.3em] my-3" dir="ltr">{code.slice(0, 4)} {code.slice(4)}</div>
        </div>
      )}
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">ربط تابلت جديد</h2>
          <form action={pairCodeAction} className="space-y-2">
            <Back value="/admin/devices" />
            <label className="block"><span className="lbl">اسم الجهاز (يظهر في رقم الطلب: T1-0045)</span><input className="inp" name="name" defaultValue={rows.some((d) => d.name === "T1" && d.status === "active") ? `T${rows.length + 1}` : "T1"} dir="ltr" maxLength={6} /></label>
            <button className="btn w-full">إنشاء رمز ربط (10 دقائق)</button>
          </form>
        </section>
        <section className="card lg:col-span-2 overflow-x-auto">
          <h2 className="h2 mb-2">الأجهزة</h2>
          <table className="tbl">
            <thead><tr><th>الاسم</th><th>الحالة</th><th>تاريخ الربط</th><th>آخر ظهور</th><th>آخر مزامنة</th><th>آخر رقم</th><th>فرق الساعة</th><th>في الانتظار</th><th>إصدار</th><th></th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className={d.status !== "active" ? "opacity-50" : ""}>
                  <td className="font-bold">{d.name}</td>
                  <td>{d.status === "active" ? <span className="badge badge-green">نشط</span> : <span className="badge badge-gray">ملغى</span>}</td>
                  <td className="num">{formatTunis(d.pairedAt)}</td><td className="num">{formatTunis(d.lastSeenAt)}</td><td className="num">{formatTunis(d.lastSyncAt)}</td>
                  <td className="num">{d.lastSeq}</td><td className="num">{d.lastClockOffsetMs === null ? "—" : `${Math.round(d.lastClockOffsetMs / 1000)} ث`}</td>
                  <td className="num">{d.pendingReported ?? "—"}</td><td className="num">{d.appVersion ?? "—"}</td>
                  <td>{d.status === "active" && <form action={revokeDeviceAction}><Back value="/admin/devices" /><input type="hidden" name="id" value={d.id} /><button className="btn btn-danger btn-sm">إلغاء الربط</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
