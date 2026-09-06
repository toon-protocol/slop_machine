/**
 * The page the demo serves at `/`.
 *
 * INLINE, as one string, and deliberately. `demo.ts` is bundled to a single
 * file before it runs — the devnet's modules import each other by the `.js`
 * specifiers the compiler wants, which node will not resolve to `.ts` on its
 * own — and a bundle has no directory to read a sibling `.html` out of. A file
 * that had to be found at run time would be a file that is missing exactly
 * once, on somebody else's machine, at a demo.
 *
 * It renders the one thing that is hard to see in a green test: that a picture
 * on a screen is arriving one paid packet at a time, and that choosing a rung
 * is choosing a price.
 */

/** Pinned, and from the one CDN — a demo that broke on a silent upgrade would be worse than no demo. */
const HLS_JS =
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js';

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>slop machine — the devnet, live</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0c0f;
    --card: #14161c;
    --line: #242833;
    --ink: #e8eaf0;
    --dim: #8b93a7;
    --live: #4ade80;
    --cold: #64748b;
    --money: #fbbf24;
    --hub: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 22px; border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .01em; }
  .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); font-size: 12.5px; }
  .pill {
    margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--cold); border: 1px solid var(--line);
    border-radius: 999px; padding: 4px 11px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cold); }
  .pill.on { color: var(--live); border-color: #1d4a30; }
  .pill.on .dot { background: var(--live); box-shadow: 0 0 0 3px #4ade8022; }
  main { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 20px; padding: 20px 22px; align-items: start; }
  @media (max-width: 900px) { main { grid-template-columns: minmax(0,1fr); } }
  .stage { background: #000; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  video { display: block; width: 100%; aspect-ratio: 16/9; background: #000; }
  .waiting {
    display: flex; align-items: center; justify-content: center; text-align: center;
    aspect-ratio: 16/9; color: var(--dim); font-size: 13px; padding: 24px; line-height: 1.7;
  }
  .rungs { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); flex-wrap: wrap; }
  button.rung {
    flex: 1 1 130px; text-align: left; cursor: pointer; color: var(--ink);
    background: #0f1116; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; font: inherit;
  }
  button.rung:hover { border-color: #33394a; }
  button.rung[aria-pressed="true"] { border-color: #3b82f6; background: #12203a; }
  .rung .name { font-weight: 600; font-size: 13px; }
  .rung .cost { color: var(--money); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .rung .split { color: var(--dim); font-size: 11px; margin-top: 2px; }
  aside { display: flex; flex-direction: column; gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 15px; }
  .card h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; }
  .row span:last-child { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
  .big { font-family: ui-monospace, Menlo, monospace; font-size: 26px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .money { color: var(--money); }
  .hub { color: var(--hub); }
  .unit { font-size: 11px; color: var(--dim); margin-top: 2px; }
  button.redeem {
    width: 100%; margin-top: 10px; cursor: pointer; font: inherit; font-weight: 600;
    color: #0b0c0f; background: var(--money); border: 0; border-radius: 8px; padding: 9px;
  }
  button.redeem:disabled { opacity: .45; cursor: default; }
  .note { color: var(--dim); font-size: 11.5px; line-height: 1.6; margin-top: 9px; }
  footer { padding: 4px 22px 26px; color: var(--dim); font-size: 11.5px; }
  code { font-family: ui-monospace, Menlo, monospace; color: #a5b4fc; }
</style>
</head>
<body>
<header>
  <h1>slop machine</h1>
  <span class="addr" id="prefix">…</span>
  <span class="pill" id="pill"><span class="dot"></span><span id="pilltext">waiting</span></span>
</header>

<main>
  <section class="stage">
    <div class="waiting" id="waiting">waiting for the broadcaster…</div>
    <video id="video" controls autoplay muted playsinline hidden></video>
    <div class="rungs" id="rungs"></div>
  </section>

  <aside>
    <div class="card">
      <h2>What this viber has spent</h2>
      <div class="big money" id="spent">0</div>
      <div class="unit">base units · 6 decimals · <span id="packets">0</span> paid packets</div>
      <div class="note">
        Every segment on the left was bought one at a time. Nothing here is a
        subscription, and no card was ever entered.
      </div>
    </div>

    <div class="card">
      <h2>Where the money went</h2>
      <div class="row"><span>to the broadcaster</span><span class="money" id="tostation">0</span></div>
      <div class="row"><span>to the hub, for carriage</span><span class="hub" id="tohub">0</span></div>
    </div>

    <div class="card">
      <h2>The broadcaster</h2>
      <div class="row"><span>banked, off chain</span><span id="claimed">0</span></div>
      <div class="row"><span>on chain</span><span class="money" id="onchain">0</span></div>
      <button class="redeem" id="redeem">Redeem on chain</button>
      <div class="note" id="redeemnote">
        A claim is a signature, not a transaction. This turns the newest one
        into money on anvil — and the channel stays open, so the vibes keep
        flowing while it settles.
      </div>
    </div>
  </aside>
</main>

<footer>
  Not watching in a browser? <code id="ffplay">…</code>
</footer>

<script src="${HLS_JS}" crossorigin="anonymous"></script>
<script>
(function () {
  var video = document.getElementById('video');
  var waiting = document.getElementById('waiting');
  var rungsEl = document.getElementById('rungs');
  var redeemBtn = document.getElementById('redeem');
  var chosen = null;
  var attached = null;
  var hls = null;

  var n = function (value) { return Number(value || 0).toLocaleString('en-US'); };

  function attach(rung) {
    if (attached === rung) return;
    attached = rung;
    var src = '/hls/' + rung + '.m3u8';

    if (hls) { hls.destroy(); hls = null; }

    if (window.Hls && window.Hls.isSupported()) {
      // A live window that is only ever a few segments deep: hold close to its
      // edge, and jump rather than stall when the window slides past us.
      hls = new window.Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 6 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, function (_e, data) {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      });
    } else {
      // Safari, and anything else that plays HLS natively.
      video.src = src;
    }
    video.play().catch(function () { /* autoplay policy; the controls are there */ });
  }

  function drawRungs(state) {
    if (rungsEl.childElementCount === state.rungs.length) return;
    rungsEl.innerHTML = '';
    state.rungs.forEach(function (rung) {
      var b = document.createElement('button');
      b.className = 'rung';
      b.type = 'button';
      b.dataset.rung = rung.rung;
      b.innerHTML =
        '<div class="name">' + rung.rung + '</div>' +
        '<div class="cost">' + n(rung.price) + ' / segment</div>' +
        '<div class="split">' + n(rung.toStation) + ' broadcaster · ' + n(rung.toHub) + ' hub</div>';
      b.addEventListener('click', function () {
        chosen = rung.rung;
        attach(chosen);
        mark();
      });
      rungsEl.appendChild(b);
    });
    mark();
  }

  function mark() {
    Array.prototype.forEach.call(rungsEl.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.rung === chosen));
    });
  }

  function paint(state) {
    document.getElementById('prefix').textContent = state.stationPrefix || '';
    var pill = document.getElementById('pill');
    pill.classList.toggle('on', !!state.live);
    document.getElementById('pilltext').textContent = state.live ? 'on the air' : (state.waitingFor || 'waiting');

    drawRungs(state);

    var anyBought = false;
    state.rungs.forEach(function (rung) {
      if (rung.bought > 0) anyBought = true;
    });
    document.getElementById('spent').textContent = n(state.spent);
    document.getElementById('packets').textContent = n(state.packets);
    document.getElementById('claimed').textContent = n(state.claimed);
    document.getElementById('onchain').textContent = n(state.onChain);
    // Split by the two nodes' own prices, and totalled by the driver — the
    // /now pulls are part of it, so this is not rungs times counts.
    document.getElementById('tostation').textContent = n(state.toStation);
    document.getElementById('tohub').textContent = n(state.toHub);

    redeemBtn.disabled = !!state.redeeming || Number(state.claimed) === 0;
    redeemBtn.textContent = state.redeeming ? 'Redeeming…' : 'Redeem on chain';
    if (state.redeemed) {
      document.getElementById('redeemnote').textContent =
        'Last redemption moved ' + n(state.redeemed.moved) + ' base units on chain. The channel is still open.';
    }

    if (anyBought) {
      if (!chosen) {
        // The dearest rung that is actually holding vibes — a demo should open
        // on the picture, not on the sound.
        var withVibes = state.rungs.filter(function (r) { return r.bought > 0; });
        chosen = withVibes[withVibes.length - 1].rung;
        attach(chosen);
        mark();
      }
      waiting.hidden = true;
      video.hidden = false;
    } else {
      waiting.textContent = state.waitingFor || 'waiting for the broadcaster…';
    }

    document.getElementById('ffplay').textContent =
      'ffplay ' + location.origin + '/hls/' + (chosen || state.rungs.map(function (r) { return r.rung; }).pop() || 'audio') + '.m3u8';
  }

  redeemBtn.addEventListener('click', function () {
    redeemBtn.disabled = true;
    fetch('/api/redeem', { method: 'POST' }).catch(function () {});
  });

  function poll() {
    fetch('/api/state')
      .then(function (r) { return r.json(); })
      .then(paint)
      .catch(function () {})
      .then(function () { setTimeout(poll, 1000); });
  }
  poll();
})();
</script>
</body>
</html>
`;
