// The watch under the hand: the bezel turned by a drag, the wheel or the keys, a period inspected
// on the ring, the small dials and the upper side button pressed. Uses watch.js and what it uses;
// the small dials also switch the lists (lists.js).

// The window start the bezel was turned to, with the day it was counted from; null while the dial
// shows the default window.
let pinned = null;
// The bezel while it is dragged: the pointer's last angle and the turn so far, in clicks.
let grip = null;
// Until the bezel has been turned once on this device, it shows on opening that it turns.
let turned = store.get('turned', false);
let hinted = false;

// Where the pointer is on the watch: the distance from its centre in the drawing's units and the
// angle clockwise from 12.
function polar(event) {
  const box = $('dial').getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width - .5) * VIEW.width;
  const y = ((event.clientY - box.top) / box.height - .5) * VIEW.height;
  return {r: Math.hypot(x, y), deg: mod(Math.atan2(x, -y) * 180 / Math.PI, 360)};
}
const onBezel = r => r >= BEZEL && r <= CASE;
function probeAt(event) {
  const {r, deg} = polar(event);
  setProbe(r < 105 || r >= BEZEL ? null : Math.floor(deg / 15));
}

// Turns the bezel to a window start, as far as the published days allow.
function turnTo(start) {
  if (!view) return;
  start = Math.min(Math.max(start, view.min), view.max);
  if (start === view.start) return;
  const now = kyivNow();
  pinned = start === view.base ? null : {date: now.date, start};
  probe = tally = null;
  $('dial').classList.remove('returning');
  if (!turned) store.set('turned', turned = true);
  navigator.vibrate?.(5);
  renderDial(now, queueDays());
}
// A window set with the wheel or the keys has no release to end it, so it goes back after a pause.
let linger = 0;
function turnBriefly(step) {
  clearTimeout(linger);
  linger = setTimeout(resetWindow, 1500);
  turnTo(view.start + step);
}
function resetWindow() {
  clearTimeout(linger);
  linger = 0;
  pinned = null;
  $('dial').classList.add('returning');
  renderDial(kyivNow(), queueDays());
}

// The bezel rocks a click forward and back.
function hintBezel() {
  if (hinted || turned || !view || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  hinted = true;
  const at = turn => ({transform: `rotate(${turn * 15}deg)`});
  const rock = [at(view.start), at(view.start + 1), at(view.start)];
  for (const part of turning) part.animate(rock, {duration: 900, delay: 600, easing: 'ease-in-out'});
}

// A press on the bezel takes hold of it, and the window it is turned to lasts while it is held;
// anywhere else on the watch a mouse inspects while it hovers, and a tap stays until the next tap
// elsewhere.
$('dial').addEventListener('pointerdown', e => {
  const {r, deg} = polar(e);
  if (!onBezel(r) || !view) return probeAt(e);
  grip = {deg, turn: view.start};
  $('dial').setPointerCapture(e.pointerId);
  $('dial').classList.add('turning');
  $('dial').classList.remove('returning');
  probe = tally = null;
  renderProbe();
});
$('dial').addEventListener('pointermove', e => {
  if (!grip) return probeAt(e);
  if (!view) return;
  const {deg} = polar(e);
  // The bezel follows the finger between clicks, gives a third of a click past either end of the
  // schedule and stops there.
  const turn = grip.turn + (mod(deg - grip.deg + 180, 360) - 180) / 15;
  grip = {deg, turn: Math.min(Math.max(turn, view.min - .35), view.max + .35)};
  setBezel(grip.turn);
  turnTo(Math.round(grip.turn));
});
for (const type of ['pointerup', 'pointercancel']) {
  $('dial').addEventListener(type, () => {
    if (!grip) return;
    grip = null;
    $('dial').classList.remove('turning');
    resetWindow();
  });
}
// Where touch-action is not honoured on a part of a drawing, this keeps the page from scrolling under a turn.
$('grip').addEventListener('touchstart', e => e.preventDefault(), {passive: false});
// The wheel turns the bezel only over the bezel itself; over the screen it scrolls the page as usual.
let spin = 0;
$('dial').addEventListener('wheel', e => {
  if (!view || !onBezel(polar(e).r)) return;
  e.preventDefault();
  spin += e.deltaY;
  if (Math.abs(spin) < 40) return;
  turnBriefly(Math.sign(spin));
  spin = 0;
}, {passive: false});
$('dial').addEventListener('keydown', e => {
  const step = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1}[e.key];
  if (!view || !step && e.key !== 'Home') return;
  e.preventDefault();
  if (step) turnBriefly(step);
  else resetWindow();
});
$('pusher-reset').addEventListener('click', resetWindow);
// The small dials: the countdown spells out how long until the power is back; a total spells out
// the day's figures for its state and picks that state's list under the watch.
$('hit-count').addEventListener('click', () => { if (view) setProbe(null, RETURN); });
for (const [id, state] of [['hit-on', ON], ['hit-off', OFF]]) {
  $(id).addEventListener('click', () => {
    choose(state);
    setProbe(null, state);
  });
}
$('dial').addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') setProbe(null); });
document.addEventListener('pointerdown', e => { if (!$('dial').contains(e.target)) setProbe(null); });
