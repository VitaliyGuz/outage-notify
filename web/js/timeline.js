// One queue's days laid on a single axis of half-hours, the 12-hour window the watch shows of it,
// and what is said about a stretch of it. Nothing here touches the page. Uses schedule.js.

// The window, in half-hours.
const WINDOW = 24;

const mod = (n, m) => ((n % m) + m) % m;

// Half-hour states on one axis counted from today's midnight (-48..-1 yesterday, 48..95 tomorrow);
// undefined where no schedule is known.
function timeline(days, today) {
  const around = [-1, 0, 1].map(shift => days[shiftDate(today, shift)]);
  return slot => around[Math.floor(slot / SLOTS) + 1]?.[mod(slot, SLOTS)];
}

// The 12-hour window opens at the last switch between power and outage; with no switch in the last
// 12 hours it opens at the current hour. A window that would run into a tomorrow not published yet
// is the second half of today instead.
function windowStart(at, slot) {
  const on = lit(at(slot));
  let start = slot;
  while (slot - start < WINDOW && at(start - 1) !== undefined && lit(at(start - 1)) === on) start--;
  if (slot - start >= WINDOW) start = slot - slot % 2;
  return at(start + WINDOW - 1) === undefined ? SLOTS - WINDOW : start;
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

// A point of the timeline as its day and clock time; midnight closes a day as 24:00 and opens the next as 00:00.
function stamp(slot, closing) {
  const day = Math.floor((closing ? slot - 1 : slot) / SLOTS);
  return {day: ['вчера ', '', 'завтра '][day + 1], time: hhmm(slot - day * SLOTS)};
}
// The window in words, on one line and as its times and its days apart; a day both ends fall on is named once.
function windowWords(start) {
  const from = stamp(start), till = stamp(start + WINDOW, true);
  const day = at => at.day || 'сегодня ';
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
  const edge = on(slot) ? start : end;
  let late = edge;
  while (at(late) === MAYBE) late++;
  return {start, end, late, delayed: late > edge, lit: on(slot),
          openStart: at(start - 1) === undefined, openEnd: at(end) === undefined};
}

// Title, time range, duration with the distance from now, and a note: the lines shown for an inspected period.
function describe(p, minutes) {
  const from = stamp(p.start), till = stamp(p.end, true), late = stamp(p.late, true);
  const tense = minutes < p.start * 30 ? 2 : minutes < p.end * 30 ? 1 : 0;
  const title = (p.lit ? ['Свет был', 'Свет есть', 'Свет будет'] : ['Света не было', 'Света нет', 'Света не будет'])[tense];
  const range = p.openStart && p.openEnd ? 'весь день' : p.openStart ? `${till.day}до ${till.time}`
    : p.openEnd ? `${from.day}с ${from.time}`
    : `${from.day}${from.time} – ${till.day === from.day ? '' : till.day}${till.time}`;
  const distance = tense === 2 ? `через ${span(p.start * 30 - minutes)}`
    : tense === 0 ? `${span(minutes - p.end * 30)} назад`
    : p.openEnd ? '' : `осталось ${span(p.end * 30 - minutes)}`;
  const length = !p.openStart && !p.openEnd && span((p.end - p.start) * 30);
  const note = p.delayed ? `включение может задержаться до ${late.day}${late.time}`
    : p.openEnd ? 'дальше графика пока нет' : '';
  return [title, range, [length, distance].filter(Boolean).join(', '), note];
}

// How long until the power is back, as the lines shown over the face. With the power on there is
// nothing to wait for, and the lines describe what holds now, less the note on a delayed return.
function returnLines(at, minutes) {
  const p = period(at, Math.floor(minutes / 30));
  if (p.lit) return describe(p, minutes).slice(0, 3);
  const {day, time} = stamp(p.end, true), left = span(p.end * 30 - minutes);
  return ['Включение', p.openEnd ? `не раньше чем через ${left}` : `через ${left}`, `${day}в ${time}`,
          p.openEnd ? 'дальше графика пока нет' : ''];
}
