importScripts('schedule.js');

const CACHE = 'svet-v2';
const SHELL = ['./', 'schedule.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
               ...['on', 'off', 'maybe'].flatMap(state => [`status-${state}.png`, `badge-${state}.png`])];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== PREFS).map(key => caches.delete(key))))
      .then(() => self.clients.claim()));
});

// App shell only: network first so a redeploy shows up, the cached copy when offline.
// The schedule request is cross-origin and stays with the page, which keeps its own last copy.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () =>
        (await caches.match(request, {ignoreSearch: true}))
        || (request.mode === 'navigate' && await caches.match('./'))
        || Response.error()));
});

// A push carries every queue's schedule, {days: {iso date: {queue: cells}}}; the status shown is the
// selected queue's. Every push must end in a notification, so one is shown even with no schedule.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let days = {};
    try { days = event.data.json().days; } catch {}
    const saved = await (await caches.open(PREFS)).match('queue');
    const queue = saved ? await saved.text() : '3.1';
    const notice = statusNotice(daysOf(days, queue), kyivNow());
    await self.registration.showNotification(notice.title, statusOptions(notice));
  })());
});

self.addEventListener('notificationclick', event => {
  // The status stays in the shade after a tap; an alert has done its job.
  if (event.notification.tag !== 'status') event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true})
      .then(windows => windows.length ? windows[0].focus() : self.clients.openWindow('./')));
});
