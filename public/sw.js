// Service worker.
// - Mobile: makes SendLink installable (Android Share menu / Web Share Target) and opens the
//   /m app shell without network (cache-first, precached per build).
// - Desktop: lets "link received" notifications open the link when clicked.
// Never caches or intercepts /api/*: links and state always come from the live server.
const BUILD = '__SENDLINK_BUILD__'; // replaced at build time by a hash of the shell files
const SHELL_CACHE = `sendlink-shell-${BUILD}`;
const SHELL = ['/m', '/assets/mobile.js', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sendlink-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // The phone app, incl. Share Target launches (/m?text=…): serve the precached shell at once.
  // Cache-first on purpose: with Wi-Fi but no Internet, a network attempt can hang on DNS.
  if (request.mode === 'navigate') {
    if (url.pathname !== '/m' && url.pathname !== '/m/') return; // desktop pages: network as usual
    event.respondWith(caches.match('/m', { cacheName: SHELL_CACHE }).then((hit) => hit || fetch(request)));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName: SHELL_CACHE }).then((hit) => hit || fetch(request)));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Opening happens only on this explicit click. Re-validate: only http(s) links are ever opened.
  let url;
  try {
    url = new URL(event.notification.data && event.notification.data.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  event.waitUntil(self.clients.openWindow(url.href));
});
