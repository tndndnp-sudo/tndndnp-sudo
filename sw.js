/* самый скучный сервис-воркер на свете: закешировать файлы панели, чтобы
   работало даже когда в школе ловит только «нет интернета».
   версия bumped-ится вручную при правках — кэш меняем вместе с ней. */
const V = 'panel-v1';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/ui.js', 'js/study.js',
  'js/play.js', 'js/life.js', 'js/about.js', 'js/util.js', 'js/data.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// сеть в приоритете, кэш как страховка
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(V).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
