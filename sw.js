const CACHE_NAME = 'jingcai-lab-v56';

const APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icon.svg',
  './js/app.js',
  './js/schema.js',
  './js/parse.js',
  './js/settlement.js',
  './js/csv.js',
  './js/db.js',
  './js/capabilities.js',
  './js/signal.js',
  './js/signal-stats.js',
  './js/implied.js',
  './js/poisson.js',
  './js/experimental.js',
  './js/stats.js',
  './js/edit.js',
  './js/legacy-adapter.js',
  './js/version.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML 走网络优先，避免部署后手机一直吃旧页面（包括第三方注入的脚本）。
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
