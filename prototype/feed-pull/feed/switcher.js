// Prototype-only variant switcher. Sits top-centre, not bottom, because the bottom of a phone is where Pulls happen.
export function mountSwitcher(el, names, current) {
  const keys = Object.keys(names);
  const go = (delta) => {
    const next = keys[(keys.indexOf(current) + delta + keys.length) % keys.length];
    const url = new URL(location.href);
    url.searchParams.set('variant', next);
    location.replace(url);
  };
  el.innerHTML = `<button data-d="-1">‹</button><span>${current} · ${names[current]}</span><button data-d="1">›</button>`;
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.d))));
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  });
}
