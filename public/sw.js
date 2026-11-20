/* Café POS service worker — makes the worker app (/pos) load with no internet. API calls are never cached. */
const CACHE = "cafe-pos-v2";
const SHELL = ["/pos", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// the page sends the list of already-loaded static assets so they are available offline
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-urls" && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((c) =>
        Promise.all(data.urls.filter((u) => typeof u === "string" && new URL(u).origin === self.location.origin)
          .map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {})))),
      ),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg" || url.pathname.startsWith("/products/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  if (req.mode === "navigate" && url.pathname.startsWith("/pos")) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/pos", copy)); }
        return res;
      }).catch(() => caches.match("/pos")),
    );
    return;
  }

  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});
