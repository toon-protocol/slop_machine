// Prototype-only variant switcher. Sits top-centre, not bottom, because the bottom of a phone is where Pulls happen.
export function mountSwitcher(el, names, current, param = 'variant') {
  const keys = Object.keys(names);
  const go = (delta) => {
    const next = keys[(keys.indexOf(current) + delta + keys.length) % keys.length];
    try {
      localStorage.setItem(param, next);
    } catch {}
    const url = new URL(location.href);
    url.searchParams.set(param, next);
    location.replace(url);
  };
  el.innerHTML = `<button data-d="-1">‹</button><span>${param === 'variant' ? '' : `${param} `}${current} · ${names[current]}</span><button data-d="1">›</button>`;
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.d))));
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const [back, fwd] = param === 'variant' ? ['ArrowLeft', 'ArrowRight'] : ['[', ']'];
    if (e.key === back) go(-1);
    if (e.key === fwd) go(1);
  });
}
