"use client";
/** Admin-only product picker: shows each product's current price and the order total while typing quantities. */
import { useMemo, useState } from "react";

export interface PickerProduct { id: number; name: string; category: string | null; price: number | null }

const fmt = (m: number) => `${(m / 1000).toFixed(3)} DT`;

export function OrderItemsPicker({ products, initial = {} }: { products: PickerProduct[]; initial?: Record<number, number> }) {
  const [qty, setQty] = useState<Record<number, number>>(initial);
  const { total, count, missing } = useMemo(() => {
    let total = 0, count = 0, missing = 0;
    for (const p of products) {
      const q = qty[p.id] ?? 0;
      if (q > 0) { count += q; if (p.price === null) missing++; else total += p.price * q; }
    }
    return { total, count, missing };
  }, [qty, products]);
  const clamp = (v: number) => Math.max(0, Math.min(99, Number.isFinite(v) ? v : 0));
  const set = (id: number, v: number) => setQty((c) => ({ ...c, [id]: clamp(v) }));
  // +/- read the latest state, so fast repeated clicks all count
  const add = (id: number, d: number) => setQty((c) => ({ ...c, [id]: clamp((c[id] ?? 0) + d) }));

  return (
    <div className="space-y-2">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {products.map((p) => {
          const q = qty[p.id] ?? 0;
          return (
            <div key={p.id} className={`flex items-center justify-between gap-2 border rounded-lg p-2 ${q > 0 ? "border-[var(--brand)] bg-[#fbf6f0]" : ""}`}>
              <div className="min-w-0">
                <div className="font-semibold truncate">{p.name}</div>
                <div className="text-xs num">{p.price === null ? <span className="text-red-700">بدون سعر</span> : fmt(p.price)}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" className="btn btn-ghost btn-sm w-8" onClick={() => add(p.id, -1)} aria-label="إنقاص">−</button>
                <input className="inp w-14 text-center py-1" type="number" min={0} max={99} name={`qty_${p.id}`}
                  value={q || ""} placeholder="0" onChange={(e) => set(p.id, Number(e.target.value))} />
                <button type="button" className="btn btn-ghost btn-sm w-8" onClick={() => add(p.id, 1)} aria-label="زيادة">+</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="sticky bottom-0 bg-white border rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 shadow-sm">
        <span>{count} منتجات</span>
        <span className="text-xl font-black num">المجموع: {fmt(total)}</span>
        {missing > 0 && <span className="text-red-700 text-sm">{missing} منتج بدون سعر</span>}
      </div>
    </div>
  );
}
