"use client";
/**
 * Instant feedback for every form (admin + login pages): the moment a form is submitted its buttons are
 * disabled, a progress bar and "جارٍ الحفظ…" appear, and a second click is ignored (no double actions).
 * Everything is cleared when the next page arrives.
 */
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function Inner() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [busy, setBusy] = useState<false | "form" | "nav">(false);

  // a new page (or a redirect with ?ok= / ?err=) means the action finished
  useEffect(() => {
    setBusy(false);
    document.querySelectorAll("form[data-submitting]").forEach((f) => {
      f.removeAttribute("data-submitting");
      f.querySelectorAll("button").forEach((b) => { if (b.dataset.autoDisabled) { b.disabled = false; delete b.dataset.autoDisabled; } });
    });
  }, [pathname, search]);

  useEffect(() => {
    const onSubmit = (e: Event) => {
      const form = e.target as HTMLFormElement;
      if (!(form instanceof HTMLFormElement)) return;
      // plain navigation forms (filters, search: action="/admin/…"): just show the bar
      if ((form.getAttribute("action") ?? "").startsWith("/")) { setBusy("nav"); return; }
      if (form.hasAttribute("data-submitting")) {
        // already sent: ignore extra clicks
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      form.setAttribute("data-submitting", "1");
      setBusy("form");
      // disable after the event has been dispatched so the submission itself is not affected
      setTimeout(() => {
        form.querySelectorAll("button").forEach((b) => { if (!b.disabled) { b.disabled = true; b.dataset.autoDisabled = "1"; } });
      }, 0);
    };
    // safety: never leave the page locked if something goes wrong
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onBusy = () => { clearTimeout(timer); timer = setTimeout(() => setBusy(false), 30_000); };
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("submit", onBusy, true);
    // links inside the app: show the bar immediately
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a");
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || a.target === "_blank") return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("/") && href !== location.pathname + location.search) { setBusy("nav"); onBusy(); }
    };
    document.addEventListener("click", onClick, true);
    // React resets a form when its action has finished; the form may also be replaced by the new render
    const done = (form?: Element | null) => {
      if (form) {
        form.removeAttribute("data-submitting");
        form.querySelectorAll("button").forEach((b) => { if (b.dataset.autoDisabled) { b.disabled = false; delete b.dataset.autoDisabled; } });
      }
      if (!document.querySelector("form[data-submitting]")) setBusy(false);
    };
    const onReset = (e: Event) => done(e.target as Element);
    document.addEventListener("reset", onReset, true);
    const poll = setInterval(() => {
      if (!document.querySelector("form[data-submitting]") && document.querySelector("[data-busy-form]")) setBusy(false);
    }, 400);
    return () => {
      document.removeEventListener("reset", onReset, true);
      clearInterval(poll);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("submit", onBusy, true);
      document.removeEventListener("click", onClick, true);
      clearTimeout(timer);
    };
  }, []);

  if (!busy) return null;
  return (
    <>
      <div className="fixed top-0 inset-x-0 h-1 z-[100] overflow-hidden bg-amber-100 no-print">
        <div className="h-full w-1/3 bg-[var(--brand)] animate-[busybar_1s_ease-in-out_infinite]" />
      </div>
      <div data-busy-form={busy === "form" ? "1" : undefined} className="fixed bottom-4 left-4 z-[100] rounded-full bg-[var(--brand)] text-white px-4 py-2 shadow-lg text-sm font-semibold no-print">
        جارٍ المعالجة…
      </div>
    </>
  );
}

export function FormFeedback() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
