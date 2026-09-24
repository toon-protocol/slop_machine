// E · Swipe-anywhere, no modes
// The Feed owns every touch, always. A quick vertical flick is a Pull; anything else (a tap, a horizontal swipe, a
// press-and-hold-then-drag) is forwarded into the Slop via postMessage (Feed → Slop only) and replayed by a shim.
// A Slop whose listing declares vertical flicks (Swipe Dodge) keeps them; Pulls on it only start in a bottom zone.
// Charge: on pull. Cost: price chip. Autoplay: yes. Landscape: letterboxed.
import { state, slopAt, makeFrame, charge, goTo, createSlides, onPullKeys, subscribe, event, hooks, SLOP_ORIGIN, TOLL } from './common.js';

export const name = 'Swipe-anywhere, no modes';
const HOLD_MS = 120; // press this long without moving and the touch belongs to the Slop
const SLOP_PX = 12; // movement before intent is decided
const PULL_PX = 60;
const ZONE = 0.16; // bottom share of the screen that pulls on vertical-flick Slops

export function mount(root) {
  root.innerHTML = `
    <div class="d e" id="e">
      <div class="d-stage" id="stage"></div>
      <div class="e-zone" id="zone"><span>swipe here to pull</span></div>
      <div class="d-caption"><b id="title"></b><small id="creator"></small></div>
      <span class="chip d-price">${TOLL.toFixed(2)} USDC / pull</span>
      <span class="chip d-bal" id="bal"></span>
      <button class="chip e-unmute" id="unmute">🔇 unmute</button>
    </div>`;
  const stage = root.querySelector('#stage');
  const zone = root.querySelector('#zone');

  const frames = new Map();
  const slides = createSlides(stage, (i) => {
    const s = slopAt(i);
    const el = document.createElement('div');
    const f = makeFrame(s);
    frames.set(i, f);
    if (s.orientation === 'landscape') {
      el.innerHTML = `<div class="a-letterbox"></div>`;
      el.firstChild.append(f);
    } else el.append(f);
    el.append(Object.assign(document.createElement('div'), { className: 'e-shield' }));
    return el;
  });

  hooks.currentFrame = () => frames.get(state.index);

  function next() {
    if (state.sheetOpen) return;
    const i = state.index + 1;
    if (!state.paid.has(i) && !charge(i, 'on flick')) return;
    goTo(i);
    slides.sync();
    render();
  }
  function prev() {
    if (state.sheetOpen || state.index === 0) return;
    goTo(state.index - 1);
    slides.sync();
    render();
  }

  // Forward one input event to the current Slop, in its own viewport coordinates.
  function forward(kind, x, y) {
    const f = frames.get(state.index);
    if (!f?.isConnected) return;
    const r = f.getBoundingClientRect();
    f.contentWindow.postMessage({ type: 'slop-input', kind, x: x - r.left, y: y - r.top }, SLOP_ORIGIN);
    if (kind === 'up') state.lastTap = { index: state.index, at: Date.now() }; // a Purchase request must follow one closely
  }

  // Intent recogniser: pending → pull | game.
  let t = null;
  function begin(x, y) {
    const r = stage.getBoundingClientRect();
    const inZone = y > r.bottom - r.height * ZONE;
    t = { x0: x, y0: y, x, y, mode: 'pending', canPull: !slopAt(state.index).verticalFlicks || inZone };
    t.hold = setTimeout(() => t?.mode === 'pending' && toGame(), HOLD_MS);
  }
  function toGame() {
    t.mode = 'game';
    clearTimeout(t.hold);
    forward('down', t.x0, t.y0);
    if (t.x !== t.x0 || t.y !== t.y0) forward('move', t.x, t.y);
  }
  function moveTo(x, y) {
    if (!t) return;
    t.x = x;
    t.y = y;
    const dx = x - t.x0;
    const dy = y - t.y0;
    if (t.mode === 'pending' && Math.max(Math.abs(dx), Math.abs(dy)) > SLOP_PX) {
      if (t.canPull && Math.abs(dy) > Math.abs(dx)) {
        t.mode = 'pull';
        clearTimeout(t.hold);
        stage.style.transition = 'none';
      } else toGame();
      return;
    }
    if (t.mode === 'pull') stage.style.transform = `translateY(${dy * 0.5}px)`;
    if (t.mode === 'game') forward('move', x, y);
  }
  function finish() {
    if (!t) return;
    const { mode, x, y, x0, y0 } = t;
    clearTimeout(t.hold);
    t = null;
    if (mode === 'pending') (forward('down', x0, y0), forward('up', x, y)); // a tap
    if (mode === 'game') forward('up', x, y);
    if (mode === 'pull') {
      stage.style.transition = '';
      stage.style.transform = '';
      const dy = y - y0;
      if (dy < -PULL_PX) next();
      else if (dy > PULL_PX) prev();
      else event(`flick too short (${Math.round(dy)}px), no pull`);
    }
  }

  const tp = (e) => e.changedTouches[0];
  stage.addEventListener('touchstart', (e) => (e.preventDefault(), t || begin(tp(e).clientX, tp(e).clientY)), { passive: false });
  stage.addEventListener('touchmove', (e) => (e.preventDefault(), moveTo(tp(e).clientX, tp(e).clientY)), { passive: false });
  stage.addEventListener('touchend', (e) => (moveTo(tp(e).clientX, tp(e).clientY), finish()));
  stage.addEventListener('touchcancel', finish);
  stage.addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && (stage.setPointerCapture(e.pointerId), begin(e.clientX, e.clientY)));
  stage.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && moveTo(e.clientX, e.clientY));
  stage.addEventListener('pointerup', (e) => e.pointerType === 'mouse' && finish());

  // Fallback if forwarded input can't unlock audio (iOS?): let exactly one real tap through to the Slop.
  const unmute = root.querySelector('#unmute');
  unmute.addEventListener('click', () => {
    const shield = slides.get(state.index)?.querySelector('.e-shield');
    if (!shield) return;
    shield.style.pointerEvents = 'none';
    unmute.textContent = '👆 tap the Slop once';
    event('unmute: next tap goes straight into the Slop');
    const restore = () => {
      shield.style.pointerEvents = '';
      unmute.textContent = '🔇 unmute';
      removeEventListener('blur', restore);
      clearTimeout(timer);
    };
    addEventListener('blur', restore); // focus moving into the iframe means the tap landed there
    const timer = setTimeout(restore, 5000);
  });

  function render() {
    zone.hidden = !slopAt(state.index).verticalFlicks;
  }
  render();

  onPullKeys(next, prev);
  subscribe(() => {
    const s = slopAt(state.index);
    root.querySelector('#title').textContent = `${s.icon} ${s.title}`;
    root.querySelector('#creator').textContent = s.creator;
    root.querySelector('#bal').textContent = `${state.balance.toFixed(2)} USDC`;
  });
}
