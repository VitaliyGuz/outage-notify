// The two notifications: an alert a quarter of an hour before an outage, while the page is open,
// and the status kept in the shade, which the worker's pushes renew when it is not (sw.js,
// worker/). Uses schedule.js, base.js, i18n.js and the page's state in app.js.

// The status push: the public half of the key pair it is signed with, and the worker that keeps the
// list of devices to nudge (worker/).
const VAPID_PUBLIC_KEY = 'BF5-2NY2Un22wD8YqqqAabhGnaqdK_Sk1XVRjV-ieRhI13UnxteOVpwOKYbF8JRmwVJLE3ifQpRU1EAxqDAsUQU';
const PUSH_API = 'https://outage-notify.vitaliy-guz.workers.dev';
const LEAD_MIN = 15;

// The alert due right now, if an outage starts within LEAD_MIN.
function dueAlert(days, now, queue) {
  const tomorrow = shiftDate(now.date, 1);
  for (const [iso, offset] of [[now.date, 0], [tomorrow, 24 * 60]]) {
    for (const o of outages(days[iso] ?? '')) {
      // An outage running over midnight was announced the day before, if that day's schedule is known.
      if (iso === tomorrow && o.start === 0 && days[now.date]?.at(-1) === OFF) continue;
      const wait = offset + o.start * 30 - now.minutes;
      if (wait <= 0 || wait > LEAD_MIN) continue;
      const tail = o.late > o.end ? ` ${T.alertDelay(hhmm(o.late))}` : '';
      return {
        key: `${queue} ${iso} ${hhmm(o.start)}`,
        title: T.alertTitle(wait),
        body: T.alertBody(queue, hhmm(o.start), hhmm(o.end)) + tail,
      };
    }
  }
  return null;
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

// Puts this device on the worker's list of devices to nudge, or takes it off.
async function enlist(subscription, on) {
  const response = await fetch(`${PUSH_API}/${on ? 'subscribe' : 'unsubscribe'}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({endpoint: subscription.endpoint}),
  });
  if (!response.ok) throw new Error(`${PUSH_API}: HTTP ${response.status}`);
}
const enlistDevice = async registration => enlist(
  await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY}),
  true);

// The status notification is replaced only when its text changes, so one swiped away stays away
// until then (or until the next push).
async function showStatus() {
  if (!statusOn() || !data) return;
  const notice = statusNotice(queueDays(), kyivNow());
  const text = `${queue} ${notice.title} ${notice.body}`;
  if (text === statusShown) return;
  statusShown = text;
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(notice.title, statusOptions(notice));
}

async function notifyIfDue() {
  if (!notifyOn() || !data) return;
  const alert = dueAlert(queueDays(), kyivNow(), queue);
  if (!alert || store.get('notified') === alert.key) return;
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(alert.title, {body: alert.body, tag: alert.key, icon: 'icon-192.png'});
  store.set('notified', alert.key);
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
