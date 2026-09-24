# Research: do common Slop engines accept Feed-forwarded input?

Ticket: [#14](https://github.com/toon-protocol/slop_machine/issues/14) (part of map #1). Researched 2026-09-24.

**Question.** [What should pulling through the Feed feel like?](https://github.com/toon-protocol/slop_machine/issues/7) decided that the Feed owns every touch. It forwards non-Pull input into the Slop iframe with `postMessage`, and an injected shim replays it as synthetic events. The prototype shim (`prototype/feed-pull/slop/_shim.js` on `prototype/feed-pull`) emits `PointerEvent` + `MouseEvent` (+ `click`), single finger, `pointerId: 1`.

Which engines accept that input? Which ones listen only to touch or check `isTrusted`? Can the shim build synthetic `TouchEvent`s on iOS Safari and Android Chrome? What should it emit for the broadest compatibility, including multi-touch?

## TL;DR

- **No engine we checked looks at `isTrusted`.** That covers Phaser, PixiJS, Three.js controls, Kaplay, Kaboom, the Godot web input library (3.x and 4.x) and Emscripten's HTML5 input library, which Unity WebGL uses. Synthetic events reach their handlers.
- **The prototype shim misses in three places:**
  - It sends no touch events. Touch-only code gets nothing: plain `touchstart` games, Godot `TouchScreenButton` / `InputEventScreenTouch`, Kaplay `onTouchStart`, Unity `Input.touches`.
  - It sends no `mousemove` before `mousedown`. Kaplay reads the cursor position only from `mousemove`, so every tap lands at (0,0) and `onClick` never fires. Measured.
  - It is single-finger.
- **Emitting touch plus live mouse events is worse.** Phaser, Kaplay, Godot and Unity listen to both families. They rely on the browser's rule that a cancelled `touchstart` suppresses the mouse events, so a naive "fire everything" shim double-presses. Measured: Phaser and Kaplay registered 2 presses per tap.
- **Recommendation: the shim should replay exactly what a real mobile browser sends for a touch.** That way a Slop that works in mobile Safari or Chrome works in the Feed. Per finger:
  1. `pointerover`, `pointerenter`, `pointerdown` with `pointerType: "touch"` and a unique `pointerId` ≥ 2, then `touchstart`.
  2. `pointermove`, then `touchmove`.
  3. `pointerup`, `lostpointercapture`, `pointerout`, `pointerleave`, then `touchend`.
  4. Only after a single-finger tap that no `touchstart` listener cancelled: `mousemove`, `mousedown`, `mouseup` (skipped if `pointerdown` was cancelled), then `click`.
  Pointer events are implicitly captured to the `pointerdown` target, and touch events always go to the `touchstart` target. A reference implementation is below (§5). It passes every test in §4, including two-finger pinch.
- **Two browser details the shim has to handle:**
  - **Pointer capture.** `setPointerCapture(id)` throws `NotFoundError` for any pointerId the browser didn't create, and three.js `OrbitControls`/`TransformControls`/`TrackballControls` call it on every `pointerdown`. The prototype only works because `pointerId: 1` happens to be the mouse's id in both Chrome and WebKit. Any real multi-touch id breaks them. The shim must patch `setPointerCapture`/`releasePointerCapture`/`hasPointerCapture` for its own ids.
  - **Constructing touch events.** `new Touch()` + `new TouchEvent()` work in Chrome/Android. Open-source WebKit's `TouchEventInit` takes a `TouchList`, and iOS's implementation is closed source. So the shim feature-detects and falls back to a duck-typed `UIEvent` with `touches`/`targetTouches`/`changedTouches` arrays. Every engine tested accepts that too. `Touch.pageX`/`pageY` default to 0 and must be set explicitly, because Phaser reads `pageX`.
- **The biggest risk isn't the event set, it's user activation.** Synthetic events never grant user activation, and with the Feed owning every touch **the Slop never receives a real gesture.** Measured in Chromium:
  - `navigator.userActivation.isActive` stays `false`.
  - `requestFullscreen()` fails.
  - `AudioContext.resume()` only works because the iframe has `allow="autoplay"`: Chrome delegates autoplay from the activated top frame. Without it, audio stays `suspended`.
  - Whether iOS Safari honours `allow="autoplay"` for Web Audio in a cross-origin iframe is **unverified and the most important thing to test on a device.** If it doesn't, Slop audio never starts on iPhone.
- **Creators must be warned about:**
  - Mouse-only drag controls (they don't work on phones anyway).
  - Anything that needs a real user gesture: audio unlock on iOS (pending the device test), fullscreen, pointer lock, vibration, clipboard, opening windows.
  - Gestures the Feed eats: quick vertical flicks, unless the Slop declares them.
  - Unity games whose uGUI depends on `Input.mousePresent` (unverified, see §3).

## 1. What each engine listens to

Sources: engine source as published on npm (Phaser 4.2.1, pixi.js 8.21.0, three 0.186.0, kaplay 3001.0.19, kaboom 3000.1.17) and the upstream repos linked below. None of them references `isTrusted`, except PixiJS, which only *copies* it onto its federated event (`EventSystem._bootstrapEvent`: `event.isTrusted = nativeEvent.isTrusted`) and never branches on it.

| Engine | DOM events | Target | Needs from the shim | Notes |
|---|---|---|---|---|
| **Phaser 3/4** ([`MouseManager.js`](https://github.com/phaserjs/phaser/blob/master/src/input/mouse/MouseManager.js), [`TouchManager.js`](https://github.com/phaserjs/phaser/blob/master/src/input/touch/TouchManager.js)) | `mouse*` **and** `touch*`, no pointer events. `window.top` (falls back to `window` in a cross-origin frame) for out-of-canvas down/up | canvas | touch (multi-touch) or mouse (single pointer) | Touch handlers call `preventDefault()` when `input.touch.capture` is true (the default) and the event is `cancelable`. That's how Phaser avoids double input from compat mouse events. Touch is enabled when `'ontouchstart' in document.documentElement` or `maxTouchPoints ≥ 1` (`device/Input.js`). Positions come from `pageX`/`pageY`. |
| **PixiJS v8** ([`EventSystem.ts`](https://github.com/pixijs/pixijs/blob/dev/src/events/EventSystem.ts)) | **pointer only** when `globalThis.PointerEvent` exists. Falls back to mouse+touch otherwise | `pointerdown` on canvas, `pointermove` on `document`, `pointerup` on `window` (capture phase) | pointer events | Builds its own `pointertap`/`click` from down+up on the same display object, and sets `touch-action: none` on the canvas. |
| **Three.js core** | none (renderer has no input) | | | Apps hand-roll listeners, usually `pointer*` on the canvas or window. |
| **Three.js `OrbitControls`** ([source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/controls/OrbitControls.js)) | `pointerdown`/`pointercancel` on the element, then `pointermove`/`pointerup` on `ownerDocument`, plus `wheel`, `contextmenu` | `renderer.domElement` | pointer events with `pointerType: "touch"` (for pinch-dolly and two-finger pan) and **a working `setPointerCapture`** | `onPointerDown` calls `this.domElement.setPointerCapture(event.pointerId)` *before* doing anything else. It tracks fingers by `pointerId`. `TransformControls`, `TrackballControls` and `FirstPersonControls` also call `setPointerCapture`. |
| **Kaplay** ([`src/app/app.ts`](https://github.com/kaplayjs/kaplay/blob/master/src/app/app.ts)) / **Kaboom** ([`src/app.ts`](https://github.com/replit/kaboom/blob/master/src/app.ts)) | `mouse*` **and** `touch*` | canvas | touch, or mouse with a `mousemove` first | `mousePos` is updated **only** by `mousemove` (via `offsetX/Y`). `mousedown` just presses the button at the last known position. `touchstart` calls `preventDefault()` and, with `touchToMouse` (default on), also sets `mousePos` and presses "left". `onTouchStart`/`onTouchMove` fire only from touch events. |
| **Godot 4 web** ([`library_godot_input.js`](https://github.com/godotengine/godot/blob/master/platform/web/js/libs/library_godot_input.js), [`display_server_web.cpp`](https://github.com/godotengine/godot/blob/master/platform/web/display_server_web.cpp)) | `pointermove` on window, `mousedown` on canvas, `mouseup` on window, `touch*` on canvas | canvas / window | touch (for `InputEventScreenTouch`/`Drag`) and/or mouse | The touch handler calls `preventDefault()` when cancelable. Project defaults: `emulate_mouse_from_touch = true`, `emulate_touch_from_mouse = false` ([ProjectSettings](https://github.com/godotengine/godot/blob/master/doc/classes/ProjectSettings.xml)). So mouse-only input never reaches `InputEventScreenTouch` handlers or [`TouchScreenButton`](https://github.com/godotengine/godot/blob/master/scene/2d/physics/touch_screen_button.cpp), which only handles `InputEventScreenTouch`/`ScreenDrag`. Touch input reaches both touch and (emulated) mouse handlers. |
| **Godot 3 web** ([`library_godot_input.js` (3.x)](https://github.com/godotengine/godot/blob/3.x/platform/javascript/js/libs/library_godot_input.js)) | as Godot 4, but `mousemove` instead of `pointermove` | canvas / window | same | |
| **Unity WebGL** (closed runtime; input via Emscripten [`libhtml5.js`](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libhtml5.js)) | `mouse*` and `touch*` via `emscripten_set_*_callback` | canvas (what Unity passes) | touch (for `Input.touches`, Input System `Touchscreen`) and/or mouse | libhtml5 has no `isTrusted` check. It reads `e.touches`/`e.changedTouches` by iteration and tags each Touch object with its own fields, so a duck-typed event works. Legacy `Input.simulateMouseWithTouches` is on by default ([docs](https://docs.unity3d.com/ScriptReference/Input-simulateMouseWithTouches.html)). uGUI's `StandaloneInputModule` processes touches when `touchCount > 0`, else mouse if `input.mousePresent` ([source](https://github.com/Unity-Technologies/uGUI/blob/main/com.unity.ugui/Runtime/UGUI/EventSystem/InputModules/StandaloneInputModule.cs)). **Not tested:** no Unity build was available. The Unity rows are reasoned from these sources. |
| **Plain canvas with `touchstart`** | whatever the Creator wrote, typically `touch*` with `preventDefault()` | canvas | touch events with real `clientX/Y` **and** `pageX/Y` | Often also has `mousedown` for desktop. Works on phones only because `preventDefault()` on `touchstart` stops the compat mouse events. |

**What this means:** there are three camps.
1. Pointer-only: PixiJS, Three.js controls, most modern hand-rolled code.
2. Touch-plus-mouse, relying on `touchstart.preventDefault()` to dedupe: Phaser, Kaplay/Kaboom, Godot, Unity/Emscripten, typical plain canvas.
3. Mouse-only: desktop-first hand-rolled code.

Only a replay of the real browser sequence serves all three without double input.

## 2. Synthetic events: what the platform allows

- **`isTrusted` is always `false`** for `dispatchEvent`ed events ([DOM §isTrusted](https://dom.spec.whatwg.org/#dom-event-istrusted)). No engine checks it (§1).
- **Synthetic events trigger no default actions.** A synthetic `touchstart`/`pointerdown` does *not* make the browser generate compatibility mouse events or `click`. The shim must send every family itself, and must apply the browser's suppression rules itself:
  - Cancelling `touchstart` (or the first `touchmove`) suppresses mouse events and click ([Touch Events §mouse events](https://w3c.github.io/touch-events/#mouse-events)).
  - Cancelling `pointerdown` suppresses `mousedown`/`mouseup`/`mousemove` but not `click` ([Pointer Events §compatibility mapping](https://w3c.github.io/pointerevents/#compatibility-mapping-with-mouse-events)).
- **Synthetic events grant no user activation.** Activation-triggering input events must be trusted ([HTML §user activation](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event)). Measured in §4.
- **`setPointerCapture` only accepts active pointers.** "If the pointerId provided as the method's argument does not match any of the active pointers, then throw a `NotFoundError`" ([Pointer Events §setting pointer capture](https://w3c.github.io/pointerevents/#setting-pointer-capture)).
  - WebKit implements exactly that ([`PointerCaptureController.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/PointerCaptureController.cpp)). It pre-registers only `mousePointerID = 1` ([`PointerID.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/PointerID.h)).
  - Chromium's mouse is also `kMouseId = 1` ([`pointer_event_factory.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/events/pointer_event_factory.cc)).
  - So `pointerId: 1` works "by accident" on both, and every other synthetic id throws. Measured: `setPointerCapture(1)` → ok, `(2)` and `(7)` → `NotFoundError`.
  - Touch pointers are implicitly captured to the `pointerdown` target ([Pointer Events §implicit capture](https://w3c.github.io/pointerevents/#implicit-pointer-capture)), and the shim should do the same.
- **Constructing touch events:**
  - Chrome Android: `Touch()` and `TouchEvent()` constructors since 48. `TouchEvent` accepts sequences for `touches`/`targetTouches`/`changedTouches` (MDN BCD 8.1.3: `api.Touch.Touch`, `api.TouchEvent.TouchEvent`). `document.createTouch`/`createTouchList` were removed in Chrome 68/69.
  - iOS Safari: BCD lists the `Touch()` constructor and `TouchEvent()` as supported and `document.createTouch`/`createTouchList` as still present. But open-source WebKit's [`Touch.idl`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Touch.idl) has **no constructor**, and its [`TouchEvent.idl`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/TouchEvent.idl) `TouchEventInit` takes `TouchList?`, not sequences. The iOS implementation is closed source (`#if ENABLE(IOS_TOUCH_EVENTS)` → `WebKitAdditions/TouchEventIOS.h` in [`TouchEvent.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/TouchEvent.h)). **So iOS behaviour can't be settled from source.** The shim must feature-detect.
  - A duck-typed fallback works everywhere: a `UIEvent('touchstart', {bubbles, cancelable})` with `touches`/`targetTouches`/`changedTouches` defined as arrays with an `item()` method. Every engine in §1 reads these by index, `length` or iteration. Only PixiJS checks `instanceof TouchEvent`, and it uses pointer events when available. Measured identical results to native `TouchEvent` (§4, "duck").
  - `TouchInit` fields (`clientX`, `pageX`, `screenX`, `radiusX`, …) all default to 0, and `pageX` is **not** derived from `clientX` ([Touch Events, `TouchInit` IDL](https://w3c.github.io/touch-events/#dom-touchinit): `pageX = 0`). Measured: `pageX` 0 when only `clientX` is set. Synthetic `MouseEvent` does derive `pageX`/`offsetX`.

## 3. Unity: open points

- Emscripten's HTML5 layer accepts synthetic events. Unity's own glue code in `*.framework.js` isn't public source, so whether it adds anything on top couldn't be checked.
- `Input.mousePresent` on mobile WebGL wasn't verifiable from docs. If it's false on phones, uGUI buttons rely on touch events, and the prototype shim (mouse-only) would never click them. The recommended shim sends touch events, so it's covered either way.
- Unity unlocks WebAudio on a user gesture. The user-activation finding below applies.

## 4. Empirical check (headless Chromium 152, mobile emulation with touch)

Harness: real engine builds from npm, a 400×700 page, and gestures driven through each shim's handler. Throwaway, not committed.
- **Shims under test:**
  - `prototype`: the committed prototype logic.
  - `proposed`: §5.
  - `nopatch`: `proposed` without the `setPointerCapture` patch.
  - `naive`: `proposed` plus live mouse events during the gesture.
  - `duck`: `proposed` forced onto the duck-typed touch fallback.
- **Gestures:** tap on a target; one-finger horizontal drag; two-finger pinch-out.

| Engine | prototype | proposed | nopatch | naive | duck |
|---|---|---|---|---|---|
| Phaser | tap ✓, drag ✓, pinch ✗ (1 finger) | ✓ ✓ ✓ (2 pointers) | ✓ ✓ ✓ | **tap = 2 presses**, pinch = 3 pointers | ✓ ✓ ✓ |
| PixiJS | tap ✓ (`pointertap`), drag ✓, pinch ✗ | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ (ignores mouse) | ✓ ✓ ✓ |
| Three.js OrbitControls | tap ✓, drag ✓ (rotated), pinch ✗ (treated as rotate) | ✓, ✓, pinch dollied 10 → 2 | **throws `NotFoundError` in `onPointerDown`, dead** | ✓ ✓ ✓ | ✓ ✓ ✓ |
| Kaplay | **press at (0,0), `onClick` never fires**; `onTouchStart` never fires | ✓ press at (200,350), `onClick` ✓, `onTouchStart` ✓ | ✓ | **2 presses / 2 clicks per tap** | ✓ |
| Plain canvas (`touchstart` + `preventDefault`) | `touchstart` never fires | ✓ touches, `pageX` correct, 2 simultaneous touches, no stray mouse/click | ✓ | stray `mousedown`/`click` despite `preventDefault` | ✓ |

**User activation** (Feed at `localhost`, Slop at `127.0.0.1`, which is cross-site; `sandbox="allow-scripts allow-same-origin"`; `--autoplay-policy=document-user-activation-required`; a trusted tap on the Feed overlay, forwarded by the shim):

| Setup | `isTrusted` | `userActivation.isActive` | `AudioContext` after `resume()` | `requestFullscreen()` |
|---|---|---|---|---|
| Overlay + shim, no `allow` | false | false | **suspended** | fails |
| Overlay + shim, `allow="autoplay; fullscreen"` | false | false | running (delegated autoplay) | **fails** |
| Direct tap into iframe (control), `allow="autoplay; fullscreen"` | true | true | running | ok |

## 5. Recommended shim (reference implementation)

What `slop publish` injects. It's inlined, or referenced with a relative path, because gateways 404 root-absolute paths. It must run **before** the Slop's own scripts, so the capture patch is in place when engines boot. It checks the Feed's origin, and that `e.source === window.parent`.

```js
// Slop input shim (reference sketch). Replays Feed-forwarded fingers the way a real mobile browser does:
// per finger, pointer events (pointerType "touch", implicit capture) then touch events; after a tap, and only
// if no touchstart/pointerdown listener cancelled it, compatibility mouse events and a click.
// Message (Feed -> Slop only): { type: 'slop-input', kind: 'down'|'move'|'up'|'cancel', id: finger, x, y } (CSS px, client coords).
(() => {
  const FEED_ORIGIN = window.__SLOP_FEED_ORIGIN__; // set by the injected snippet
  const TAP_SLOP = 10;
  const base = { bubbles: true, cancelable: true, composed: true, view: window };

  // Chrome/Firefox: new Touch() + new TouchEvent() with arrays. WebKit's TouchEventInit wants a TouchList, which
  // only document.createTouchList() makes (removed from Chrome 69). Anything else: a duck-typed UIEvent.
  const nativeTouch = (() => {
    try {
      const t = new Touch({ identifier: 0, target: document.documentElement });
      return new TouchEvent('touchstart', { touches: [t] }).touches.length === 1;
    } catch {
      return false;
    }
  })();
  const list = (arr) => Object.assign(arr.slice(), { item: (i) => arr[i] ?? null });
  const makeTouch = (init) => (nativeTouch ? new Touch(init) : { ...init, rotationAngle: 0 });
  const makeTouchEvent = (type, lists) => {
    if (nativeTouch) return new TouchEvent(type, { ...base, ...lists });
    const e = new UIEvent(type, base);
    for (const [k, v] of Object.entries(lists)) Object.defineProperty(e, k, { value: list(v) });
    for (const k of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) Object.defineProperty(e, k, { value: false });
    return e;
  };

  const fingers = new Map(); // feed finger id -> state
  const byPointerId = new Map(); // synthetic pointerId -> state
  let nextPointerId = 2; // Chrome and WebKit reserve 1 for the mouse

  // Synthetic pointers aren't "active pointers", so native setPointerCapture() throws NotFoundError for them
  // (OrbitControls/TransformControls/TrackballControls call it in pointerdown). Emulate capture for our ids.
  const P = Element.prototype;
  const nSet = P.setPointerCapture, nRel = P.releasePointerCapture, nHas = P.hasPointerCapture;
  P.setPointerCapture = function (id) {
    const f = byPointerId.get(id);
    if (!f) return nSet.call(this, id);
    if (!this.isConnected) throw new DOMException('Element is not connected', 'InvalidStateError');
    f.capture = this;
  };
  P.releasePointerCapture = function (id) {
    const f = byPointerId.get(id);
    if (!f) return nRel.call(this, id);
    if (f.capture === this) f.capture = null;
  };
  P.hasPointerCapture = function (id) {
    const f = byPointerId.get(id);
    return f ? f.capture === this : nHas.call(this, id);
  };

  const at = (x, y) => document.elementFromPoint(x, y) ?? document.documentElement;
  const coords = (x, y) => ({ clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0) });

  const pointer = (el, type, f, extra = {}) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        ...base, ...coords(f.x, f.y),
        pointerId: f.pointerId, pointerType: 'touch', isPrimary: f.isPrimary,
        width: 1, height: 1, pressure: f.down ? 0.5 : 0,
        button: type === 'pointerdown' || type === 'pointerup' ? 0 : -1,
        buttons: f.down ? 1 : 0,
        ...extra,
      }),
    );

  const mouse = (el, type, x, y) =>
    el.dispatchEvent(
      new MouseEvent(type, { ...base, ...coords(x, y), button: 0, buttons: type === 'mousedown' ? 1 : 0, detail: type === 'mousemove' ? 0 : 1 }),
    );

  // Touch pageX/pageY default to 0 (not derived from clientX), so set them explicitly: Phaser reads pageX.
  const touchOf = (f) =>
    makeTouch({ identifier: f.id, target: f.target, ...coords(f.x, f.y), pageX: f.x + scrollX, pageY: f.y + scrollY, radiusX: 1, radiusY: 1, force: 0.5 });

  const touch = (type, f) => {
    const touches = [...fingers.values()].filter((g) => g.down).map(touchOf);
    return f.target.dispatchEvent(
      makeTouchEvent(type, { touches, targetTouches: touches.filter((t) => t.target === f.target), changedTouches: [touchOf(f)] }),
    );
  };

  const handle = ({ kind, id = 0, x, y }) => {
    if (kind === 'down') {
      if (fingers.has(id)) return;
      const target = at(x, y);
      const isPrimary = ![...fingers.values()].some((g) => g.down);
      // Touch pointers are implicitly captured to the pointerdown target.
      const f = { id, x, y, x0: x, y0: y, target, capture: target, down: true, moved: false, isPrimary, pointerId: nextPointerId++ };
      fingers.set(id, f);
      byPointerId.set(f.pointerId, f);
      pointer(target, 'pointerover', f);
      pointer(target, 'pointerenter', f, { bubbles: false, cancelable: false });
      f.pointerCancelled = !pointer(target, 'pointerdown', f);
      f.touchCancelled = !touch('touchstart', f);
      return;
    }
    const f = fingers.get(id);
    if (!f) return;
    f.x = x;
    f.y = y;
    if (Math.hypot(x - f.x0, y - f.y0) >= TAP_SLOP) f.moved = true;
    if (kind === 'move') {
      pointer(f.capture ?? at(x, y), 'pointermove', f);
      touch('touchmove', f);
      return;
    }
    f.down = false; // up / cancel
    const tgt = f.capture ?? at(x, y);
    pointer(tgt, kind === 'cancel' ? 'pointercancel' : 'pointerup', f, kind === 'cancel' ? { cancelable: false } : {});
    if (f.capture) pointer(f.capture, 'lostpointercapture', f, { cancelable: false });
    pointer(tgt, 'pointerout', f);
    pointer(tgt, 'pointerleave', f, { bubbles: false, cancelable: false });
    touch(kind === 'cancel' ? 'touchcancel' : 'touchend', f);
    fingers.delete(id);
    byPointerId.delete(f.pointerId);
    // Compatibility mouse events + click, as a browser sends them after an uncancelled single-finger tap.
    if (kind !== 'up' || !f.isPrimary || f.moved || f.touchCancelled) return;
    const m = at(x, y);
    if (!f.pointerCancelled) {
      mouse(m, 'mousemove', x, y);
      mouse(m, 'mousedown', x, y);
      mouse(m, 'mouseup', x, y);
    }
    mouse(m, 'click', x, y);
  };

  addEventListener('message', (e) => {
    if (e.origin !== FEED_ORIGIN || e.source !== window.parent || e.data?.type !== 'slop-input') return;
    handle(e.data);
  });
})();
```

**Design notes:**

- **Ordering** follows the browser: `pointerdown` before `touchstart`, pointer before touch on every step, and compat mouse events only after `touchend` of a tap ([Pointer Events §mapping for devices that support hover / don't](https://w3c.github.io/pointerevents/#mapping-for-devices-that-do-not-support-hover)).
- **Taps reach the Slop on release, as mouse/click.** This already happens: the Feed recogniser can't tell a tap from a flick until release. [What should pulling through the Feed feel like?](https://github.com/toon-protocol/slop_machine/issues/7) found the Player didn't notice.
  - Pointer and touch *down* can go out earlier: as soon as the recogniser has ruled out a Pull (hold ~120 ms, or horizontal movement).
  - If the Feed forwards `down` optimistically and then decides it was a Pull, it must send `cancel` (→ `pointercancel` + `touchcancel`). That's what browsers do when they take over a touch for scrolling.
- **Multi-touch needs the Feed to forward it.** The shim supports N fingers keyed by the Feed's finger id. The Feed recogniser must forward each finger with its own id, and treat a second finger landing as "not a Pull", so pinch and two-thumb controls work.
- **Coordinates are in the iframe's client space.** The Feed maps them through the letterbox offset and scale for landscape Slops. It sends CSS px, not device px.
- **Deliberately not emitted:**
  - Live mouse events during drags. Measured: they cause double input in the touch-plus-mouse engines.
  - `mouseover`/`mouseenter` hover events.
  - `gotpointercapture`.
  - Keyboard.
  - Gesture events (`gesturestart`, iOS-only).
  - `wheel`.

## 6. What Creators must be warned about (publish guidance / `slop publish` lint)

1. **Mouse-only drag controls** (`mousedown` + `mousemove` with no touch/pointer listeners) only get taps in the Feed. Same as on any phone. A static lint can flag Slops with `mousemove` listeners and no `touch*`/`pointer*` listeners.
2. **Anything that needs a real user gesture** fails or depends on the browser:
   - Web Audio unlock. Works in Chrome via `allow="autoplay"`. **iOS is unverified**; a device test is needed.
   - `<video>`/`<audio>` with sound.
   - `requestFullscreen` (fails).
   - Pointer lock (fails).
   - `navigator.vibrate`.
   - Clipboard write.
   - `window.open` (already blocked by the sandbox).
   - Engines that gate on `navigator.userActivation.isActive`, e.g. Emscripten's `canPerformEventHandlerRequests` used for fullscreen/pointer lock in Unity/Godot.
3. **Quick vertical flicks** are Pulls unless the listing declares "uses vertical flicks". That's already decided in [What should pulling through the Feed feel like?](https://github.com/toon-protocol/slop_machine/issues/7).
4. **Code that calls `setPointerCapture` for pointers it didn't receive, or relies on `gotpointercapture`,** may misbehave. That's rare.
5. **Unity WebGL** is untested here: test on a phone before publishing. The Unity Input System package's `Touchscreen`, and uGUI, depend on the unverified `Input.mousePresent` behaviour.
6. **Keyboard-only games** get nothing. The Feed forwards no keyboard, and phones have none.
7. **No Slop can rely on `isTrusted`.** No mainstream engine does, but a Creator's own anti-cheat or "real click" checks will reject forwarded input.

## Newly surfaced questions

- **Does iOS Safari let a cross-origin iframe with `allow="autoplay"` start Web Audio when only the top frame (the Feed) got the gesture?** If not, no Slop has sound on iPhone under "the Feed owns every touch". Options would include a Feed-side "unmute" tap that briefly passes a real touch through (`pointer-events: none` on the overlay for one tap), or accepting silent Slops on iOS. Needs a device test with the prototype. This probably belongs with [What should pulling through the Feed feel like?](https://github.com/toon-protocol/slop_machine/issues/7) follow-ups or the MVP spec.
- **iOS synthetic `TouchEvent` construction.** Which path does the shim take on iOS (native constructor, `createTouchList`, or the duck-typed fallback)? All three reach the engines tested, so this is a verification task, not a design risk.
- **Does the Feed forward multi-touch?** The shim supports it, but the Feed recogniser in the prototype is single-finger.

## Method

- Engine source was read from the npm-published builds, or from the source maps for Kaplay/Kaboom, and from upstream GitHub (Godot, Emscripten, uGUI, WebKit, Chromium).
- Browser support comes from MDN browser-compat-data 8.1.3 and the W3C Pointer Events / Touch Events and WHATWG HTML/DOM specs.
- The Chromium behaviour came from a throwaway playwright-core harness against `/usr/bin/chromium` 152 with mobile touch emulation. It isn't committed.
- iOS Safari and Unity were **not** run.
