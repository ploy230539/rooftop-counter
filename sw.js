// Service Worker — Rooftop Counter PWA
const CACHE_NAME = 'rooftop-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './detector.js',
  './image-mode.js',
  './map-mode.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, fall back to cache
self.addEventListener('fetch', e => {
  // Skip non-GET and cross-origin tile requests
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // For external resources (Leaflet CDN, tiles, Nominatim) — network only
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Update cache with fresh version
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
