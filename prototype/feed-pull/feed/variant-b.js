// B · Chrome swipe, dwell charge
// Charge: only after 3 s on the Slop landed on; pulling away sooner is free. Cost: a countdown in the bottom bar.
// Autoplay: no, a Feed-owned "tap to play" cover; the iframe doesn't even load until tapped.
// Conflict: swipe up/down only on the top and bottom chrome bars. Landscape: the iframe is rotated 90° to fill portrait.
import { state, slopAt, makeFrame, charge, goTo, createSlides, onDrag, onPullKeys, subscribe, event, render, TOLL } from './common.js';

export const name = 'Chrome swipe, dwell charge';
const DWELL = 3000;

export function mount(root) {
  root.innerHTML = `
    <div class="b">
      <header class="b-bar b-top" id="top"><div><b id="title"></b><small id="creator"></small></div><span class="chip" id="bal"></span></header>
      <main class="b-stage" id="stage"></main>
      <footer class="b-bar b-bottom" id="bottom"><div class="b-handle"></div><div id="cta"></div><div class="b-meter" id="meter"></div></footer>
    </div>`;
  const stage = root.querySelector('#stage');

  const slides = createSlides(stage, (i) => {
    const s = slopAt(i);
    const el = document.createElement('div');
    el.className = s.orientation === 'landscape' ? 'b-rot' : '';
    const cover = document.createElement('button');
    cover.className = 'b-cover';
    cover.innerHTML = `<span>${s.icon}</span>▶ Tap to play<small>${s.title}${s.orientation === 'landscape' ? ' · turn phone sideways' : ''}</small>`;
    cover.addEventListener('click', () => {
      const f = makeFrame(s);
      el.append(f);
      cover.remove();
      f.addEventListener('load', () => f.focus({ preventScroll: true }));
      event(`started #${i} ${s.title}`);
    });
    el.append(cover);
    return el;
  });

  let timer = null;
  function arm() {
    const i = state.index;
    if (state.paid.has(i)) return;
    state.pending = { index: i, until: Date.now() + DWELL };
    timer = setTimeout(() => {
      state.pending = null;
      timer = null;
      if (!charge(i, `after ${DWELL / 1000}s dwell`)) prev();
      render();
    }, DWELL);
  }
  function disarm() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    event(`left #${state.pending.index} within ${DWELL / 1000}s, free`);
    state.pending = null;
  }

  function next() {
    disarm();
    goTo(state.index + 1);
    slides.sync();
    arm();
    render();
  }
  function prev() {
    if (state.index === 0) return;
    disarm();
    goTo(state.index - 1);
    slides.sync();
    arm();
    render();
  }

  for (const bar of [root.querySelector('#top'), root.querySelector('#bottom')])
    onDrag(bar, {
      start: () => (stage.style.transition = 'none'),
      move: (dy) => (stage.style.transform = `translateY(${dy * 0.4}px)`),
      end: (dy) => {
        stage.style.transition = '';
        stage.style.transform = '';
        if (dy < -40) next();
        else if (dy > 40) prev();
        else event(`swipe too short (${Math.round(dy)}px), no pull`);
      },
    });

  onPullKeys(next, prev);
  subscribe(() => {
    const s = slopAt(state.index);
    root.querySelector('#title').textContent = s.title;
    root.querySelector('#creator').textContent = s.creator;
    root.querySelector('#bal').textContent = `${state.balance.toFixed(2)} USDC`;
    const cta = root.querySelector('#cta');
    const meter = root.querySelector('#meter');
    if (state.pending) {
      const left = Math.max(0, state.pending.until - Date.now());
      cta.textContent = `paying ${TOLL.toFixed(2)} in ${(left / 1000).toFixed(1)}s · swipe away to skip free`;
      meter.style.width = `${100 - (left / DWELL) * 100}%`;
    } else {
      cta.textContent = state.paid.has(state.index) ? `paid ✓ · swipe up to pull · ${TOLL.toFixed(2)}` : `swipe up to pull · ${TOLL.toFixed(2)}`;
      meter.style.width = '0';
    }
  });
}
