// Shared fake Feed state: a fake balance, a fake toll, and a fake Creator split. No real payments.
// Serve Slop from a different *site*, as production will (Feed domain vs Arweave gateway): same-site frames share
// user activation in Chrome, which would fake a pass on the audio test. localhost → 127.0.0.1; a LAN IP → <ip>.nip.io.
const slopHost = location.hostname === 'localhost' ? '127.0.0.1' : /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? `${location.hostname.replaceAll('.', '-')}.nip.io` : location.hostname;
export const SLOP_ORIGIN = `${location.protocol}//${slopHost}:${Number(location.port || 80) + 1}`;

export const SLOPS = [
  { path: 'shop', title: 'Cookie Shop', creator: 'npub…frank', icon: '🛒', orientation: 'portrait' },
  { path: 'tapper', title: 'Cookie Slop', creator: 'npub…alice', icon: '🍪', orientation: 'portrait' },
  { path: 'sound', title: 'Beep Test', creator: 'npub…erin', icon: '🔊', orientation: 'portrait' },
  { path: 'dodge', title: 'Swipe Dodge', creator: 'npub…bob', icon: '🚧', orientation: 'portrait', verticalFlicks: true },
  { path: 'runner', title: 'Sideways Runner', creator: 'npub…carol', icon: '🏃', orientation: 'landscape' },
  { path: 'paint', title: 'Finger Paint', creator: 'npub…dave', icon: '🎨', orientation: 'portrait' },
];
export const slopAt = (i) => SLOPS[((i % SLOPS.length) + SLOPS.length) % SLOPS.length];

export const TOLL = 0.01; // the house keeps the whole Pull (ADR 0002); Creators earn only from Purchases

export const state = {
  variant: '',
  index: 0,
  balance: 0.3, // Runway
  sheetOpen: false, // a Purchase sheet is up: no Pulls
  lastTap: null, // { index, at } of the last tap forwarded into a Slop
  net: 'ok', // fake connector: ok | reject | slow
  refillAt: 0,
  purchases: 0,
  pulls: 0,
  visited: new Set([0]),
  paid: new Set([0]), // the first Slop is free
  pending: null, // { index, until } for dwell charging
  creators: {},
  platform: 0,
  events: ['landed on #0 Cookie Shop (first Slop free)'],
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
  state.platform += TOLL;
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
  f.setAttribute('allow', 'autoplay; fullscreen');
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

// Lets purchase.js find the on-screen Slop's window, whichever variant is mounted.
export const hooks = { currentFrame: () => null };

export function onPullKeys(next, prev) {
  addEventListener('keydown', (e) => {
    if (state.sheetOpen) return;
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
    `runway    ${state.balance.toFixed(2)} USDC    pulls paid ${state.pulls}    purchases ${state.purchases}`,
    `toll      ${TOLL.toFixed(2)} (platform keeps 100%)    net ${state.net}    sheet ${state.sheetOpen ? 'OPEN (pulls blocked)' : 'closed'}`,
    `last tap  ${state.lastTap ? `#${state.lastTap.index} ${((Date.now() - state.lastTap.at) / 1000).toFixed(1)}s ago` : 'none'}`,
    `pending   ${pending}`,
    `platform  ${state.platform.toFixed(3)}`,
    ...Object.entries(state.creators).map(([c, v]) => `creator   ${c} ${v.toFixed(2)} (Purchases, 100%)`),
    '',
    ...state.events,
  ].join('\n');
}

export function setupStatePanel() {
  const panel = document.getElementById('statePanel');
  panel.hidden = innerWidth < 900;
  document.getElementById('stateToggle').addEventListener('click', () => (panel.hidden = !panel.hidden));
  setInterval(render, 250);
  // Stop the Feed page itself from rubber-banding or pull-to-refreshing under a gesture.
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}
