// Schedule logic shared by the page and the service worker (which loads it with importScripts).

const SOURCE = 'https://www.poe.pl.ua/customs/dynamicgpv-info.php';
const SLOTS = 48;
const ON = '1', OFF = '2', MAYBE = '3';
const NAMES = {[ON]: 'on', [OFF]: 'off', [MAYBE]: 'maybe'};
const QUEUES = [1, 2, 3, 4, 5, 6].flatMap(q => [`${q}.1`, `${q}.2`]);
const DEFAULT_QUEUE = '3.1';
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
                'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const DATE = `(\\d{1,2}) (${MONTHS.join('|')}) (\\d{4})`;
// The service worker cannot read localStorage; the page leaves the selected queue and its copy of
// the schedule for it in this cache.
const PREFS = 'svet-prefs';
const prefsGet = async key => (await (await caches.open(PREFS)).match(key))?.json();
const prefsPut = async (key, value) => (await caches.open(PREFS)).put(key, new Response(JSON.stringify(value)));
const STATUS_TAG = 'status';

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

// Every queue's half-hours per day, {iso date: {queue: cells}}, and when the source last changed it.
// Works on the text alone: a service worker has no DOM to parse the page with.
function parseSchedule(html) {
  const days = {};
  for (const part of html.split('class="gpvinfodetail"').slice(1)) {
    const block = part.replace(/<style[\s\S]*?<\/style>/g, '');
    // "року" tells the day's heading from the "Оновлено" stamp, which carries a date too.
    const day = block.match(new RegExp(`${DATE} року`));
    const table = block.match(/<table[\s\S]*?<\/table>/);
    if (!day || !table) continue;
    const queues = {};
    for (const [row] of table[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const name = row.match(/<t[dh] class="gpv-q[^"]*"[^>]*>\s*([\d.]+)\s*</)?.[1];
      if (!QUEUES.includes(name)) continue;
      const cells = [...row.matchAll(/<td class="gpv-c gpv-s([123])/g)].map(cell => cell[1]).join('');
      // A broken row costs its own queue the day, not every queue the whole schedule.
      if (cells.length === SLOTS) queues[name] = cells;
      else console.warn(`queue ${name}: expected ${SLOTS} half-hours, got ${cells.length}`);
    }
    if (Object.keys(queues).length) days[`${day[3]}-${pad(MONTHS.indexOf(day[2]) + 1)}-${pad(day[1])}`] = queues;
  }
  const updated = html.replace(/<[^>]*>/g, ' ').match(new RegExp(`Оновлено:\\s*${DATE}\\s+(\\d{1,2}:\\d{2})`));
  return {days, updated: updated && `${pad(updated[1])}.${pad(MONTHS.indexOf(updated[2]) + 1)} в ${updated[4]}`};
}

// The source's schedule as it is now, stamped with the time it was read. The time limit keeps a
// dead connection from holding the page's "loading" state or the worker's push event open; browsers
// too old to have AbortSignal.timeout go without it.
async function fetchSchedule() {
  const response = await fetch(SOURCE, {cache: 'no-store', signal: AbortSignal.timeout?.(30e3)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {...parseSchedule(await response.text()), fetchedAt: Date.now()};
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
  if (!cells) return {state: 'maybe', title: 'Графика на сегодня нет', body: ''};
  const {state, end} = current(cells, now.minutes);
  const [title, until] = status(cells, now.minutes);
  const later = end < SLOTS ? cells : days[shiftDate(now.date, 1)];
  const minute = end % SLOTS * 30;
  const next = later && {[ON]: 'свет', [OFF]: 'без света', [MAYBE]: 'переключения'}[current(later, minute).state];
  return {
    state: NAMES[state],
    title: `${title} ${until}`,
    body: later ? `${end < SLOTS ? 'Потом' : 'Завтра'} ${next} ${status(later, minute)[1]}` : 'Графика на завтра пока нет',
  };
}

// One notification, replaced in place and without a sound each time the status is shown again.
const statusOptions = notice => ({
  body: notice.body, tag: STATUS_TAG, silent: true,
  icon: `status-${notice.state}.png`, badge: `badge-${notice.state}.png`,
});
