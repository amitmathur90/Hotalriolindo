// ITS POS service worker: caches the app shell so the POS can boot without internet.
// API data (catalog, customers, queued sales) is cached separately in IndexedDB by the POS.
const CACHE = 'its-pos-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/@') || url.pathname.includes('node_modules')) return;
  const key = e.request.mode === 'navigate' ? '/index.html' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
