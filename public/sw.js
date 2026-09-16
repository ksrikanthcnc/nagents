// nagents service worker — PWA installability + offline shell
const CACHE_NAME = "nagents-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API calls — always network, never cache
  if (url.port === "3335") return;
  if (url.pathname.startsWith("/state") || url.pathname.startsWith("/config") ||
      url.pathname.startsWith("/health") || url.pathname.startsWith("/cursor")) return;
  // Everything else — network first, cache fallback
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
