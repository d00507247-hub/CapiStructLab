/*
 * sw.js: the service worker that lets the app install and work offline.
 *
 * Network first: every request goes to the network, so each change you merge
 * shows up. A fresh copy of each file is saved in the cache, and the cache is
 * used only when the network fails (for example, offline).
 *
 * Paths are relative, because the site lives at
 * https://<username>.github.io/<repository>/, not at the root of a domain.
 */
const CACHE = 'capstruct-v1';

const FILES = [
  './',
  'index.html',
  'styles.css',
  'capstruct.js',
  'app.js',
  'manifest.webmanifest',
  'data/assumptions.csv',
  'data/cdss.csv',
  'data/banker_schedule.csv',
  'data/example_firms.csv',
  'data/ebit_scenarios.csv',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Only this site's own files. The app makes no other requests.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(hit =>
          hit || (req.mode === 'navigate' ? caches.match('./') : Response.error())
        )
      )
  );
});
