// Schedule logic shared by the page and the service worker (which loads it with importScripts).

const SLOTS = 48;
const ON = '1', OFF = '2', MAYBE = '3';
// The service worker cannot read localStorage; the page leaves the selected queue for it in this cache.
const PREFS = 'svet-prefs';

const pad = n => String(n).padStart(2, '0');
const hhmm = slot => slot === SLOTS ? '24:00' : `${pad(slot >> 1)}:${slot % 2 ? '30' : '00'}`;
const span = min => [Math.floor(min / 60) && `${Math.floor(min / 60)} ч`, min % 60 && `${min % 60} мин`]
  .filter(Boolean).join(' ') || 'меньше минуты';

// The schedule is in Kyiv wall time whatever the phone's own zone is.
const TZ = ['Europe/Kyiv', 'Europe/Kiev'].find(tz => {
  try { new Intl.DateTimeFormat('ru', {timeZone: tz}); return true; } catch { return false; }
});
const clock = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
                                                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

function kyivNow() {
  const p = Object.fromEntries(clock.formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute};
}
function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// One queue's days out of a schedule that holds every queue: {iso date: {queue: cells}} -> {iso date: cells}.
function daysOf(days, queue) {
  return Object.fromEntries(Object.entries(days).flatMap(([iso, queues]) => queues[queue] ? [[iso, queues[queue]]] : []));
}

// Runs of half-hours without guaranteed power: firmEnd closes the last OFF slot, end the MAYBE slots after it.
function outages(cells) {
  const runs = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === ON) continue;
    const start = i;
    let firmEnd = null;
    for (; i < cells.length && cells[i] !== ON; i++) if (cells[i] === OFF) firmEnd = i + 1;
    runs.push({start, firmEnd, end: i});
  }
  return runs;
}

// What holds at the given minute and the half-hour it lasts until; an outage lasts until its last OFF slot.
function current(cells, minutes) {
  const slot = Math.floor(minutes / 30);
  if (cells[slot] === OFF) return {state: OFF, end: outages(cells).find(o => o.start <= slot && slot < o.end).firmEnd};
  let end = slot;
  while (end < SLOTS && cells[end] === cells[slot]) end++;
  return {state: cells[slot], end};
}

function status(cells, minutes) {
  const {state, end} = current(cells, minutes);
  const title = {[ON]: 'Свет есть', [OFF]: 'Света нет', [MAYBE]: 'Переключения'}[state];
  if (state === ON && end === SLOTS) return [title, 'до конца суток', ''];
  return [title, `до ${hhmm(end)}`, `ещё ${span(end * 30 - minutes)}`];
}

// The status as a notification: what holds now and what follows it. The state names its icons.
function statusNotice(days, now) {
  const cells = days[now.date];
  if (!cells) return {state: 'maybe', title: 'Графика на сегодня нет', body: 'Источник его не публикует'};
  const {state, end} = current(cells, now.minutes);
  const [title, until] = status(cells, now.minutes);
  const later = end < SLOTS ? cells : days[shiftDate(now.date, 1)];
  const minute = end % SLOTS * 30;
  const next = later && {[ON]: 'свет', [OFF]: 'без света', [MAYBE]: 'переключения'}[current(later, minute).state];
  return {
    state: {[ON]: 'on', [OFF]: 'off', [MAYBE]: 'maybe'}[state],
    title: `${title} ${until}`,
    body: later ? `${end < SLOTS ? 'Потом' : 'Завтра'} ${next} ${status(later, minute)[1]}` : 'Графика на завтра пока нет',
  };
}

// One notification, replaced in place and without a sound each time the status is shown again.
const statusOptions = notice => ({
  body: notice.body, tag: 'status', silent: true, renotify: false,
  icon: `status-${notice.state}.png`, badge: `badge-${notice.state}.png`,
});
