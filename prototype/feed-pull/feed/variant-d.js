// D · Browse / play modes
// Charge: on swipe (prepaid). Cost: a price chip in the caption. Autoplay: yes, but inert under a Feed-owned shield.
// Conflict: in browse mode the Feed owns every touch, so you swipe anywhere; a tap enters play mode, where the Slop owns
// every touch until "back to Feed". Landscape: letterboxed.
import { state, slopAt, makeFrame, charge, goTo, createSlides, onDrag, onPullKeys, subscribe, event, TOLL } from './common.js';

export const name = 'Browse / play modes';

export function mount(root) {
  root.innerHTML = `
    <div class="d" id="d">
      <div class="d-stage" id="stage"></div>
      <div class="d-caption"><b id="title"></b><small id="creator"></small></div>
      <span class="chip d-price">${TOLL.toFixed(2)} USDC / pull</span>
      <span class="chip d-bal" id="bal"></span>
      <button class="d-exit" id="exit" hidden>⌃ back to Feed</button>
    </div>`;
  const d = root.querySelector('#d');
  const stage = root.querySelector('#stage');
  const exit = root.querySelector('#exit');

  const slides = createSlides(stage, (i) => {
    const s = slopAt(i);
    const el = document.createElement('div');
    if (s.orientation === 'landscape') {
      el.innerHTML = `<div class="a-letterbox"></div>`;
      el.firstChild.append(makeFrame(s));
    } else el.append(makeFrame(s));
    const shield = document.createElement('div');
    shield.className = 'd-shield';
    shield.innerHTML = `<span>tap to play · swipe ↕ to pull</span>`;
    el.append(shield);
    return el;
  });

  let playing = false;
  function setPlaying(on) {
    if (playing === on) return;
    playing = on;
    d.classList.toggle('playing', on);
    exit.hidden = !on;
    event(on ? `play mode on #${state.index}, Slop owns every touch` : 'browse mode, swipe anywhere');
  }

  function next() {
    setPlaying(false);
    const i = state.index + 1;
    if (!state.paid.has(i) && !charge(i, 'on swipe')) return;
    goTo(i);
    slides.sync();
  }
  function prev() {
    setPlaying(false);
    if (state.index === 0) return;
    goTo(state.index - 1);
    slides.sync();
  }

  onDrag(stage, {
    start: () => (stage.style.transition = 'none'),
    move: (dy) => (stage.style.transform = `translateY(${dy * 0.5}px)`),
    end: (dy, dx) => {
      stage.style.transition = '';
      stage.style.transform = '';
      if (dy < -50) next();
      else if (dy > 50 && state.index > 0) prev();
      else if (Math.abs(dy) < 10 && Math.abs(dx) < 10) setPlaying(true);
      else event(`swipe too short (${Math.round(dy)}px), no pull`);
    },
  });
  exit.addEventListener('click', () => setPlaying(false));

  onPullKeys(next, prev);
  subscribe(() => {
    const s = slopAt(state.index);
    root.querySelector('#title').textContent = `${s.icon} ${s.title}`;
    root.querySelector('#creator').textContent = s.creator;
    root.querySelector('#bal').textContent = `${state.balance.toFixed(2)} USDC`;
  });
}
