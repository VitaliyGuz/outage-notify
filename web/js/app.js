// The page as a whole: the selected queue and its schedule, loading it, drawing everything from
// it, and the start. Loaded last; uses every other script.

const REFRESH_MS = 10 * 60e3;

const dayLabel = new Intl.DateTimeFormat('ru', {timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long'});
const timeLabel = new Intl.DateTimeFormat('ru', {timeZone: TZ, hour: '2-digit', minute: '2-digit'});

let queue = store.get('queue', DEFAULT_QUEUE);
let data = store.get('schedule', null);
let loading = false;
let failed = false;

// The cached copy holds every queue; this is the selected one's days.
const queueDays = () => daysOf(data?.days ?? {}, queue);

function render() {
  const now = kyivNow();
  const days = queueDays();
  const cells = days[now.date];
  const slot = Math.floor(now.minutes / 30);
  $('day').textContent = dayLabel.format(new Date());

  renderDial(now, days);
  hintBezel();
  renderTotals(cells);

  const [state, until, left] = cells ? status(cells, now.minutes)
    : loading ? ['Загружаю график', '', '']
    : !data ? ['График не загрузился', 'Проверьте интернет', 'и нажмите «Обновить»']
    : ['Графика на сегодня нет', failed ? 'нет связи с источником' : 'источник его не публикует', ''];
  $('state').textContent = state;
  $('until').textContent = until;
  $('left').textContent = left;

  $('today').hidden = !cells;
  if (cells) listPeriods($('today'), 'сегодня', cells, slot, shown);
  const tomorrow = days[shiftDate(now.date, 1)];
  $('tomorrow').hidden = !tomorrow;
  if (tomorrow) listPeriods($('tomorrow'), 'завтра', tomorrow, -1, shown);

  $('source').textContent = !data ? ''
    : (loading ? 'Обновляю… ' : failed ? 'Нет связи с источником. ' : '')
      + (data.updated ? `Полтаваоблэнерго обновил график ${data.updated}. ` : 'Источник: Полтаваоблэнерго. ')
      + `Загружен в ${timeLabel.format(data.fetchedAt)}.`;
}

// The cached copy stays on screen while the request runs and is replaced only by a good answer.
async function load() {
  if (loading) return;
  loading = true;
  render();
  try {
    const fresh = await fetchSchedule();
    // Yesterday is kept so a state that began before midnight still has its start.
    const yesterday = shiftDate(kyivNow().date, -1);
    const kept = data?.days[yesterday] ? {[yesterday]: data.days[yesterday]} : {};
    data = {...fresh, days: {...kept, ...fresh.days}};
    store.set('schedule', data);
    failed = false;
  } catch (e) {
    console.warn('schedule not loaded:', e);
    failed = true;
  }
  loading = false;
  update();
}

// The page and both kinds of notification, brought in line with the clock and the schedule.
function update() {
  render();
  notifyIfDue();
  showStatus();
}

for (const id of ['refresh', 'pusher-refresh']) $(id).addEventListener('click', load);
$('queue').addEventListener('change', e => {
  queue = e.target.value;
  store.set('queue', queue);
  update();
  if (!data || failed) load();
});
// Coming back to the page reloads the schedule unless it was loaded within the last minute.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!data || failed || Date.now() - data.fetchedAt > 60e3) load();
  else update();
});

for (const q of QUEUES) $('queue').add(new Option(q, q, false, q === queue));
buildDial();
renderNotify();
store.set('queue', queue);
load();
// Nothing on the page changes more often than the minute does, so it is redrawn as each one starts.
(function tick() {
  setTimeout(() => { try { update(); } finally { tick(); } }, 60e3 - Date.now() % 60e3 + 50);
})();
// A hidden page keeps the schedule fresh only for the notifications it is responsible for.
setInterval(() => { if (!document.hidden || notifyOn() || statusOn()) load(); }, REFRESH_MS);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
// A device that shows the status enlists again on every start, in case the worker has dropped it.
if (statusOn()) navigator.serviceWorker.ready.then(enlistDevice).catch(e => console.warn('status push:', e));
