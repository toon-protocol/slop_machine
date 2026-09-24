// PROTOTYPE Slop input shim. In the real system `slop publish` would inject this into every Slop.
// The Feed owns every touch and forwards non-Pull input here (Feed → Slop only); this replays it as pointer + mouse
// events. The Slop can't talk back, so it can never trigger a Pull.
(() => {
  let target = null;
  let downAt = null;
  const fire = (el, type, x, y, Ctor) =>
    el.dispatchEvent(
      new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, pointerType: 'touch', isPrimary: true }),
    );
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.type !== 'slop-input') return; // the Feed is on another site; trust only the parent frame

    const { kind, x, y } = e.data;
    if (kind === 'down') {
      target = document.elementFromPoint(x, y) ?? document.body;
      downAt = { x, y };
      fire(target, 'pointerdown', x, y, PointerEvent);
      fire(target, 'mousedown', x, y, MouseEvent);
    } else if (kind === 'move' && target) {
      fire(target, 'pointermove', x, y, PointerEvent);
      fire(target, 'mousemove', x, y, MouseEvent);
    } else if (kind === 'up' && target) {
      fire(target, 'pointerup', x, y, PointerEvent);
      fire(target, 'mouseup', x, y, MouseEvent);
      if (Math.hypot(x - downAt.x, y - downAt.y) < 10) fire(target, 'click', x, y, MouseEvent);
      target = null;
    }
  });
})();

// PROTOTYPE Purchase API (ticket #16). Also injected at publish, so a Creator calls `slop.pay(...)` with no script to include.
//   const r = await slop.pay({ tier: 5, item: 'golden-cookie', label: 'Golden Cookie' });
//   r.status: 'paid' | 'declined' | 'failed' | 'refused'   (never throws; a refusal carries r.reason)
// Slop → Feed is a *request*; only the Feed can pay. The receipt that comes back can be forged from devtools (accepted).
(() => {
  const waiting = new Map();
  let seq = 0;
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.type !== 'slop-receipt') return;
    const done = waiting.get(e.data.id);
    if (!done) return;
    waiting.delete(e.data.id);
    done(e.data);
    dispatchEvent(new CustomEvent('slop:receipt', { detail: e.data }));
  });
  window.slop = {
    pay({ tier, item, label }) {
      const id = `${Date.now().toString(36)}-${++seq}`;
      // '*' because a Slop can't know which Feed host embeds it; the request carries nothing secret.
      parent.postMessage({ type: 'slop-pay', id, tier, item: String(item ?? ''), label: String(label ?? '') }, '*');
      return new Promise((resolve) => waiting.set(id, resolve));
    },
  };
})();
