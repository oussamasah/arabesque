import Link from "next/link";
import { formatDT } from "@/lib/money";

export type SP = Promise<Record<string, string | string[] | undefined>>;

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const ok = one(sp.ok), err = one(sp.err);
  if (!ok && !err) return null;
  return (
    <div className={`rounded-xl px-4 py-3 mb-4 font-semibold ${err ? "bg-red-50 text-red-800 border border-red-200" : "bg-green-50 text-green-800 border border-green-200"}`}>
      {err ?? ok}
    </div>
  );
}

export function PageTitle({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
      <div>
        <h1 className="h1">{title}</h1>
        {sub && <p className="muted text-sm mt-1">{sub}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function Money({ m, className = "" }: { m: number | string | null | undefined; className?: string }) {
  const n = m === null || m === undefined ? null : Number(m);
  return <span className={`num ${n !== null && n < 0 ? "text-red-700" : ""} ${className}`}>{formatDT(n)}</span>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "good" | "bad" | "warn" }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "";
  return (
    <div className="card">
      <div className="muted text-sm">{label}</div>
      <div className={`text-xl font-bold mt-1 ${c}`}>{value}</div>
      {hint && <div className="muted text-xs mt-1">{hint}</div>}
    </div>
  );
}

export function Back({ value }: { value: string }) {
  return <input type="hidden" name="_back" value={value} />;
}

export function RiskDot({ color }: { color: "green" | "yellow" | "red" }) {
  const bg = color === "green" ? "#16a34a" : color === "yellow" ? "#f59e0b" : "#dc2626";
  const label = color === "green" ? "عادي" : color === "yellow" ? "يحتاج انتباه" : "يحتاج مراجعة";
  return <span className="inline-flex items-center gap-1"><span className="dot" style={{ background: bg }} />{label}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="muted text-center py-8">{children}</div>;
}

export function RangeForm({ from, to, action, extra }: { from: string; to: string; action: string; extra?: React.ReactNode }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 no-print">
      <label><span className="lbl">من</span><input className="inp" type="date" name="from" defaultValue={from} /></label>
      <label><span className="lbl">إلى</span><input className="inp" type="date" name="to" defaultValue={to} /></label>
      {extra}
      <button className="btn">عرض</button>
    </form>
  );
}

export function Pager({ page, hasMore, base }: { page: number; hasMore: boolean; base: string }) {
  const sep = base.includes("?") ? "&" : "?";
  return (
    <div className="flex gap-2 justify-center mt-4">
      {page > 1 && <Link className="btn btn-ghost btn-sm" href={`${base}${sep}page=${page - 1}`}>→ السابق</Link>}
      <span className="muted text-sm self-center">صفحة {page}</span>
      {hasMore && <Link className="btn btn-ghost btn-sm" href={`${base}${sep}page=${page + 1}`}>التالي ←</Link>}
    </div>
  );
}

export const FLAG_AR: Record<string, string> = {
  late_sync: "مزامنة متأخرة", clock_skew: "فرق ساعة", future_ts: "وقت مستقبلي", ticket_conflict: "تعارض تذكرة",
  over_ticket_limit: "تجاوز سقف", ticket_invalid: "تذكرة غير صالحة", chain_broken: "سلسلة مكسورة",
  sequence_gap: "فجوة تسلسل", inactive_product: "منتج غير مفعّل", no_price: "بدون سعر", manual: "يدوي",
  paid_other_shift: "دُفع في شيفت آخر", unpaid_loss: "خرج دون دفع", manual_payment: "دفع مسجّل يدوياً", paid_to_owner: "دُفع للمالك", paid_by_worker: "دفعه العامل",
};

export const STATUS_AR: Record<string, string> = { ok: "مقبول", void: "ملغى", pending_review: "يحتاج مراجعة" };

export const PAYMENT_AR: Record<string, string> = { cash: "كاش", ticket: "تذكرة", pending: "غير مدفوع", loss: "خرج دون دفع" };

export function PaymentBadge({ type }: { type: string }) {
  const cls = type === "cash" ? "" : type === "ticket" ? "badge badge-blue" : type === "pending" ? "badge badge-yellow" : "badge badge-red";
  return <span className={cls}>{PAYMENT_AR[type] ?? type}</span>;
}

/** Small "cancel / delete with a reason" control: opens inline, asks for a reason, then submits. */
export function CancelForm({ action, back, id, label = "إلغاء", confirm = "تأكيد", withReason = true, idName = "id" }: {
  action: (fd: FormData) => Promise<void>; back: string; id: string | number; label?: string; confirm?: string; withReason?: boolean; idName?: string;
}) {
  return (
    <details className="inline-block align-middle">
      <summary className="btn btn-ghost btn-sm list-none cursor-pointer text-red-700">{label}</summary>
      <form action={action} className="flex flex-wrap gap-1 mt-1 items-center">
        <input type="hidden" name="_back" value={back} />
        <input type="hidden" name={idName} value={String(id)} />
        {withReason && <input name="reason" required placeholder="السبب" className="inp w-40 py-1 text-sm" />}
        <button className="btn btn-danger btn-sm">{confirm}</button>
      </form>
    </details>
  );
}
