// Shared fake Feed state: a fake balance, a fake toll, and a fake Creator split. No real payments.
export const SLOP_ORIGIN = `${location.protocol}//${location.hostname}:${Number(location.port || 80) + 1}`;

export const SLOPS = [
  { path: 'tapper', title: 'Cookie Slop', creator: 'npub…alice', icon: '🍪', orientation: 'portrait' },
  { path: 'dodge', title: 'Swipe Dodge', creator: 'npub…bob', icon: '🚧', orientation: 'portrait' },
  { path: 'runner', title: 'Sideways Runner', creator: 'npub…carol', icon: '🏃', orientation: 'landscape' },
  { path: 'paint', title: 'Finger Paint', creator: 'npub…dave', icon: '🎨', orientation: 'portrait' },
];
export const slopAt = (i) => SLOPS[((i % SLOPS.length) + SLOPS.length) % SLOPS.length];

export const TOLL = 0.01;
export const CREATOR_SHARE = 0.7;

export const state = {
  variant: '',
  index: 0,
  balance: 0.1,
  pulls: 0,
  visited: new Set([0]),
  paid: new Set([0]), // the first Slop is free
  pending: null, // { index, until } for dwell charging
  creators: {},
  platform: 0,
  events: ['landed on #0 Cookie Slop (first Slop free)'],
};

const listeners = [];
export const subscribe = (fn) => listeners.push(fn);

export function event(msg) {
  state.events.unshift(`${new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })} ${msg}`);
  state.events.length = Math.min(state.events.length, 10);
  render();
}

export function charge(index, when) {
  const slop = slopAt(index);
  if (state.balance + 1e-9 < TOLL) {
    event(`✗ balance empty, cannot pay for #${index}`);
    toast('balance empty', true);
    return false;
  }
  state.balance = Math.round((state.balance - TOLL) * 100) / 100;
  state.pulls++;
  state.paid.add(index);
  state.creators[slop.creator] = (state.creators[slop.creator] ?? 0) + TOLL * CREATOR_SHARE;
  state.platform += TOLL * (1 - CREATOR_SHARE);
  event(`paid ${TOLL.toFixed(2)} for #${index} ${slop.title} (${when})`);
  toast(`−${TOLL.toFixed(2)} USDC`);
  return true;
}

export function goTo(i) {
  const from = state.index;
  const revisit = state.visited.has(i);
  state.index = i;
  state.visited.add(i);
  event(`${i > from ? 'pull →' : 'back ←'} #${i} ${slopAt(i).title}${revisit ? ' (revisit)' : ''}`);
}

export function makeFrame(slop, { load = true } = {}) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.title = slop.title;
  if (load) f.src = `${SLOP_ORIGIN}/${slop.path}/`;
  return f;
}

// Keeps prev / current / next slides mounted and stacked vertically, so an immediate "back" keeps game state.
export function createSlides(container, build) {
  const slides = new Map();
  // Focus/scrollIntoView can scroll an overflow:hidden container; slides are positioned by transform only.
  container.addEventListener('scroll', () => (container.scrollTop = 0));
  function sync() {
    const want = [state.index - 1, state.index, state.index + 1].filter((i) => i >= 0);
    for (const [i, el] of slides) if (!want.includes(i)) (el.remove(), slides.delete(i));
    for (const i of want)
      if (!slides.has(i)) {
        const el = build(i);
        el.classList.add('slide');
        el.style.transform = `translateY(${(i - state.index) * 100}%)`;
        container.appendChild(el);
        slides.set(i, el);
      }
    for (const [i, el] of slides) el.style.transform = `translateY(${(i - state.index) * 100}%)`;
  }
  sync();
  return { sync, get: (i) => slides.get(i) };
}

// Drag tracking for Feed-owned hit areas. Touch events with preventDefault on touch devices, because mobile browsers
// cancel a pointer stream they claim for scrolling, pull-to-refresh or toolbar gestures; pointer events for the mouse.
export function onDrag(el, { start, move, end }) {
  let from = null;
  let last = null;
  const begin = (x, y) => ((from = { x, y }), (last = { x, y }), start?.());
  const step = (x, y) => from && ((last = { x, y }), move?.(y - from.y, x - from.x));
  const finish = () => {
    if (!from) return;
    const dy = last.y - from.y;
    const dx = last.x - from.x;
    from = null;
    end(dy, dx);
  };
  const touch = (e) => e.changedTouches[0];
  el.addEventListener('touchstart', (e) => (e.preventDefault(), begin(touch(e).clientX, touch(e).clientY)), { passive: false });
  el.addEventListener('touchmove', (e) => (e.preventDefault(), step(touch(e).clientX, touch(e).clientY)), { passive: false });
  el.addEventListener('touchend', (e) => (step(touch(e).clientX, touch(e).clientY), finish()));
  el.addEventListener('touchcancel', finish);
  el.addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && (el.setPointerCapture(e.pointerId), begin(e.clientX, e.clientY)));
  el.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && step(e.clientX, e.clientY));
  el.addEventListener('pointerup', (e) => e.pointerType === 'mouse' && finish());
}

export function onPullKeys(next, prev) {
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === ' ') (e.preventDefault(), next());
    if (e.key === 'ArrowUp') (e.preventDefault(), prev());
  });
}

export function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = `toast${bad ? ' bad' : ''}`;
  t.textContent = text;
  document.getElementById('app').appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

export function render() {
  for (const fn of listeners) fn();
  const panel = document.getElementById('statePanel');
  if (!panel) return;
  const s = slopAt(state.index);
  const pending = state.pending ? `charge #${state.pending.index} in ${Math.max(0, (state.pending.until - Date.now()) / 1000).toFixed(1)}s` : 'none';
  panel.textContent = [
    `variant   ${state.variant}`,
    `landed    #${state.index} ${s.title} (${s.creator}) [${s.orientation}]`,
    `balance   ${state.balance.toFixed(2)} USDC    pulls paid ${state.pulls}`,
    `toll      ${TOLL.toFixed(2)} (creator ${CREATOR_SHARE * 100}% / platform ${100 - CREATOR_SHARE * 100}%)`,
    `pending   ${pending}`,
    `platform  ${state.platform.toFixed(3)}`,
    ...Object.entries(state.creators).map(([c, v]) => `creator   ${c} ${v.toFixed(3)}`),
    '',
    ...state.events,
  ].join('\n');
}

export function setupStatePanel() {
  const panel = document.getElementById('statePanel');
  panel.hidden = innerWidth < 900;
  document.getElementById('stateToggle').addEventListener('click', () => (panel.hidden = !panel.hidden));
  setInterval(() => state.pending && render(), 100);
  // Stop the Feed page itself from rubber-banding or pull-to-refreshing under a gesture.
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}
