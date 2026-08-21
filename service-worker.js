// Bei jedem Deploy mit neuem App-Code diese Versionsnummer erhöhen.
// Sonst bleibt Nutzern die alte, gecachte Version erhalten.
const CACHE_NAME = "futterassi-v7";

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icon-152.png",
  "icon-167.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Rezeptdaten: erst Netz, damit Änderungen sofort ankommen, sonst Cache als Fallback.
  if (url.pathname.endsWith("rezepte.json")) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // App-Shell: Cache zuerst, damit die App auch offline und schnell startet.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
