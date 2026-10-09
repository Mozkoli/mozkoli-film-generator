const CACHE_NAME = "mozkoli-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/mozkoli.svg",
  "/icons/mozkoli-180.png",
  "/icons/mozkoli-192.png",
  "/icons/mozkoli-512.png"
];
const APP_SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("mozkoli-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(new URL("/", self.location.origin).href, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(request)) ||
            (await cache.match(new URL("/", self.location.origin).href)) ||
            Response.error();
        })
    );
    return;
  }

  if (APP_SHELL_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(request)
        .then((cached) => cached || fetch(request))
    );
  }
});
