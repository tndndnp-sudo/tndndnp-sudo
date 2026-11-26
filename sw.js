const CACHE_NAME = 'svyaz-gryaz-shell-v7';
const SHELL = ['./', './index.html', './styles.css', './styles-extra.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png', './vendor/supabase-js.mjs'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.all(SHELL.map(path => cache.add(path).catch(() => null)))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('svyaz-gryaz-') && key !== CACHE_NAME).map(key => caches.delete(key))
  )));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('./index.html') || caches.match('./'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached => {
    if (cached) {
      fetch(request).then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      }).catch(() => {});
      return cached;
    }
    return fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match('./index.html'));
  }));
});

function notificationTarget(rawUrl) {
  const scopeUrl = new URL(self.registration.scope);
  const fallback = new URL('./', scopeUrl);
  if (!rawUrl) return fallback;
  try {
    const candidate = new URL(rawUrl, scopeUrl);
    if (candidate.origin === scopeUrl.origin && candidate.pathname.startsWith(scopeUrl.pathname)) return candidate;
  } catch { /* use the app root */ }
  return fallback;
}

self.addEventListener('push', event => {
  let payload = {};
  const raw = event.data ? event.data.text() : '';
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    payload = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { payload = { body: raw || 'У тебя новое сообщение.' }; }

  const title = typeof payload.title === 'string' ? payload.title.slice(0, 80) : 'Связь грязь';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : 'У тебя новое сообщение.';
  const target = notificationTarget(typeof payload.url === 'string' ? payload.url : './');
  const tag = typeof payload.tag === 'string' ? payload.tag.slice(0, 100) : 'svyaz-message';
  const options = {
    body,
    icon: new URL('./icon-192.png', self.registration.scope).href,
    badge: new URL('./icon-192.png', self.registration.scope).href,
    tag,
    renotify: false,
    data: { url: target.href },
    timestamp: Date.now()
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = notificationTarget(event.notification.data?.url).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const windowClient of windows) {
      if (!windowClient.url.startsWith(self.registration.scope)) continue;
      try {
        const navigatedClient = await windowClient.navigate(target);
        if (navigatedClient) return navigatedClient.focus();
      } catch { /* open a fresh app window below */ }
    }
    return self.clients.openWindow(target);
  })());
});
