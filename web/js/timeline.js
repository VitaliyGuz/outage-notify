// A day in stretches of power and of none; one queue's days laid on a single axis of half-hours,
// the 12-hour window the watch shows of it, and what is said about a stretch of it, the status
// among it. Nothing here touches the page, and the service worker loads it too. Uses schedule.js,
// i18n.js.

// The window, and how far back from now it may open, in half-hours.
const WINDOW = 24, PAST = 2;

const mod = (n, m) => ((n % m) + m) % m;
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

// The switching half-hours that follow an outage count as power: as a rule it is back by then.
const lit = cell => cell === ON || cell === MAYBE;

// Where the switching half-hours that begin at edge end; edge itself where there are none. They
// follow an outage: its end is their edge, and so is the start of the power after it.
function lateFrom(at, edge) {
  let late = edge;
  while (at(late) === MAYBE) late++;
  return late;
}

// A day's stretches of power (the switching half-hours counted with it) or of none, each with the
// end of the switching half-hours at its edge and whether there are any. after is the next day's
// cells, where an outage that ends at midnight has them; late then counts on past the day's end.
function runs(cells, state, after = '') {
  const same = cell => cell !== undefined && lit(cell) === (state === ON);
  const all = cells + after;
  const periods = [];
  for (let i = 0; i < cells.length; i++) {
    if (!same(cells[i])) continue;
    const start = i;
    while (same(cells[i + 1])) i++;
    const edge = state === ON ? start : i + 1, late = lateFrom(slot => all[slot], edge);
    periods.push({start, end: i + 1, late, delayed: late > edge});
  }
  return periods;
}

// Half-hour states on one axis counted from today's midnight (-48..-1 yesterday, 48..95 tomorrow);
// undefined where no schedule is known.
function timeline(days, today) {
  const around = [-1, 0, 1].map(shift => days[shiftDate(today, shift)]);
  return slot => around[Math.floor(slot / SLOTS) + 1]?.[mod(slot, SLOTS)];
}

// Where the 12-hour window would best open: at the last switch between power and outage, but no
// more than an hour back (at a half-hour mark), so that eleven hours of it or more lie ahead. The
// caller keeps the window inside the published days: one that would run into a tomorrow not
// published yet is the second half of today instead, with more of the past in it.
function windowStart(at, minutes) {
  return Math.max(period(at, Math.floor(minutes / 30)).start, Math.ceil(minutes / 30) - PAST);
}
// How far the bezel turns the window: it stays inside the published days around today.
function windowBounds(at) {
  let min = 0, end = SLOTS;
  while (at(min - 1) !== undefined) min -= SLOTS;
  while (at(end) !== undefined) end += SLOTS;
  return {min, max: end - WINDOW};
}
// Each clock position holds the one half-hour of the window that falls on it.
const slotAt = (start, position) => start + mod(position - start, WINDOW);

// A point of the timeline as its day and clock time; midnight closes a day as 24:00 and opens the
// next as 00:00. The day is named, with a space after the name, unless it is today.
function stamp(slot, closing) {
  const day = Math.floor((closing ? slot - 1 : slot) / SLOTS);
  return {day: day ? `${T.days[day + 1]} ` : '', time: hhmm(slot - day * SLOTS)};
}
// The window in words, on one line and as its times and its days apart; a day both ends fall on is named once.
function windowWords(start) {
  const from = stamp(start), till = stamp(start + WINDOW, true);
  const day = at => at.day || `${T.days[1]} `;
  return {
    label: `${day(from)}${from.time} – ${till.day === from.day ? '' : day(till)}${till.time}`,
    times: `${from.time} – ${till.time}`,
    days: till.day === from.day ? day(from) : `${day(from)}– ${day(till)}`,
  };
}

// The stretch of the timeline around a published slot that shares its state: power, the switching
// half-hours counted with it, or none. late closes the switching half-hours that follow an outage:
// they come after the outage's end and open the power after it. An open side borders on a day
// with no schedule.
function period(at, slot) {
  const on = s => at(s) && lit(at(s));
  let start = slot, end = slot + 1;
  while (on(start - 1) === on(slot)) start--;
  while (on(end) === on(slot)) end++;
  const edge = on(slot) ? start : end, late = lateFrom(at, edge);
  return {start, end, late, delayed: late > edge, lit: on(slot),
          openStart: at(start - 1) === undefined, openEnd: at(end) === undefined};
}

// Title, time range, duration with the distance from now, and a note: the lines shown for an inspected period.
function describe(p, minutes) {
  const from = stamp(p.start), till = stamp(p.end, true), late = stamp(p.late, true);
  const tense = minutes < p.start * 30 ? 2 : minutes < p.end * 30 ? 1 : 0;
  const title = (p.lit ? T.power : T.noPower)[tense];
  const range = p.openStart && p.openEnd ? T.wholeDay : p.openStart ? T.rangeTill(till.day, till.time)
    : p.openEnd ? T.rangeFrom(from.day, from.time)
    : `${from.day}${from.time} – ${till.day === from.day ? '' : till.day}${till.time}`;
  const distance = tense === 2 ? T.inTime(span(p.start * 30 - minutes))
    : tense === 0 ? T.ago(span(minutes - p.end * 30))
    : p.openEnd ? '' : T.remains(span(p.end * 30 - minutes));
  const length = !p.openStart && !p.openEnd && span((p.end - p.start) * 30);
  const note = p.delayed ? T.mayBeDelayed(`${late.day}${late.time}`) : p.openEnd ? T.noFurtherSchedule : '';
  return [title, range, [length, distance].filter(Boolean).join(', '), note];
}

// How long until the power is back, as the lines shown over the face: the one time, the end of the
// outage, without the note that it may be delayed. With the power on there is nothing to wait for,
// and the lines describe what holds now, less that note as well.
function returnLines(at, minutes) {
  const p = period(at, Math.floor(minutes / 30));
  if (p.lit) return describe(p, minutes).slice(0, 3);
  const {day, time} = stamp(p.end, true), left = span(p.end * 30 - minutes);
  return [T.powerBack, p.openEnd ? T.notBefore(left) : T.inTime(left), T.atTime(day, time),
          p.openEnd ? T.noFurtherSchedule : ''];
}

// Until when a period lasts, in words: its end, or the end of the day with which the schedule
// stops (it is published in whole days).
function untilEnd(p) {
  const {day, time} = stamp(p.end, true);
  return p.openEnd ? `${day}${T.tillDayEnd}` : T.till(day, time);
}

// What holds now, as the headline's three lines: the state, until when, and how long that still
// is. Power that lasts as far as the schedule goes has no end to count down to.
function status(at, minutes) {
  const p = period(at, Math.floor(minutes / 30));
  return [(p.lit ? T.power : T.noPower)[1], untilEnd(p), p.lit && p.openEnd ? '' : T.more(span(p.end * 30 - minutes))];
}

// The status as a notification: what holds now and what follows it. The state names its icons; the
// half-lit one stands for a day with no schedule.
function statusNotice(days, now) {
  if (!days[now.date]) return {state: NAMES[MAYBE], title: T.noScheduleToday, body: ''};
  const at = timeline(days, now.date), p = period(at, Math.floor(now.minutes / 30));
  const next = !p.openEnd && period(at, p.end);
  return {
    state: NAMES[p.lit ? ON : OFF],
    title: status(at, now.minutes).slice(0, 2).join(' '),
    body: next ? T.next(next.lit, untilEnd(next)) : p.end === SLOTS ? T.noScheduleTomorrow : '',
  };
}
