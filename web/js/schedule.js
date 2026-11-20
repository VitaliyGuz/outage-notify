// The source and its schedule, the clock, and the pieces of the status notification: shared by the
// page and the service worker (which loads it with importScripts). Its words come from i18n.js.

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
const hhmm = slot => `${pad(slot >> 1)}:${slot % 2 ? '30' : '00'}`;
const span = min => [Math.floor(min / 60) && T.hours(Math.floor(min / 60)), min % 60 && T.minutes(min % 60)]
  .filter(Boolean).join(' ') || T.lessThanMinute;

// The schedule is in Kyiv wall time whatever the phone's own zone is.
const TZ = ['Europe/Kyiv', 'Europe/Kiev'].find(tz => {
  try { new Intl.DateTimeFormat('ru', {timeZone: tz}); return true; } catch { return false; }
});
const clock = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
                                                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

// A date taken apart by a format: {year, month, day, weekday, hour, minute}, whichever it gives.
const parts = (format, date) => Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));

function kyivNow() {
  const p = parts(clock, new Date());
  return {date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute};
}
function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// A date matched by DATE, as an ISO date.
const isoDate = ([, day, month, year]) => `${year}-${pad(MONTHS.indexOf(month) + 1)}-${pad(day)}`;

// Every queue's half-hours per day, {iso date: {queue: cells}}, and when the source last changed
// any of them, as 'YYYY-MM-DD HH:MM'. Works on the text alone: a service worker has no DOM to parse
// the page with.
function parseSchedule(html) {
  const days = {};
  let updated = null;
  for (const part of html.split('class="gpvinfodetail"').slice(1)) {
    const block = part.replace(/<style[\s\S]*?<\/style>/g, '');
    // Each day says when it was last changed; the latest of them dates the schedule.
    const from = block.indexOf('Оновлено:');
    const stamp = from >= 0 && block.slice(from, from + 400).replace(/<[^>]*>/g, ' ').match(new RegExp(`${DATE}\\s+(\\d{1,2}:\\d{2})`));
    const changed = stamp && `${isoDate(stamp)} ${stamp[4].padStart(5, '0')}`;
    if (changed && (!updated || changed > updated)) updated = changed;
    // "року" tells the day's heading from that stamp, which carries a date too.
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
    if (Object.keys(queues).length) days[isoDate(day)] = queues;
  }
  return {days, updated};
}

// The source's schedule as it is now, stamped with the time it was read. The time limit keeps a
// dead connection from holding the page's "loading" state or the worker's push event open; browsers
// too old to have AbortSignal.timeout go without it.
async function fetchSchedule() {
  const response = await fetch(SOURCE, {cache: 'no-store', signal: AbortSignal.timeout?.(30e3)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const schedule = parseSchedule(await response.text());
  // A page with no schedule in it (maintenance, a changed layout) must not replace a copy that has one.
  if (!Object.keys(schedule.days).length) throw new Error('no schedule in the answer');
  return {...schedule, fetchedAt: Date.now()};
}

// One queue's days out of a schedule that holds every queue: {iso date: {queue: cells}} -> {iso date: cells}.
function daysOf(days, queue) {
  return Object.fromEntries(Object.entries(days).flatMap(([iso, queues]) => queues[queue] ? [[iso, queues[queue]]] : []));
}

// A state's picture for the notification and its glyph for the status bar.
const statusIcons = state => ({icon: `status-${state}.png`, badge: `badge-${state}.png`});

// One notification, replaced in place and without a sound each time the status is shown again.
const statusOptions = notice => ({body: notice.body, tag: STATUS_TAG, silent: true, ...statusIcons(notice.state)});
