// The day in stretches of power and of none: the two legend cards with their totals, the lists
// under them, and a state's figures for today. Uses schedule.js, base.js; redraws through app.js.

const LISTS = {
  [ON]: {title: 'Со светом', none: 'Весь день без света.'},
  [OFF]: {title: 'Без света', none: 'Отключений нет.'},
};

// The state whose stretches the lists show.
let shown = store.get('list', OFF);
if (!LISTS[shown]) shown = OFF;

// A day's stretches of power (the switching half-hours counted with it) or of none.
function runs(cells, state) {
  const same = cell => cell !== undefined && lit(cell) === (state === ON);
  const periods = [];
  for (let i = 0; i < cells.length; i++) {
    if (!same(cells[i])) continue;
    const start = i;
    while (same(cells[i + 1])) i++;
    periods.push({start, end: i + 1});
  }
  return periods;
}

// The day's stretches of one state, under a heading that names the state and the day.
function listPeriods(section, day, cells, slot, state) {
  const periods = runs(cells, state);
  const active = periods.find(p => slot < p.end);
  section.querySelector('h2').textContent = `${LISTS[state].title} ${day}`;
  const list = section.querySelector('ol');
  list.replaceChildren(...periods.map(p => {
    const li = el('li', {className: slot >= p.end ? 'past' : p === active && slot >= 0 ? 'next' : ''});
    li.append(el('span', {textContent: `${hhmm(p.start)} – ${hhmm(p.end)}`}),
              el('span', {className: 'dur', textContent: span((p.end - p.start) * 30)}));
    // The switching half-hours come after an outage's end and open the power after it.
    const edge = state === OFF ? p.end : p.start;
    let late = edge;
    while (cells[late] === MAYBE) late++;
    if (late > edge) li.append(el('small', {textContent: `включение может задержаться до ${hhmm(late)}`}));
    return li;
  }));
  if (!periods.length) list.append(el('li', {className: 'none', textContent: LISTS[state].none}));
}

// Today's figures for one state: how long it holds in all, what share of the day that is, in how
// many stretches, and how much of it is still ahead.
function tallyLines(state) {
  const now = kyivNow(), periods = runs(queueDays()[now.date], state);
  if (!periods.length) return [LISTS[state].none];
  const lengths = periods.map(p => (p.end - p.start) * 30), total = lengths.reduce((sum, length) => sum + length);
  const ahead = periods.reduce((sum, p) => sum + Math.max(0, p.end * 30 - Math.max(p.start * 30, now.minutes)), 0);
  const n = periods.length;
  const stretches = n % 10 === 1 && n !== 11 ? 'период' : n % 10 > 1 && n % 10 < 5 && (n < 12 || n > 14) ? 'периода' : 'периодов';
  return [
    `${span(total)} ${LISTS[state].title.toLowerCase()}`,
    `сегодня, ${Math.round(total / 14.4)}% суток`,
    n > 1 ? `${n} ${stretches}, самый долгий ${span(Math.max(...lengths))}` : '1 период',
    ahead ? `до конца суток ещё ${span(ahead)}` : 'сегодня больше не будет',
  ];
}

// The legend doubles as today's totals (hours with power and without) and as the switch for which
// of the two the lists below show. Two of the watch's small dials carry the same totals and switch
// the lists as well.
function renderTotals(cells) {
  const hours = state => cells ? runs(cells, state).reduce((sum, p) => sum + p.end - p.start, 0) / 2 : 0;
  const words = state => cells ? `${hours(state).toLocaleString('ru')} ч` : '';
  for (const card of $('legend').children) {
    card.querySelector('span').textContent = words(card.dataset.state);
    card.setAttribute('aria-pressed', card.dataset.state === shown);
  }
  for (const [id, state] of [['total-on', ON], ['total-off', OFF]]) {
    $(id).querySelector('.needle').setAttribute('transform', `rotate(${hours(state) * 15})`);
  }
}

function choose(state) {
  shown = state;
  store.set('list', shown);
  render();
}

$('legend').addEventListener('click', e => {
  const card = e.target.closest('button');
  if (card) choose(card.dataset.state);
});
