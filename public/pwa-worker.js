const scope = new URL(self.registration.scope);
const cachePrefix = `griipbuddy-icons:${scope.pathname}:`;
const cacheName = cachePrefix + "1";
const icons = [192, 512].map(size => new URL(`pwa/icon-${size}.png`, scope).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(icons)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith(cachePrefix) && name !== cacheName)
    .map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (icons.includes(request.url)) {
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(request)) || fetch(request)));
    return;
  }

  if (request.mode !== "navigate" || url.pathname.slice(scope.pathname.length).startsWith("api/")) return;
  event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You’re offline · GriipBuddy</title><main><h1>You’re offline</h1><p>Reconnect to open GriipBuddy and confirm current prices, availability or order status.</p></main></html>',
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } },
  )));
});
