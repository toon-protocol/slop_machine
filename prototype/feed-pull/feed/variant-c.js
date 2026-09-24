// C · Slot reel
// Charge: on pressing PULL (prepaid). Cost: on the big button, slot-machine style, with a reel spin before landing.
// Autoplay: yes, after the reel lands. Conflict: none, because there is no swipe gesture, only a button below the Slop.
// Landscape: letterboxed with a "rotate" hint in portrait; rotating the phone flips the layout to Slop + side rail.
import { state, slopAt, makeFrame, charge, goTo, onPullKeys, subscribe, SLOPS, TOLL } from './common.js';

export const name = 'Slot reel';
const SPIN_MS = 1100;

export function mount(root) {
  root.innerHTML = `
    <div class="c">
      <div class="c-meta"><b id="title"></b><small id="creator"></small></div>
      <div class="c-card" id="card"><div class="c-reel" id="reel" hidden></div><div class="c-rotate" id="rotate">⟳ rotate for full screen</div></div>
      <div class="c-controls">
        <button class="c-back" id="back">↩</button>
        <button class="c-pull" id="pull">PULL<small>${TOLL.toFixed(2)} USDC</small></button>
        <span class="chip" id="bal"></span>
      </div>
    </div>`;
  const card = root.querySelector('#card');
  const reel = root.querySelector('#reel');
  const frames = new Map();
  let spinning = false;

  function sync() {
    const want = [state.index - 1, state.index, state.index + 1].filter((i) => i >= 0);
    for (const [i, f] of frames) if (!want.includes(i)) (f.remove(), frames.delete(i));
    for (const i of want)
      if (!frames.has(i)) {
        const f = makeFrame(slopAt(i));
        card.prepend(f);
        frames.set(i, f);
      }
    for (const [i, f] of frames) f.classList.toggle('on', i === state.index);
    const s = slopAt(state.index);
    card.classList.toggle('landscape', s.orientation === 'landscape');
  }

  function spin(targetIndex) {
    const icons = SLOPS.map((s) => s.icon);
    reel.innerHTML = '';
    for (let col = 0; col < 3; col++) {
      const strip = document.createElement('div');
      strip.className = 'c-strip';
      const n = 12 + col * 4;
      const land = col === 1 ? slopAt(targetIndex).icon : icons[Math.floor(Math.random() * icons.length)];
      strip.innerHTML = [...Array(n)].map((_, k) => `<div>${icons[(k + col) % icons.length]}</div>`).join('') + `<div>${land}</div>`;
      strip.style.transitionDuration = `${SPIN_MS * (0.6 + col * 0.2)}ms`;
      const win = document.createElement('div');
      win.className = 'c-win';
      win.append(strip);
      reel.append(win);
      requestAnimationFrame(() => requestAnimationFrame(() => (strip.style.transform = `translateY(-${n * 100}%)`)));
    }
    reel.hidden = false;
    return new Promise((r) => setTimeout(r, SPIN_MS + 200));
  }

  async function next() {
    if (spinning) return;
    const i = state.index + 1;
    if (!state.paid.has(i) && !charge(i, 'on PULL press')) return;
    spinning = true;
    await spin(i);
    goTo(i);
    sync();
    reel.hidden = true;
    spinning = false;
  }
  function prev() {
    if (spinning || state.index === 0) return;
    goTo(state.index - 1);
    sync();
  }

  root.querySelector('#pull').addEventListener('click', next);
  root.querySelector('#back').addEventListener('click', prev);
  onPullKeys(next, prev);
  subscribe(() => {
    const s = slopAt(state.index);
    root.querySelector('#title').textContent = `${s.icon} ${s.title}`;
    root.querySelector('#creator').textContent = s.creator;
    root.querySelector('#bal').textContent = `${state.balance.toFixed(2)} USDC`;
  });
  sync();
}
