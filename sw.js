const CACHE = "orderup-v9";
const ASSETS = ["./", "index.html", "style.css", "app.js", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// network-first: always try to get the latest file, only fall back to
// cache if the network request fails (e.g. offline). This way updates
// to index.html/style.css/app.js show up immediately on next reload.
//
// CRITICAL: only intercept same-origin requests. Firestore's realtime
// listener (onSnapshot) depends on a long-lived streaming connection to
// firestore.googleapis.com — if the service worker wraps that in
// respondWith(fetch(...)), it can silently break live updates, which is
// exactly what caused "posts don't show up until I manually refresh".
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // let cross-origin requests (Firestore, fonts, etc.) pass through untouched
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
