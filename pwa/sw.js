// nagents PWA service worker — minimal, for installability + offline shell.
const CACHE_NAME = "nagents-pwa-v1";
const SHELL_FILES = [".", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API calls (/state, /config, etc) — always network
  if (url.pathname.startsWith("/state") || url.pathname.startsWith("/config") ||
      url.pathname.startsWith("/health") || url.pathname.startsWith("/cursor") ||
      url.pathname.startsWith("/event") || url.pathname.startsWith("/scan")) {
    return;
  }
  // Shell files — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
