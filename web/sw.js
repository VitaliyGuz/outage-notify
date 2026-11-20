importScripts('schedule.js');

const CACHE = 'svet-v3';
const SHELL = ['./', 'schedule.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
               ...Object.values(NAMES).flatMap(state => [`status-${state}.png`, `badge-${state}.png`])];
const MAX_AGE_MS = 15 * 60e3;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== PREFS).map(key => caches.delete(key))))
      .then(() => self.clients.claim()));
});

// App shell only; cross-origin requests, the schedule among them, are not touched. Network first so
// a redeploy shows up whole, the cached copy when offline. (Answering from the cache whenever the
// network is merely slow would mix a new page with an old schedule.js after a deploy; so would the
// browser's own cache, which is why every file is checked with the server.)
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request, {cache: 'no-cache'})
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

// The schedule for the status: the copy the page or an earlier push left, loaded anew once it is
// older than MAX_AGE_MS, and the old copy again when the source cannot be reached.
async function schedule() {
  const copy = await prefsGet('schedule');
  if (copy && Date.now() - copy.fetchedAt < MAX_AGE_MS) return copy.days;
  try {
    const fresh = await fetchSchedule();
    await prefsPut('schedule', fresh);
    return fresh.days;
  } catch (e) {
    console.warn('schedule not loaded:', e);
    return copy?.days ?? {};
  }
}

// A push is only a nudge and carries nothing: the sender's servers cannot reach the source, the
// phone can, so the schedule is loaded here. Every push must end in a notification, so one is shown
// even without a schedule.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const [queue = DEFAULT_QUEUE, days] = await Promise.all([prefsGet('queue'), schedule()]);
    const notice = statusNotice(daysOf(days, queue), kyivNow());
    await self.registration.showNotification(notice.title, statusOptions(notice));
  })());
});

self.addEventListener('notificationclick', event => {
  // The status stays in the shade after a tap; an alert has done its job.
  if (event.notification.tag !== STATUS_TAG) event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true})
      .then(windows => windows.length ? windows[0].focus() : self.clients.openWindow('./')));
});
