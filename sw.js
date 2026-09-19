// Caches the app shell so it starts offline. Data always goes over the
// network (Supabase) — this never touches anything outside our own origin,
// so RSVPs/organizer writes never get served stale from cache.
//
// Bump CACHE_NAME whenever a shell file's *content* changes; the old cache
// is dropped on activate.
const CACHE_NAME = "sapucaiu-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./db.js",
  "./config.js",
  "./manifest.webmanifest",
  "./assets/logo.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/caprasimo-latin.woff2",
  "./assets/caprasimo-latin-ext.woff2",
  "./assets/figtree-latin.woff2",
  "./assets/figtree-latin-ext.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Supabase (data) and esm.sh (the supabase-js module) stay untouched by
  // the cache — always go to the network, exactly like a page with no
  // service worker at all.
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp.clone()));
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
