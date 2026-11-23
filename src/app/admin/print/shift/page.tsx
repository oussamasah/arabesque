import { and, asc, eq, gte, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { orderItems, orders, products, stockItems, stockMovements } from "@/db/schema";
import { theoreticalAt } from "@/server/stock";
import { getSettings } from "@/server/settings";
import { formatQty, type StockKind } from "@/lib/units";
import { requireAdmin } from "@/server/auth";
import { formatDT } from "@/lib/money";
import { formatTunis, shiftEnd, shiftStart, SHIFT_AR } from "@/lib/time";
import { PrintButton } from "../sheet/[id]/PrintButton";

export const dynamic = "force-dynamic";

const PAY_AR: Record<string, string> = { cash: "كاش", ticket: "تذكرة", pending: "غير مدفوع", loss: "خرج دون دفع" };

/** Printable report of one shift: every order + quantity sold per product, all computed from the orders. */
export default async function PrintShift({ searchParams }: { searchParams: Promise<{ day?: string; shift?: string }> }) {
  await requireAdmin();
  const { day, shift } = await searchParams;
  if (!day || (shift !== "morning" && shift !== "evening")) return <main className="p-6">اختر الشيفت من لوحة القيادة.</main>;
  const db = await getDb();
  const rows = await db.select().from(orders)
    .where(and(eq(orders.businessDay, day), eq(orders.shift, shift), ne(orders.status, "void"))).orderBy(asc(orders.effectiveTs));
  const items = await db.select({ orderId: orderItems.orderId, name: products.nameAr, qty: orderItems.qty, price: orderItems.unitPriceMillimes })
    .from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).innerJoin(products, eq(products.id, orderItems.productId))
    .where(and(eq(orders.businessDay, day), eq(orders.shift, shift), ne(orders.status, "void")));
  const byOrder = new Map<string, typeof items>();
  const perProduct = new Map<string, { qty: number; value: number }>();
  for (const it of items) {
    byOrder.set(it.orderId, [...(byOrder.get(it.orderId) ?? []), it]);
    const p = perProduct.get(it.name) ?? { qty: 0, value: 0 };
    p.qty += it.qty; p.value += it.qty * it.price;
    perProduct.set(it.name, p);
  }
  const st = await getSettings(db);
  const end = new Date(Math.min(shiftEnd(day, shift, st.morning_start_hour, st.evening_start_hour).getTime(), Date.now()));
  const begin = shiftStart(day, shift, st.morning_start_hour, st.evening_start_hour);
  const stockRows = await db.select().from(stockItems).where(eq(stockItems.active, true)).orderBy(stockItems.nameAr);
  // an opening count entered during this shift IS the starting stock of that item (the stock counted by the owner)
  const openings = await db.select({ id: stockMovements.stockItemId, ts: stockMovements.ts }).from(stockMovements)
    .where(and(eq(stockMovements.refType, "opening"), gte(stockMovements.ts, begin), lte(stockMovements.ts, end)));
  const openAt = new Map(openings.map((o) => [o.id, o.ts]));
  const remaining = await Promise.all(stockRows.map(async (it) => ({ it, qty: await theoreticalAt(db, it.id, end), init: await theoreticalAt(db, it.id, openAt.get(it.id) ?? begin), counted: openAt.has(it.id) })));
  const total = rows.reduce((a, o) => a + o.totalMillimes, 0);
  const cash = rows.filter((o) => o.paymentType === "cash").reduce((a, o) => a + o.totalMillimes, 0);
  const tk = rows.filter((o) => o.paymentType === "ticket");
  const unp = rows.filter((o) => o.paymentType === "pending" || o.paymentType === "loss");
  const sum = (l: typeof rows) => l.reduce((a, o) => a + o.totalMillimes, 0);
  return (
    <main className="bg-white min-h-screen p-4 text-base" dir="rtl">
      <style>{`@page { size: A4; margin: 10mm; } @media print { .no-print { display: none !important; } }
        .pt tr { break-inside: avoid; } .pt th { background: #eee; } .pt td, .pt th { border: 1px solid #999; padding: 2px 6px; } .pt { border-collapse: collapse; width: 100%; }`}</style>
      <div className="no-print mb-3"><PrintButton /></div>
      <h1 className="text-xl font-bold">تقرير الشيفت — {day} {SHIFT_AR[shift]}</h1>
      <table className="pt my-3"><tbody>
        <tr><th>عدد الطلبات</th><td>{rows.length}</td><th>المجموع</th><td>{formatDT(total)}</td></tr>
        <tr><th>كاش مقبوض عن طلبات الشيفت</th><td>{formatDT(cash)}</td><th>تذاكر ({tk.length})</th><td>{formatDT(sum(tk))}</td></tr>
        <tr><th>غير مدفوع ({unp.length})</th><td>{formatDT(sum(unp))}</td><th></th><td></td></tr>
      </tbody></table>
      <h2 className="font-bold mt-3 mb-1">الكمية لكل منتج</h2>
      <table className="pt"><thead><tr><th>المنتج</th><th>الكمية</th><th>القيمة</th></tr></thead><tbody>
        {[...perProduct].sort((a, b) => b[1].qty - a[1].qty).map(([n, p]) => <tr key={n}><td>{n}</td><td>{p.qty}</td><td>{formatDT(p.value)}</td></tr>)}
      </tbody></table>
      <h2 className="font-bold mt-3 mb-1">المخزون: بداية الشيفت ونهايته (حسب النظام)</h2>
      <table className="pt"><thead><tr><th>الصنف</th><th>المخزون في البداية</th><th>المتبقي في النهاية</th></tr></thead><tbody>
        {remaining.map(({ it, qty, init, counted }) => <tr key={it.id}><td>{it.nameAr}</td><td dir="ltr" style={{ textAlign: "right" }}>{formatQty(it.kind as StockKind, init)}{counted ? " (جرد)" : ""}</td><td dir="ltr" style={{ textAlign: "right" }}>{formatQty(it.kind as StockKind, qty)}</td></tr>)}
      </tbody></table>
      <h2 className="font-bold mt-3 mb-1" style={{ breakBefore: "page" }}>الطلبات</h2>
      <table className="pt"><thead><tr><th>الوقت</th><th>الطلب</th><th>المحتوى</th><th>الدفع</th><th>المجموع</th></tr></thead><tbody>
        {rows.map((o) => (
          <tr key={o.id}><td dir="ltr">{formatTunis(o.effectiveTs)}</td><td>{o.orderLabel}</td>
            <td>{(byOrder.get(o.id) ?? []).map((i) => `${i.name} × ${i.qty}`).join("، ")}</td>
            <td>{PAY_AR[o.paymentType] ?? o.paymentType}</td><td>{formatDT(o.totalMillimes)}</td></tr>
        ))}
      </tbody></table>
    </main>
  );
}
