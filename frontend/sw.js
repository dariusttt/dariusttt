/* PetroKenya service worker — lets the installed app open without internet.
   App files are cached; /api calls always go to the network (records live on
   the server, the page keeps its own read-only copy for offline viewing).
   Bump VERSION whenever frontend files change so phones pick up the update. */
const VERSION = 'pk-v19';
const SHELL = [
  '/', '/index.html', '/css/styles.css?v=18', '/js/i18n.js?v=18', '/js/app.js?v=18', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Same-origin app files: network first (so updates show up), cache when offline
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(cache => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // Google Fonts: cache after first use
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(hit => hit || fetch(event.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(cache => cache.put(event.request, copy));
        return res;
      }))
    );
  }
});
