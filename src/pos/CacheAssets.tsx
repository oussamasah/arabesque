"use client";
import { useEffect } from "react";

/** Tells the service worker which static assets this page loaded, so the POS opens with no internet. */
export function CacheAssets() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const send = () => navigator.serviceWorker.ready.then((reg) => {
      const urls = performance.getEntriesByType("resource").map((e) => e.name)
        .filter((u) => u.startsWith(location.origin + "/_next/static/"));
      reg.active?.postMessage({ type: "cache-urls", urls: [...urls, location.origin + "/pos"] });
    }).catch(() => {});
    const t = setTimeout(send, 3000);
    return () => clearTimeout(t);
  }, []);
  return null;
}
