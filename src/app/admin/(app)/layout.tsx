import Link from "next/link";
import { and, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { alerts } from "@/db/schema";
import { requireAdmin } from "@/server/auth";
import { logoutAction } from "@/admin/actions/auth";
import { getSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

const NAV: [string, string][] = [
  ["/admin", "لوحة القيادة"],
  ["/admin/orders", "الطلبات"],
  ["/admin/products", "المنتجات والوصفات"],
  ["/admin/stock", "المخزون والجرد"],
  ["/admin/shifts", "الشيفتات والكاش"],
  ["/admin/tickets", "التذاكر"],
  ["/admin/customers", "الكريدي والزبائن"],
  ["/admin/expenses", "المصاريف"],
  ["/admin/wages", "أجور العمال"],
  ["/admin/stats", "الإحصائيات"],
  ["/admin/alerts", "التنبيهات"],
  ["/admin/audit", "سجل التدقيق"],
  ["/admin/devices", "الأجهزة"],
  ["/admin/settings", "الإعدادات"],
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const db = await getDb();
  const s = await getSettings(db);
  const [{ n }] = await db.select({ n: sql<string>`count(*)` }).from(alerts).where(and(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt)));
  const open = Number(n);
  return (
    <div className="min-h-screen md:flex">
      <aside className="no-print md:w-60 md:min-h-screen bg-[var(--brand)] text-white md:sticky md:top-0 md:h-screen md:overflow-auto">
        <div className="p-4 flex items-center gap-2 border-b border-white/15">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" width={32} height={32} />
          <div className="font-bold leading-tight">{s.business_name}<div className="text-xs opacity-70">لوحة المالك</div></div>
        </div>
        <nav className="flex md:flex-col overflow-x-auto md:overflow-visible p-2 gap-1 text-sm">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="px-3 py-2 rounded-lg hover:bg-white/10 whitespace-nowrap flex justify-between items-center">
              <span>{label}</span>
              {href === "/admin/alerts" && open > 0 && <span className="bg-red-500 rounded-full text-xs px-2">{open}</span>}
            </Link>
          ))}
        </nav>
        <div className="p-3 text-xs opacity-80 border-t border-white/15 hidden md:block">
          <div className="truncate" dir="ltr">{admin.email}</div>
          <form action={logoutAction}><button className="underline mt-1">خروج</button></form>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-6 max-w-[1400px] min-w-0">{children}</main>
    </div>
  );
}
