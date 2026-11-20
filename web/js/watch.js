// The watch as a drawing: built once, then redrawn from the schedule and the clock, and from what
// the hand has done to it, which controls.js sets. Uses schedule.js, base.js, timeline.js, i18n.js.

const NS = 'http://www.w3.org/2000/svg';
// The angle a half-hour takes on the 12-hour face.
const STEP = 360 / WINDOW;
// The watch is drawn around the origin; degrees run clockwise from 12.
const point = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)].map(v => v.toFixed(2));
const svg = (tag, attrs, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const name in attrs) node.setAttribute(name, attrs[name]);
  return parent.appendChild(node);
};
// An arc of the dial between two clock positions, inset so that neighbours do not touch.
const arc = (from, to, r) =>
  `M${point(from * STEP + 0.9, r)}A${r} ${r} 0 ${(to - from) * STEP > 180 ? 1 : 0} 1 ${point(to * STEP - 0.9, r)}`;
const stroke = (deg, from, to, parent) => svg('path', {d: `M${point(deg, from)}L${point(deg, to)}`}, parent);
const numeral = (deg, r, text, parent, turn = 0) => {
  const [x, y] = point(deg, r);
  const node = svg('text', {x, y, transform: `rotate(${turn} ${x} ${y})`}, parent);
  node.textContent = text;
  return node;
};

// A cogwheel's outline round a hole: each tooth is flat on top and slopes down to the root between it and the next.
function gearPath(teeth, root, tip, hole) {
  const pitch = 360 / teeth;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const at = (part, r) => point((i + part) * pitch, r);
    d += `${i ? 'L' : 'M'}${at(-.3, tip)}L${at(.3, tip)}L${at(.4, root)}L${at(.6, root)}`;
  }
  return `${d}ZM0 ${-hole}A${hole} ${hole} 0 1 0 0 ${hole}A${hole} ${hole} 0 1 0 0 ${-hole}Z`;
}
const segments = [];
const hours = [];

// A chronograph's face, 12 on top. The ring at the edge of the screen has one segment per half-hour
// of the 12-hour window, drawn only where there is power; the bezel names the hour of the day at each
// clock hour, inside the face's own 1 to 12.
function buildDial() {
  $('gear').setAttribute('d', gearPath(60, 167.5, 173.5, 157));
  for (let h = 1; h <= 12; h++) {
    // A small dial sits where the 9 would be.
    if (h !== 9) numeral(h * 30, 102, h, $('scale'));
    // Engraved facing outwards, but turned over in the lower half: upside down, 06 would read as 90.
    const deg = h % 12 * 30;
    hours[h % 12] = numeral(deg, 147, '', $('hours'), deg > 90 && deg < 270 ? deg + 180 : deg);
    // A notch cut into the turning ring at each hour from its pip: a lit edge beside a shadowed one.
    if (deg) {
      stroke(deg - .6, 160, 169, $('marks')).setAttribute('class', 'lit');
      stroke(deg + .6, 160, 169, $('marks')).setAttribute('class', 'dark');
    }
  }
  for (let q = 0; q < 48; q++) {
    if (q % 4) stroke(q * 7.5, q % 2 ? 144.5 : 142, q % 2 ? 149.5 : 152, $('notches'));
  }
  for (let i = 0; i < WINDOW; i++) segments.push(svg('path', {d: arc(i, i + 1, 127)}, $('ring')));
  // The small dials: the top one reads the time left to the next switch, four hours to the turn and
  // a tick every twenty minutes; the other two read hours out of the day's 24.
  const scales = {
    count: [32, {0: 4, 90: 1, 180: 2, 270: 3}],
    'total-on': [29, {0: 24, 90: 6, 180: 12, 270: 18}],
    'total-off': [32, Object.fromEntries(Array.from({length: 12}, (_, i) => [i * 30, i * 2 || 24]))],
  };
  for (const id in scales) {
    const [r, names] = scales[id], ticks = $(id).querySelector('.ticks');
    // A dial numbered all the way round keeps its ticks outside the numbers.
    const full = Object.keys(names).length === 12;
    for (let deg = 0; deg < 360; deg += 30) {
      if (names[deg]) numeral(deg, r - (full ? 11.5 : 9), names[deg], ticks);
      if (full || !names[deg]) stroke(deg, r - (full ? 7 : 9), r - 4, ticks);
    }
  }
  // The second hand steps on the real seconds.
  $('dial').style.setProperty('--tick', `${-(Date.now() / 1000 % 60)}s`);
}
// The bezel's pip points at the clock position the window starts from.
const turning = document.querySelectorAll('.turns');
const turnedBy = turn => `rotate(${turn * STEP}deg)`;
const setBezel = turn => { for (const part of turning) part.style.transform = turnedBy(turn); };

