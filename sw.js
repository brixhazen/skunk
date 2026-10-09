// Lets Skunk open without a connection. Network first, so updates show up
// right away when online; the cached copy is used only when offline.

const CACHE = "skunk";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icons/apple-touch-icon.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (ev) => ev.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (ev) => {
  if (ev.request.method !== "GET" || new URL(ev.request.url).origin !== location.origin) return;
  ev.respondWith(
    fetch(ev.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(ev.request, copy));
        return res;
      })
      .catch(() => caches.match(ev.request, { ignoreSearch: true }))
  );
});
