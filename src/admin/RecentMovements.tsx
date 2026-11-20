import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { expenses, stockItems, stockMovements } from "@/db/schema";
import { cancelMovementAction } from "@/admin/actions/main";
import { cancelledMovementIds } from "@/server/corrections";
import { CancelForm, Money } from "@/admin/ui";
import { formatTunis } from "@/lib/time";
import { formatQty, type StockKind } from "@/lib/units";

const TYPE_AR: Record<string, string> = { purchase: "شراء", waste: "تالف", staff_consumption: "للعمال" };

/** Last purchases or losses with a "cancel" button (mistakes are corrected by a reversing movement). */
export async function RecentMovements({ types, back, title }: { types: string[]; back: string; title: string }) {
  const db = await getDb();
  const rows = await db.select({ m: stockMovements, name: stockItems.nameAr, kind: stockItems.kind }).from(stockMovements)
    .innerJoin(stockItems, eq(stockItems.id, stockMovements.stockItemId))
    .where(inArray(stockMovements.type, types)).orderBy(desc(stockMovements.createdAt), desc(stockMovements.id)).limit(25);
  if (!rows.length) return null;
  const cancelled = await cancelledMovementIds(db, rows.map((r) => r.m.id));
  const exp = types.includes("purchase")
    ? await db.select().from(expenses).where(and(eq(expenses.isPurchase, true), inArray(expenses.purchaseRef, rows.map((r) => r.m.id))))
    : [];
  return (
    <section className="card mt-5 max-w-3xl overflow-x-auto">
      <h2 className="h2 mb-2">{title}</h2>
      <table className="tbl">
        <thead><tr><th>الوقت</th><th>المادة</th><th>الكمية</th><th>{types.includes("purchase") ? "المبلغ" : "النوع"}</th><th>ملاحظة</th><th></th></tr></thead>
        <tbody>
          {rows.map(({ m, name, kind }) => {
            const e = exp.find((x) => x.purchaseRef === m.id);
            const isCancelled = cancelled.has(m.id);
            return (
              <tr key={m.id} className={isCancelled ? "opacity-50" : ""}>
                <td className="num">{formatTunis(m.ts)}</td>
                <td className="font-semibold">{name}</td>
                <td className="num">{formatQty(kind as StockKind, Math.abs(m.deltaBase))}</td>
                <td>{types.includes("purchase") ? (m.refType === "opening" ? <span className="badge badge-gray">افتتاحي</span> : e ? <Money m={e.amountMillimes} /> : "—") : TYPE_AR[m.type]}</td>
                <td className="text-xs">{e?.invoiceRef ? `فاتورة ${e.invoiceRef} · ` : ""}{m.note}</td>
                <td>{isCancelled ? <span className="badge badge-gray">ملغى</span> : <CancelForm action={cancelMovementAction} back={back} id={m.id} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted text-xs mt-2">الإلغاء يُرجع المخزون (والمصروف للشراء) ويبقى مسجّلاً في سجل التدقيق.</p>
    </section>
  );
}