// What the last render put on the dial: the timeline, the window's start, the start it has by
// default and how far the bezel may turn it.
let view = null;
// The window start the bezel is turned to; null while the dial shows the default window.
let pinned = null;
// The bezel while it is dragged: the pointer's last angle and the turn so far, in clicks.
let grip = null;
// The timer that lets a window set with the wheel or the keys go back; 0 when none is running.
let linger = 0;
// The clock position inspected on the ring, or null.
let probe = null;
// What is spelled out over the face instead: a function that gives its lines, or null.
let spell = null;

// probe is the clock position under the pointer (or last tapped); the whole period it falls in is
// traced along the ring and described over the face, which is shaded for it. While the bezel is
// held or lingers where it was turned to, the face names that window instead.
function renderProbe() {
  const held = grip || linger;
  const p = view && !held && probe !== null ? period(view.at, slotAt(view.start, probe)) : null;
  const words = view && held && windowWords(view.start);
  const lines = words ? [words.times, words.days] : p ? describe(p, kyivNow().minutes) : view && spell ? spell() : null;
  $('tip').hidden = !lines;
  $('shade').toggleAttribute('hidden', !lines);
  $('mark').toggleAttribute('hidden', !p);
  if (p) $('mark').setAttribute('d', arc(Math.max(p.start, view.start), Math.min(p.end, view.start + WINDOW), 120.5));
  [...$('tip').children].forEach((line, i) => {
    line.textContent = lines?.[i] ?? '';
    line.hidden = !line.textContent;
  });
}

function setProbe(position, lines = null) {
  if (position === probe && lines === spell) return;
  probe = position;
  spell = lines;
  renderProbe();
}

// The watch alone: the window's half-hours on the ring, the bezel's pip at the window's start and
// its hours around, the time, the countdown and the window in words under it. Turning the bezel
// redraws only this.
function renderDial(now, days) {
  const slot = Math.floor(now.minutes / 30);
  view = null;
  if (days[now.date]) {
    const at = timeline(days, now.date);
    const base = windowStart(at, slot), {min, max} = windowBounds(at);
    view = {at, base, min, max, start: pinned === null ? base : clamp(pinned, min, max)};
  }
  const start = view?.start ?? 0;
  segments.forEach((seg, position) => {
    const s = slotAt(start, position);
    const kind = view && NAMES[view.at(s)] || '';
    seg.setAttribute('class', kind && s < slot ? `${kind} past` : kind);
  });
  hours.forEach((hour, h) => { hour.textContent = pad(Math.floor(mod(slotAt(start, 2 * h), SLOTS) / 2)); });
  if (!grip) setBezel(start);
  $('seam').toggleAttribute('hidden', !view);
  $('seam').setAttribute('transform', `rotate(${start * STEP})`);
  // The hands keep the time whatever the window; the mark of "now" on the ring holds only inside it,
  // where the hour hand's place is not a half-hour twelve hours away.
  $('cursor').toggleAttribute('hidden', !view || slot < start || slot >= start + WINDOW);
  for (const id of ['cursor', 'hour-hand']) $(id).setAttribute('transform', `rotate(${now.minutes / 2})`);
  $('minute-hand').setAttribute('transform', `rotate(${now.minutes % 60 * 6})`);
  const today = parts(dated({weekday: 'short', day: 'numeric'}), new Date());
  $('date').textContent = `${today.weekday.toUpperCase()} ${today.day}`;
  // The top small dial reads the time left until the power is back, once round in four hours;
  // anything longer leaves its needle there, and with the power on it rests at the top.
  const here = view && period(view.at, slot);
  const left = here && !here.lit ? here.end * 30 - now.minutes : 0;
  $('count').querySelector('.needle').setAttribute('transform', `rotate(${Math.min(left, 240) * 1.5})`);
  const label = view ? windowWords(start).label : '';
  $('window').textContent = label;
  const slider = {valuemin: view?.min ?? 0, valuemax: view?.max ?? 0, valuenow: start, valuetext: label};
  for (const name in slider) $('dial').setAttribute(`aria-${name}`, slider[name]);
  if (!view) probe = spell = null;
  renderProbe();
}
