// A · Edge lever
// Charge: on pull (prepaid, instant). Cost: printed on the lever, always visible.
// Autoplay: yes, the next Slop is already running. Conflict: the gesture lives only in a Feed-owned right-edge rail;
// the whole rest of the screen is the Slop's. Landscape: letterboxed inside portrait.
import { state, slopAt, makeFrame, charge, goTo, createSlides, onDrag, onPullKeys, subscribe, event, TOLL } from './common.js';

export const name = 'Edge lever';

export function mount(root) {
  root.innerHTML = `
    <div class="a">
      <div class="a-stage" id="stage"></div>
      <div class="a-rail" id="rail">
        <div class="a-price">${TOLL.toFixed(2)}<small>USDC</small></div>
        <div class="a-track"><div class="a-knob" id="knob">🎰</div></div>
        <div class="a-hint">pull<br />lever<br />down</div>
        <div class="a-bal" id="bal"></div>
      </div>
    </div>`;
  const stage = root.querySelector('#stage');
  const rail = root.querySelector('#rail');
  const knob = root.querySelector('#knob');

  const slides = createSlides(stage, (i) => {
    const s = slopAt(i);
    const el = document.createElement('div');
    if (s.orientation === 'landscape') {
      el.innerHTML = `<div class="a-letterbox"><div class="a-caption">${s.title} · landscape, letterboxed</div></div>`;
      el.firstChild.prepend(makeFrame(s));
    } else el.append(makeFrame(s));
    return el;
  });

  function next() {
    const i = state.index + 1;
    if (!state.paid.has(i) && !charge(i, 'on pull')) return;
    goTo(i);
    slides.sync();
  }
  function prev() {
    if (state.index === 0) return;
    goTo(state.index - 1);
    slides.sync();
  }

  onDrag(rail, {
    start: () => (knob.style.transition = 'none'),
    move: (dy) => {
      dy = Math.max(-80, Math.min(160, dy));
      knob.style.transform = `translateY(${dy}px)`;
      rail.classList.toggle('armed', dy > 110);
    },
    end: (dy) => {
      knob.style.transition = '';
      knob.style.transform = '';
      rail.classList.remove('armed');
      if (dy > 110) next();
      else if (dy < -60) prev();
      else event(`lever released short (${Math.round(dy)}px), no pull`);
    },
  });

  onPullKeys(next, prev);
  subscribe(() => (root.querySelector('#bal').textContent = state.balance.toFixed(2)));
}
