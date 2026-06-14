// Minimal service worker so the app is installable to the home screen.
// We intentionally do NOT cache API calls so estimates and history stay fresh.
const CACHE = "caloriesnap-v2";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API or uploaded images.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
