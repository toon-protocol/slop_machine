// PROTOTYPE Slop input shim. In the real system `slop publish` would inject this into every Slop.
// The Feed owns every touch and forwards non-Pull input here (Feed → Slop only); this replays it as pointer + mouse
// events. The Slop can't talk back, so it can never trigger a Pull.
(() => {
  const FEED = `${location.protocol}//${location.hostname}:${Number(location.port) - 1}`;
  let target = null;
  let downAt = null;
  const fire = (el, type, x, y, Ctor) =>
    el.dispatchEvent(
      new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, pointerType: 'touch', isPrimary: true }),
    );
  addEventListener('message', (e) => {
    if (e.origin !== FEED || e.data?.type !== 'slop-input') return;
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
