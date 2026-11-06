// DISPOSABLE SPIKE service worker: offline app shell only.
// - Same-origin requests: cache-first (navigations, incl. Share Target "/?text=…", get index.html).
// - Cross-origin requests (the LAN agent) are NOT intercepted: the page's fetch goes straight to the network.
const VERSION = 'lan-spike-v1';
const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // never touch agent requests
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/index.html').then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
