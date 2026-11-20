"use client";
/**
 * Worker tablet app — "blind" POS (spec §10).
 * Never shows prices, totals, stock, ticket owner/value/type or reports. Prices are not even stored here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendEvent, getMeta, isTicketUsedLocally, listUnpaid, loadConfig, pendingCount, type DeviceConfig, type UnpaidOrder } from "./store";
import { checkTicketOnline, heartbeat, pair, pullConfig, pushPending, Unauthorized } from "./sync";
import { Scanner } from "./Scanner";
import { extractTicketToken, normaliseShortCode } from "@/lib/canonical";
import { sha256Hex } from "@/lib/sha256";

type Cart = Record<number, number>;
type Step = "cart" | "confirm" | "ticket" | "unpaid" | "pay";
type TicketState = { status: "idle" | "checking" | "valid" | "invalid"; tokenHash?: string; codeHash?: string };

const MAX_QTY = 99;
const MAX_LINES = 60;
const ADDONS = "إضافات";

export default function PosApp() {
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [cart, setCart] = useState<Cart>({});
  const [step, setStep] = useState<Step>("cart");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<{ title: string; label: string } | null>(null);
  const [unpaid, setUnpaid] = useState<UnpaidOrder[]>([]);
  const [payTarget, setPayTarget] = useState<UnpaidOrder | null>(null);
  const [tableRef, setTableRef] = useState("");
  const [unpaidQuery, setUnpaidQuery] = useState("");
  const [category, setCategory] = useState<string>("__all");
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(12);
  const [ticket, setTicket] = useState<TicketState>({ status: "idle" });
  const [codeInput, setCodeInput] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const backoff = useRef(5000);
  const syncing = useRef(false);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    (async () => {
      try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
      const meta = await getMeta();
      setPaired(!!meta.device_key);
      setDeviceName(meta.device_name ?? "");
      setConfig((await loadConfig()) ?? null);
      setPending(await pendingCount());
      setOnline(navigator.onLine);
      setReady(true);
    })();
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); document.removeEventListener("contextmenu", block); };
  }, []);

  // ---------------------------------------------------------------- layout: page size without scrolling
  useEffect(() => {
    const calc = () => {
      const cols = Math.max(2, Math.floor((window.innerWidth - 32) / 180));
      const rows = Math.max(2, Math.floor((window.innerHeight - 250) / 175));
      setPerPage(cols * rows);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  // ---------------------------------------------------------------- sync loop (5 s → 5 min backoff), config every 60 s
  const syncNow = useCallback(async () => {
    if (syncing.current || !paired) return;
    syncing.current = true;
    try {
      const left = await pushPending();
      setPending(left);
      setOnline(true);
      backoff.current = 5000;
    } catch (e) {
      if (e instanceof Unauthorized) setUnauthorized(true);
      setOnline(false);
      // retry quickly: on Android the "online" event often never fires when Wi-Fi stays connected
      backoff.current = Math.min(backoff.current * 2, 30_000);
      setPending(await pendingCount());
    } finally {
      syncing.current = false;
    }
  }, [paired]);

  const refreshConfig = useCallback(async () => {
    if (!paired) return;
    try {
      const cfg = await pullConfig();
      setConfig(cfg);
      // warm the service-worker cache so product images show with no internet
      for (const p of cfg.products) if (p.image) fetch(p.image).catch(() => {});
      setDeviceName(cfg.device_name);
      setUnauthorized(false);
      setOnline(true);
    } catch (e) {
      if (e instanceof Unauthorized) setUnauthorized(true);
      else setOnline(false);
    }
  }, [paired]);

  useEffect(() => {
    if (!paired) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await syncNow();
      if (!stop) t = setTimeout(loop, (await pendingCount()) ? backoff.current : Math.max(backoff.current, 15_000));
    };
    void refreshConfig().then(loop);
    const cfgTimer = setInterval(refreshConfig, 60_000);
    const hbTimer = setInterval(() => { void heartbeat(); }, 5 * 60_000);
    const vis = () => { if (document.visibilityState === "visible") { void refreshConfig(); void syncNow(); } };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", vis);
    return () => { stop = true; clearTimeout(t); clearInterval(cfgTimer); clearInterval(hbTimer); document.removeEventListener("visibilitychange", vis); window.removeEventListener("online", vis); };
  }, [paired, syncNow, refreshConfig]);

  const refreshUnpaid = useCallback(async () => {
    try { setUnpaid(await listUnpaid(config?.open_orders, config?.open_order_details)); } catch { /* ignore */ }
  }, [config]);
  useEffect(() => { if (paired) void refreshUnpaid(); }, [paired, refreshUnpaid]);

  // ---------------------------------------------------------------- catalogue
  const products = useMemo(() => (config?.products ?? []).slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id), [config]);
  // products in the "إضافات" (add-ons) category, e.g. the take-away cup, appear in every category tab, at the end
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter((c) => c && c !== ADDONS))] as string[], [products]);
  const visible = useMemo(() => {
    if (category === "__all") return products;
    return [...products.filter((p) => p.category === category), ...products.filter((p) => p.category === ADDONS)];
  }, [products, category]);
  const pages = Math.max(1, Math.ceil(visible.length / perPage));
  const pageItems = visible.slice(page * perPage, page * perPage + perPage);
  useEffect(() => { if (page >= pages) setPage(0); }, [pages, page]);

  const itemCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([id, q]) => ({ product: products.find((p) => p.id === Number(id)), qty: q }));

  const add = (id: number) => setCart((c) => {
    if (!c[id] && Object.keys(c).length >= MAX_LINES) return c;
    return { ...c, [id]: Math.min(MAX_QTY, (c[id] ?? 0) + 1) };
  });
  const sub = (id: number) => setCart((c) => {
    const n = (c[id] ?? 0) - 1;
    const next = { ...c };
    if (n <= 0) delete next[id]; else next[id] = n;
    return next;
  });
  const clear = () => { setCart({}); setStep("cart"); setTicket({ status: "idle" }); setCodeInput(""); setTableRef(""); setPayTarget(null); };
  const labelOf = (seq: number) => `${deviceName || "T"}-${String(seq).padStart(4, "0")}`;
  const flash = (title: string, label: string) => { setSuccess({ title, label }); setTimeout(() => setSuccess(null), 1600); };

  // ---------------------------------------------------------------- order recording
  /** New order: paid now (cash / ticket) or "later" (appears in the unpaid list until paid). */
  const record = async (payment: "cash" | "ticket" | "later", t?: TicketState) => {
    if (busy || !itemCount) return;
    setBusy(true);
    try {
      const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, q]) => ({ product_id: Number(id), qty: q }));
      const ref = tableRef.trim().slice(0, 20);
      const ev = await appendEvent("order.create", {
        items, payment,
        ...(payment === "later" && ref ? { table_ref: ref } : {}),
        ...(payment === "ticket" && t?.tokenHash ? { ticket_token_hash: t.tokenHash } : {}),
        ...(payment === "ticket" && t?.codeHash ? { ticket_code_hash: t.codeHash } : {}),
      });
      clear();
      flash(payment === "later" ? "تم تسجيل الطلب — الدفع لاحقاً" : "تم تسجيل الطلب", labelOf(ev.seq));
      setPending(await pendingCount());
      void refreshUnpaid();
      void syncNow();
    } catch {
      alert("خطأ في الحفظ — أعد المحاولة");
    } finally {
      setBusy(false);
    }
  };

  /** Pay an order from the unpaid list. */
  const pay = async (payment: "cash" | "ticket", t?: TicketState) => {
    if (busy || !payTarget) return;
    setBusy(true);
    try {
      await appendEvent("order.pay", {
        order_id: payTarget.id, payment,
        ...(payment === "ticket" && t?.tokenHash ? { ticket_token_hash: t.tokenHash } : {}),
        ...(payment === "ticket" && t?.codeHash ? { ticket_code_hash: t.codeHash } : {}),
      });
      const label = (payTarget.label ?? labelOf(payTarget.seq));
      setPayTarget(null); setStep("cart"); setTicket({ status: "idle" }); setCodeInput("");
      flash("تم الدفع ✓", label);
      setPending(await pendingCount());
      void refreshUnpaid();
      void syncNow();
    } catch {
      alert("خطأ في الحفظ — أعد المحاولة");
    } finally {
      setBusy(false);
    }
  };

  const validateTicket = async (h: { token_hash?: string; code_hash?: string }) => {
    setTicket({ status: "checking" });
    const hash = h.token_hash ?? h.code_hash!;
    let valid: boolean;
    const online = await checkTicketOnline(h);
    if (online === null) {
      const list = h.token_hash ? config?.valid_tickets.token_hashes : config?.valid_tickets.code_hashes;
      valid = !!list?.includes(hash) && !(await isTicketUsedLocally(hash));
    } else {
      valid = online && !(await isTicketUsedLocally(hash));
    }
    setTicket(valid ? { status: "valid", tokenHash: h.token_hash, codeHash: h.code_hash } : { status: "invalid" });
  };

  const onScan = useCallback((text: string) => {
    const token = extractTicketToken(text);
    void validateTicket({ token_hash: sha256Hex(token) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const onCode = () => {
    const code = normaliseShortCode(codeInput);
    if (code.length < 6) return;
    void validateTicket({ code_hash: sha256Hex(code) });
  };

  // ---------------------------------------------------------------- screens
  if (!ready) return <div className="pos-root flex items-center justify-center text-3xl">…</div>;
  if (!paired || unauthorized) return <PairScreen revoked={unauthorized} onPaired={async () => { setUnauthorized(false); setPaired(true); const m = await getMeta(); setDeviceName(m.device_name ?? ""); }} />;
  if (!config) {
    return (
      <div className="pos-root flex flex-col items-center justify-center gap-6 p-8 text-center">
        <p className="text-3xl font-bold">يجب الاتصال بالإنترنت مرة أولى لتحميل المنتجات</p>
        <button className="pos-btn bg-[var(--brand)] text-white px-10" onClick={refreshConfig}>إعادة المحاولة</button>
      </div>
    );
  }

  return (
    <div className="pos-root flex flex-col">
      {/* header */}
      <header className="flex items-center justify-between px-4 py-2 bg-[var(--brand)] text-white">
        <div className="text-xl font-bold">{config.business_name}</div>
        <div className="flex items-center gap-4 text-lg">
          <span className="flex items-center gap-2">
            <span className={`inline-block w-4 h-4 rounded-full ${online ? "bg-green-400" : "bg-red-500"}`} />
            {online ? "متصل" : "بدون إنترنت — الطلبات محفوظة"}
          </span>
          {pending > 0 && (
            <button onClick={() => { backoff.current = 5000; void syncNow(); }} className="bg-white/20 rounded-full px-3 py-1" title="مزامنة الآن">
              في الانتظار: {pending} ⟳
            </button>
          )}
          <button onClick={() => { void refreshUnpaid(); setStep("unpaid"); }} data-testid="unpaid-btn"
            className={`rounded-full px-4 py-2 font-bold ${unpaid.length ? "bg-yellow-300 text-black" : "bg-white/20"}`}>
            غير مدفوعة: {unpaid.length}
          </button>
          <span className="opacity-70">{deviceName}</span>
        </div>
      </header>

      {/* categories */}
      {categories.length > 0 && (
        <nav className="flex gap-2 px-4 py-2 overflow-x-auto">
          {[["__all", "الكل"], ...categories.map((c) => [c, c])].map(([k, label]) => (
            <button key={k} onClick={() => { setCategory(k); setPage(0); }}
              className={`pos-chip ${category === k ? "bg-[var(--brand)] text-white" : "bg-white text-[var(--ink)]"}`}>{label}</button>
          ))}
        </nav>
      )}

      {/* product grid */}
      <main className="flex-1 px-4 py-2 overflow-hidden">
        <div className="grid gap-3 h-full content-start" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))" }}>
          {pageItems.map((p) => {
            const q = cart[p.id] ?? 0;
            return (
              <div key={p.id} className="relative">
                <button onClick={() => add(p.id)} data-testid={`tile-${p.id}`}
                  className="pos-tile w-full flex-col gap-1" style={{ background: p.color || "#7c4a2d" }}>
                  {p.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt="" draggable={false} className="w-20 h-20 rounded-2xl bg-white/95 p-1 pointer-events-none" />
                  )}
                  <span className="text-2xl font-bold leading-tight drop-shadow">{p.name_ar}</span>
                </button>
                {q > 0 && (
                  <>
                    <span className="absolute -top-2 -left-2 min-w-12 h-12 px-2 rounded-full bg-yellow-300 text-black text-2xl font-black flex items-center justify-center shadow">{q}</span>
                    <button onClick={() => sub(p.id)} aria-label="إنقاص"
                      className="absolute -bottom-2 -left-2 w-14 h-14 rounded-full bg-white text-black text-4xl font-black shadow flex items-center justify-center">−</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </main>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-4 pb-1">
          <button className="pos-chip bg-white" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>→ السابق</button>
          <span className="text-xl">{page + 1} / {pages}</span>
          <button className="pos-chip bg-white" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>التالي ←</button>
        </div>
      )}

      {/* bottom bar: item count only, never an amount */}
      <footer className="flex gap-3 p-3 bg-white border-t">
        <button className="pos-btn bg-gray-200 text-gray-800 flex-1" onClick={clear} disabled={!itemCount}>مسح الكل</button>
        <button className="pos-btn bg-[var(--brand)] text-white flex-[2]" disabled={!itemCount} onClick={() => setStep("confirm")}>
          تأكيد الطلب {itemCount > 0 && <span className="opacity-80">· {itemCount} عناصر</span>}
        </button>
      </footer>

      {/* confirm */}
      {step === "confirm" && (
        <Modal>
          <h2 className="text-3xl font-bold mb-4">تأكيد الطلب</h2>
          <ul className="text-2xl space-y-2 max-h-[40vh] overflow-auto mb-4">
            {lines.map((l) => (
              <li key={l.product?.id} className="flex justify-between border-b pb-2"><span>{l.product?.name_ar ?? "?"}</span><span className="font-black">× {l.qty}</span></li>
            ))}
          </ul>
          <p className="bg-amber-100 text-amber-900 rounded-xl p-3 text-xl font-bold mb-4">⚠️ تأكد من الطلب — لا يمكن إلغاؤه بعد التأكيد</p>
          <input value={tableRef} onChange={(e) => setTableRef(e.target.value)} maxLength={20} autoComplete="off"
            placeholder="الطاولة / اسم الزبون (اختياري)" className="w-full text-2xl border-2 rounded-xl p-3 mb-3" />
          <button className="pos-btn bg-amber-500 text-white w-full mb-3" disabled={busy} onClick={() => record("later")}>الدفع لاحقاً</button>
          <div className="grid grid-cols-2 gap-3">
            <button className="pos-btn bg-green-600 text-white" disabled={busy} onClick={() => record("cash")}>كاش الآن</button>
            <button className="pos-btn bg-indigo-600 text-white" disabled={busy} onClick={() => { setPayTarget(null); setTicket({ status: "idle" }); setCodeInput(""); setStep("ticket"); }}>تذكرة الآن</button>
          </div>
          <button className="pos-btn bg-gray-200 text-gray-800 w-full mt-3" onClick={() => setStep("cart")}>رجوع</button>
        </Modal>
      )}

      {/* ticket */}
      {step === "ticket" && (
        <Modal>
          <h2 className="text-3xl font-bold mb-3">تذكرة</h2>
          {ticket.status === "idle" && (
            <>
              <Scanner onResult={onScan} />
              <div className="flex gap-2 mt-3">
                <input value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="أو اكتب الرمز"
                  className="flex-1 text-3xl tracking-widest text-center border-2 rounded-xl p-3" dir="ltr" maxLength={12} autoCapitalize="characters" autoComplete="off" />
                <button className="pos-btn bg-indigo-600 text-white px-6" onClick={onCode}>تحقق</button>
              </div>
            </>
          )}
          {ticket.status === "checking" && <p className="text-3xl text-center py-10">… جارٍ التحقق</p>}
          {ticket.status === "valid" && (
            <div className="text-center py-6">
              <p className="text-5xl text-green-600 font-black mb-6">✓ تذكرة صالحة</p>
              <button className="pos-btn bg-green-600 text-white w-full" disabled={busy}
                onClick={() => (payTarget ? pay("ticket", ticket) : record("ticket", ticket))}>{payTarget ? "تسجيل الدفع" : "تسجيل الطلب"}</button>
            </div>
          )}
          {ticket.status === "invalid" && (
            <div className="text-center py-6">
              <p className="text-5xl text-red-600 font-black mb-6">✗ التذكرة غير صالحة</p>
              <button className="pos-btn bg-gray-700 text-white w-full" onClick={() => { setTicket({ status: "idle" }); setCodeInput(""); }}>إعادة المحاولة</button>
            </div>
          )}
          <button className="pos-btn bg-gray-200 text-gray-800 w-full mt-3" onClick={() => setStep(payTarget ? "pay" : "confirm")}>رجوع</button>
        </Modal>
      )}

      {/* unpaid orders: served, waiting for payment (no amounts shown) */}
      {step === "unpaid" && (() => {
        // start of the current shift (tablet local time = Tunis): older orders belong to a previous shift → owed by its worker
        const now = new Date();
        const { morning_start_hour: m, evening_start_hour: e } = config.settings;
        const start = new Date(now);
        if (now.getHours() >= m && now.getHours() < e) start.setHours(m, 0, 0, 0);
        else { start.setHours(e, 0, 0, 0); if (now.getHours() < m) start.setDate(start.getDate() - 1); }
        const q = unpaidQuery.trim();
        const list = unpaid.filter((o) => !q || (o.table_ref ?? "").includes(q) || (o.label ?? labelOf(o.seq)).includes(q));
        const old = unpaid.filter((o) => o.created_at < start.getTime()).length;
        return (
          <div className="fixed inset-0 z-40 bg-[var(--paper)] flex flex-col">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-[var(--brand)] text-white">
              <h2 className="text-3xl font-bold">غير مدفوعة ({unpaid.length})</h2>
              {old > 0 && <span className="bg-red-600 rounded-full px-4 py-1 text-xl font-bold">{old} من شيفت سابق</span>}
              <input value={unpaidQuery} onChange={(ev) => setUnpaidQuery(ev.target.value)} placeholder="بحث: طاولة / اسم" autoComplete="off"
                className="flex-1 min-w-48 text-2xl rounded-xl px-4 py-2 bg-white text-black" />
              <button className="pos-btn bg-white text-[var(--brand)] px-8" onClick={() => { setUnpaidQuery(""); setStep("cart"); }}>رجوع</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {list.length === 0 ? <p className="text-3xl text-gray-500 text-center py-16">{unpaid.length ? "لا نتيجة" : "لا توجد طلبات غير مدفوعة ✓"}</p> : (
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}>
                  {list.map((o) => {
                    const prev = o.created_at < start.getTime();
                    return (
                      <button key={o.id} onClick={() => { setPayTarget(o); setStep("pay"); }}
                        className={`text-right bg-white rounded-2xl p-3 border-4 shadow-sm active:scale-[.98] flex flex-col gap-1 ${prev ? "border-red-500" : "border-transparent"}`}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-2xl font-black truncate">{o.table_ref || (o.label ?? labelOf(o.seq))}</span>
                          <span className="text-lg text-gray-500 shrink-0" dir="ltr">{new Date(o.created_at).toLocaleTimeString("fr-TN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                        </div>
                        {prev && <span className="self-start bg-red-100 text-red-700 rounded-full px-3 text-base font-bold">شيفت سابق — على العامل</span>}
                        <div className="text-lg leading-snug">{o.items.map((it) => `${products.find((p) => p.id === it.product_id)?.name_ar ?? "?"} × ${it.qty}`).join("، ")}</div>
                        <span className="mt-auto pt-2 text-center bg-green-600 text-white rounded-xl py-2 text-2xl font-black">دفع</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {step === "pay" && payTarget && (
        <Modal>
          <h2 className="text-3xl font-bold mb-2">دفع {payTarget.table_ref || (payTarget.label ?? labelOf(payTarget.seq))}</h2>
          <ul className="text-2xl space-y-1 mb-4">
            {payTarget.items.map((it) => (
              <li key={it.product_id} className="flex justify-between border-b pb-1"><span>{products.find((p) => p.id === it.product_id)?.name_ar ?? "?"}</span><span className="font-black">× {it.qty}</span></li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3">
            <button className="pos-btn bg-green-600 text-white" disabled={busy} onClick={() => pay("cash")}>كاش</button>
            <button className="pos-btn bg-indigo-600 text-white" disabled={busy} onClick={() => { setTicket({ status: "idle" }); setCodeInput(""); setStep("ticket"); }}>تذكرة</button>
          </div>
          <button className="pos-btn bg-gray-200 text-gray-800 w-full mt-3" onClick={() => { setPayTarget(null); setStep("unpaid"); }}>رجوع للقائمة</button>
        </Modal>
      )}

      {success && (
        <div className="fixed inset-0 bg-green-600 text-white flex flex-col items-center justify-center z-50" data-testid="success">
          <div className="text-[9rem] leading-none">✓</div>
          <div className="text-4xl font-bold mt-4">{success.title}</div>
          <div className="text-5xl font-black mt-3" dir="ltr">{success.label}</div>
        </div>
      )}
    </div>
  );
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-2xl max-h-[95vh] overflow-auto">{children}</div>
    </div>
  );
}

function PairScreen({ onPaired, revoked }: { onPaired: () => void; revoked: boolean }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await pair(code); onPaired(); } catch { setErr("رمز غير صالح أو منتهي"); } finally { setBusy(false); }
  };
  const press = (d: string) => setCode((c) => (d === "⌫" ? c.slice(0, -1) : c.length < 8 ? c + d : c));
  return (
    <div className="pos-root flex flex-col items-center justify-center gap-5 p-6">
      <h1 className="text-4xl font-bold">ربط الجهاز</h1>
      {revoked && <p className="text-xl text-red-700 font-bold">تم إلغاء ربط هذا الجهاز. اطلب رمزاً جديداً من صاحب المقهى.</p>}
      <p className="text-xl text-gray-600">أدخل رمز الربط (8 أرقام) من لوحة الإدارة</p>
      <div className="text-5xl tracking-[0.4em] font-mono bg-white rounded-2xl px-8 py-4 min-w-80 text-center" dir="ltr">{code.padEnd(8, "•")}</div>
      <div className="grid grid-cols-3 gap-3" dir="ltr">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"].map((d) => (
          <button key={d} className="w-24 h-20 text-4xl rounded-2xl bg-white shadow font-bold disabled:opacity-40"
            disabled={busy || (d === "✓" && code.length !== 8)} onClick={() => (d === "✓" ? submit() : press(d))}>{d}</button>
        ))}
      </div>
      {err && <p className="text-2xl text-red-600">{err}</p>}
    </div>
  );
}
