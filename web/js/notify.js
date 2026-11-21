// The two notifications: an alert a quarter of an hour before an outage, while the page is open,
// and the status kept in the shade, which the worker's pushes renew when it is not (sw.js,
// worker/). Uses schedule.js, base.js, timeline.js, i18n.js and the page's state in app.js.

// The status push: the public half of the key pair it is signed with, and the worker that keeps the
// list of devices to nudge (worker/).
const VAPID_PUBLIC_KEY = 'BF5-2NY2Un22wD8YqqqAabhGnaqdK_Sk1XVRjV-ieRhI13UnxteOVpwOKYbF8JRmwVJLE3ifQpRU1EAxqDAsUQU';
const PUSH_API = 'https://outage-notify.vitaliy-guz.workers.dev';
const LEAD_MIN = 15;

// The alert due right now, if the power goes off within LEAD_MIN.
function dueAlert(days, now, queue) {
  if (!days[now.date]) return null;
  const at = timeline(days, now.date), p = period(at, Math.floor(now.minutes / 30));
  const wait = p.end * 30 - now.minutes;
  if (!p.lit || p.openEnd || wait > LEAD_MIN) return null;
  const outage = period(at, p.end), from = stamp(outage.start);
  const tail = outage.delayed ? ` ${sentence(T.mayBeDelayed(stamp(outage.late, true).time))}` : '';
  return {
    key: `${queue} ${shiftDate(now.date, Math.floor(outage.start / SLOTS))} ${from.time}`,
    title: T.alertTitle(span(wait)),
    body: T.alertBody(queue, from.time, stamp(outage.end, true).time) + tail,
  };
}

const canNotify = 'Notification' in window && 'serviceWorker' in navigator;
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const notifyOn = () => canNotify && Notification.permission === 'granted' && store.get('notify', false);
const canPush = canNotify && 'PushManager' in window;
const statusOn = () => canPush && Notification.permission === 'granted' && store.get('status', false);
let pushFailed = false;
let statusShown = '';

function renderNotify() {
  const blocked = canNotify && Notification.permission === 'denied';
  $('notify').hidden = !canNotify || blocked;
  $('notify').textContent = notifyOn() ? T.notifyOff : T.notifyOn;
  $('notify-hint').textContent = blocked ? T.notifyBlocked : canNotify ? T.notifyHint(LEAD_MIN)
    : isIos ? T.notifyIos : T.notifyUnsupported;

  $('status').hidden = !canPush || blocked;
  $('status').textContent = statusOn() ? T.statusOff : T.statusOn;
  $('status-hint').textContent = !canPush || blocked ? ''
    : pushFailed ? T.pushFailed : statusOn() ? T.statusHintOn : T.statusHintOff;
}

// What the browser tells of the device it runs on: the system, the browser and, where it gives it,
// the model. Empty where it has no such thing to ask (Safari, Firefox); the worker then has only
// the request's User-Agent to go by.
async function deviceName() {
  const ua = navigator.userAgentData;
  if (!ua) return '';
  const {platformVersion, model} = await ua.getHighEntropyValues(['platformVersion', 'model']).catch(() => ({}));
  const browser = ua.brands.find(b => !/not.?a.?brand|chromium/i.test(b.brand)) ?? ua.brands[0];
  return [`${ua.platform} ${platformVersion ?? ''}`.trim(), browser && `${browser.brand} ${browser.version}`, model]
    .filter(Boolean).join(', ');
}

// Puts this device on the worker's list of devices to nudge, or takes it off. With its address go
// the queue, the language and the device's name, by which the list's owner tells its devices apart.
async function enlist(subscription, on) {
  const details = on && {queue, lang: LANG, device: await deviceName()};
  const response = await fetch(`${PUSH_API}/${on ? 'subscribe' : 'unsubscribe'}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({endpoint: subscription.endpoint, ...details}),
  });
  if (!response.ok) throw new Error(`${PUSH_API}: HTTP ${response.status}`);
}
const enlistDevice = async registration => enlist(
  await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY}),
  true);
// A device that shows the status tells the worker of itself again: the worker may have dropped it,
// and what it knows of the device may be out of date.
function relist() {
  if (statusOn()) navigator.serviceWorker.ready.then(enlistDevice).catch(e => console.warn('status push:', e));
}

// A notification through the service worker; true once it is up. A failure is only logged: the
// caller leaves it unrecorded and so tries again on the next minute.
async function post(title, options) {
  try {
    await (await navigator.serviceWorker.ready).showNotification(title, options);
    return true;
  } catch (e) {
    console.warn('notification:', e);
    return false;
  }
}

// The status notification is replaced only when its text changes, so one swiped away stays away
// until then (or until the next push).
async function showStatus() {
  if (!statusOn() || !data) return;
  const notice = statusNotice(queueDays(), kyivNow());
  const text = `${queue} ${notice.title} ${notice.body}`;
  if (text !== statusShown && await post(notice.title, statusOptions(notice))) statusShown = text;
}

async function notifyIfDue() {
  if (!notifyOn() || !data) return;
  const alert = dueAlert(queueDays(), kyivNow(), queue);
  if (!alert || store.get('notified') === alert.key) return;
  if (await post(alert.title, {body: alert.body, tag: alert.key, icon: 'icon-192.png'})) store.set('notified', alert.key);
}

$('notify').addEventListener('click', async () => {
  if (notifyOn()) store.set('notify', false);
  else if (await Notification.requestPermission() === 'granted') store.set('notify', true);
  renderNotify();
  notifyIfDue();
});
$('status').addEventListener('click', async () => {
  const registration = await navigator.serviceWorker.ready;
  pushFailed = false;
  if (statusOn()) {
    store.set('status', false);
    statusShown = '';
    for (const posted of await registration.getNotifications({tag: STATUS_TAG})) posted.close();
    const subscription = await registration.pushManager.getSubscription();
    // Cancelled in the browser first: should the worker miss the request, its next nudge is refused
    // and it drops the device itself.
    await subscription?.unsubscribe();
    if (subscription) enlist(subscription, false).catch(e => console.warn('status push:', e));
  } else if (await Notification.requestPermission() === 'granted') {
    try {
      await enlistDevice(registration);
      store.set('status', true);
    } catch (e) {
      console.warn('status push:', e);
      pushFailed = true;
    }
  }
  renderNotify();
  showStatus();
});
