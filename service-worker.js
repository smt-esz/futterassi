// Bei jedem Deploy mit neuem App-Code diese Versionsnummer erhöhen.
// Sonst bleibt die alte, gecachte Version aktiv.
const CACHE_NAME = "futterassi-v16";

// Muss zum gleichnamigen Wert in app.js passen. Zwei Stellen, mehr nicht.
const DATA_FILE = "rezepte.json";

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  DATA_FILE,
  "icon-152.png",
  "icon-167.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Einzeln statt addAll: eine fehlende Datei darf nicht die komplette
    // Installation und damit den ganzen Offline-Betrieb kippen.
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Schriften und Fremdes laufen ungefiltert durch

  // Rezeptdaten: erst Netz, damit eine neue rezepte.json sofort ankommt,
  // sonst Cache. Nur gültige Antworten wandern in den Cache, ein 404 nicht.
  if (url.pathname.endsWith(DATA_FILE)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const clone = res.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, clone);
        }
        if (res && res.ok) return res;
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || res;
      } catch (err) {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || new Response(
          JSON.stringify({ fehler: "offline, keine gespeicherten Rezepte" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
    })());
    return;
  }

  // App-Shell: Cache zuerst, damit die App offline und schnell startet.
  // Es wird immer eine Antwort zurückgegeben, nie undefined.
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === "basic") {
        const clone = res.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(req, clone);
      }
      return res;
    } catch (err) {
      if (req.mode === "navigate") {
        const fallback = await caches.match("index.html");
        if (fallback) return fallback;
      }
      return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
  })());
});
