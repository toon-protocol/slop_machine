// THROWAWAY measurement harness for ticket #28. See index.html for what each tab measures.
const $ = (s) => document.querySelector(s);
const SLOP_BASE = new URL('slop/', location.href).href; // override with ?slop=<base url> to serve Slop from another host
const slopBase = new URLSearchParams(location.search).get('slop') ?? SLOP_BASE;
const TIMEOUT_MS = 240_000; // an L Slop on emulated 3G can take minutes
const KEY = 'slop-load-results';

let results = [];
try { results = JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(results)); } catch {} };
const record = (r) => { results.push({ at: new Date().toISOString(), net: $('#net').value, note: $('#note').value, ...r }); save(); render(); };
const status = (s) => ($('#status').textContent = s);
const rid = () => Math.random().toString(36).slice(2, 10);
const ms = (n) => (n == null ? '–' : n >= 10_000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + '');
const median = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const p90 = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.ceil(a.length * 0.9) - 1] : null; };

// Tabs
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  }),
);

// Load one Slop into `host`, resolving with its timings measured on the Feed's clock from iframe creation.
// `onReady` fires at slop-ready, so the Feed can land on it before the first frame.
function loadSlop(host, size, nonce, { onReady, style } = {}) {
  const run = rid();
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts'); // opaque origin, like a Slop on another site
  if (style) Object.assign(f.style, style);
  const t0 = performance.now();
  const out = { size, run, frameEl: f };
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => finish({ error: 'timeout' }), TIMEOUT_MS);
    function finish(extra) { clearTimeout(timer); removeEventListener('message', onMsg); resolve(Object.assign(out, extra)); }
    function onMsg(e) {
      const d = e.data;
      if (e.source !== f.contentWindow || d?.run !== run) return;
      const t = performance.now() - t0;
      if (d.type === 'slop-load') out.load = t;
      if (d.type === 'slop-ready') { Object.assign(out, { ready: t, bytes: d.bytes, transfer: d.transfer, fetched: d.fetchedAt, html: d.htmlAt, hostCache: d.cache }); onReady?.(out); }
      if (d.type === 'slop-frame') { out.frame = t; finish({}); }
      if (d.type === 'slop-error') finish({ error: d.error });
    }
    addEventListener('message', onMsg);
  });
  f.src = `${slopBase}${size}/index.html?run=${run}&a=${nonce}`;
  host.append(f);
  out.done = done;
  return out;
}

// Bench
$('#runBench').addEventListener('click', async () => {
  const reps = Math.max(1, Math.min(10, +$('#reps').value || 3));
  const stage = $('#stage');
  let i = 0;
  const total = reps * 3 * 2;
  for (let rep = 1; rep <= reps; rep++) {
    for (const size of ['s', 'm', 'l']) {
      const nonce = rid(); // cold: new URLs; warm: the same URLs straight after
      for (const cache of ['cold', 'warm']) {
        status(`Bench ${++i}/${total}: ${size.toUpperCase()} ${cache}, rep ${rep}…`);
        stage.replaceChildren();
        const r = await loadSlop(stage, size, nonce).done;
        record({ kind: 'bench', size, cache, rep, ready: r.ready, frame: r.frame, load: r.load, html: r.html, bytes: r.bytes, transfer: r.transfer, hostCache: r.hostCache, error: r.error });
      }
    }
  }
  stage.replaceChildren();
  status('Bench done.');
});

// Feed: one-ahead, flick up to Pull
$('#runFeed').addEventListener('click', () => {
  const feed = $('#feed');
  const hud = $('#hud');
  const weights = $('#mix').value.split(',').map((p) => p.split(':')).map(([s, w]) => [s, +w]);
  const pick = () => { let x = Math.random() * weights.reduce((n, [, w]) => n + w, 0); for (const [s, w] of weights) if ((x -= w) < 0) return s; return weights[0][0]; };
  const cold = $('#feedCache').value === 'cold';
  const rtt = +$('#rtt').value;
  const warmNonces = { s: rid(), m: rid(), l: rid() }; // warm: every deal of a size reuses one set of URLs the CDN has seen
  const session = rid();
  const flicks = [];
  let cur = null, next = null, landedAt = 0, waiting = null, ended = false;
  feed.replaceChildren(hud, $('#quit'));
  feed.style.display = 'block';
  const layer = (el, z) => Object.assign(el.style, { zIndex: z });

  function deal() {
    const size = pick();
    const n = loadSlop(feed, size, cold ? rid() : warmNonces[size], { style: { zIndex: 0 }, onReady: () => { hudUpdate(); waiting?.(n); } });
    n.dealtAt = performance.now();
    n.done.then((r) => { if (r.error && !ended) { record({ kind: 'feed-fail', session, size, error: r.error }); if (next === n) { n.frameEl.remove(); next = deal(); } } });
    return n;
  }
  function land(n) {
    cur?.frameEl.remove();
    cur = n;
    layer(n.frameEl, 2);
    landedAt = performance.now();
    feed.querySelector('.card')?.remove();
    next = null;
    setTimeout(() => { if (!ended) next = deal(); hudUpdate(); }, rtt);
    hudUpdate();
  }
  function hudUpdate() {
    const stalls = flicks.filter((f) => f.stall > 0);
    hud.textContent = `flicks ${flicks.length} · stalled ${stalls.length} · median dwell ${ms(median(flicks.map((f) => f.dwell)))} · now ${cur?.size.toUpperCase() ?? '–'} · next ${next ? next.size.toUpperCase() + (next.ready != null ? ' ready' : ' loading…') : 'pulling…'}`;
  }
  function pull() {
    if (!cur || waiting) return;
    const flickAt = performance.now();
    const dwell = flickAt - landedAt;
    const go = (n) => {
      waiting = null;
      const stall = performance.now() - flickAt;
      flicks.push({ dwell, stall: stall < 5 ? 0 : stall, size: n.size, readyAfterDeal: n.ready, headStart: flickAt - (n.dealtAt ?? flickAt) });
      record({ kind: 'feed', session, cache: cold ? 'cold' : 'warm', rtt, mix: $('#mix').value, dwell, stall: stall < 5 ? 0 : stall, size: n.size, ready: n.ready, headStart: flickAt - (n.dealtAt ?? flickAt) });
      land(n);
    };
    if (next?.ready != null) return go(next);
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = 'Loading…';
    card.style.zIndex = 5;
    feed.append(card);
    waiting = go; // called by the next Slop's onReady (or by the one dealt after the Pull round trip)
    const poll = setInterval(() => { if (!waiting) return clearInterval(poll); if (next?.ready != null) { clearInterval(poll); go(next); } }, 50);
  }
  let y0 = null;
  feed.ontouchstart = (e) => { y0 = e.touches[0].clientY; };
  feed.ontouchend = (e) => { if (y0 != null && y0 - e.changedTouches[0].clientY > 60) pull(); y0 = null; };
  feed.onwheel = (e) => { if (e.deltaY > 30) pull(); };
  onkeydown = (e) => { if (e.key === 'ArrowDown' || e.key === ' ') pull(); };
  $('#quit').onclick = () => {
    ended = true;
    feed.style.display = 'none';
    feed.replaceChildren(hud, $('#quit'));
    onkeydown = null;
    status(`Feed session: ${flicks.length} flicks, ${flicks.filter((f) => f.stall > 0).length} stalled.`);
  };
  // Session open: the first entry is free and landed, and the next preloads (per the Pull-unlock decision).
  const first = deal();
  waiting = (n) => { if (n === first) { waiting = null; land(first); } };
  hud.textContent = 'Opening session…';
});

// Gateway: random old Arweave data of Slop-like sizes, fetched twice
const BUCKETS = { s: [50e3, 200e3], m: [1e6, 3e6], l: [7e6, 10.5e6] };
async function findTxs() {
  const want = { s: null, m: null, l: null };
  for (let attempt = 0; attempt < 8 && Object.values(want).some((v) => !v); attempt++) {
    const min = 500_000 + Math.floor(Math.random() * 900_000);
    const query = `{ transactions(first: 100, tags:[{name:"Content-Type", values:["image/png","image/jpeg","application/javascript","application/wasm","audio/mpeg","video/mp4","application/octet-stream"]}], block:{min:${min},max:${min + 20000}}) { edges { node { id data { size } } } } }`;
    const res = await fetch('https://arweave-search.goldsky.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    const edges = (await res.json()).data?.transactions?.edges ?? [];
    for (const { node } of edges.sort(() => Math.random() - 0.5)) {
      const size = +node.data.size;
      for (const [b, [lo, hi]] of Object.entries(BUCKETS)) if (!want[b] && size >= lo && size <= hi) want[b] = { id: node.id, size };
    }
  }
  return want;
}
$('#runGw').addEventListener('click', async () => {
  const gw = $('#gw').value;
  status('Finding random old Arweave data…');
  let txs;
  try { txs = await findTxs(); } catch (e) { return status('GraphQL failed: ' + e.message); }
  for (const [size, tx] of Object.entries(txs)) {
    if (!tx) { record({ kind: 'gw', gw, size, error: 'no tx found' }); continue; }
    for (const cache of ['cold', 'warm']) {
      status(`Gateway ${gw}: ${size.toUpperCase()} ${(tx.size / 1e6).toFixed(2)} MB ${cache}…`);
      const t0 = performance.now();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        const res = await fetch(`https://${gw}/${tx.id}`, { cache: 'no-store', signal: ctl.signal });
        const ttfb = performance.now() - t0;
        const body = await res.arrayBuffer();
        clearTimeout(timer);
        record({ kind: 'gw', gw, size, cache, tx: tx.id, bytes: body.byteLength, ttfb, ready: performance.now() - t0, http: res.status, hostCache: res.headers.get('x-cache-status') ?? res.headers.get('x-cache') });
      } catch (e) {
        record({ kind: 'gw', gw, size, cache, tx: tx.id, error: String(e.message ?? e) });
      }
    }
  }
  status('Gateway probe done.');
});

// Results
function render() {
  const groups = new Map();
  for (const r of results.filter((r) => r.kind === 'bench' || r.kind === 'gw')) {
    const k = [r.net, r.kind === 'gw' ? `gw ${r.gw}` : 'bench', r.size, r.cache].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let html = '<table><tr><th>net · where · size · cache</th><th>n</th><th>MB</th><th>ready p50</th><th>ready max</th><th>frame p50</th><th>err</th></tr>';
  for (const [k, rs] of groups) {
    const ok = rs.filter((r) => !r.error);
    html += `<tr><td>${k.replaceAll('|', ' · ')}</td><td>${ok.length}</td><td>${ok[0]?.bytes ? (ok[0].bytes / 1e6).toFixed(2) : '–'}</td><td>${ms(median(ok.map((r) => r.ready)))}</td><td>${ms(Math.max(...ok.map((r) => r.ready ?? 0)) || null)}</td><td>${ms(median(ok.map((r) => r.frame)))}</td><td class="${rs.length > ok.length ? 'err' : ''}">${rs.length - ok.length}</td></tr>`;
  }
  html += '</table>';
  const feeds = results.filter((r) => r.kind === 'feed');
  if (feeds.length) {
    const sessions = new Map();
    for (const r of feeds) { if (!sessions.has(r.session)) sessions.set(r.session, []); sessions.get(r.session).push(r); }
    html += '<table><tr><th>feed session (net · cache · mix)</th><th>flicks</th><th>dwell p50</th><th>dwell p10</th><th>stalled</th><th>stall p50</th><th>stall max</th></tr>';
    for (const rs of sessions.values()) {
      const st = rs.filter((r) => r.stall > 0);
      const d = rs.map((r) => r.dwell).sort((a, b) => a - b);
      html += `<tr><td>${rs[0].net} · ${rs[0].cache} · ${rs[0].mix}</td><td>${rs.length}</td><td>${ms(median(d))}</td><td>${ms(d[Math.floor(d.length * 0.1)])}</td><td>${st.length}</td><td>${ms(median(st.map((r) => r.stall)))}</td><td>${ms(st.length ? Math.max(...st.map((r) => r.stall)) : null)}</td></tr>`;
    }
    html += '</table>';
  }
  $('#results').innerHTML = html;
}
$('#copy').addEventListener('click', async () => {
  const text = JSON.stringify({ ua: navigator.userAgent, host: location.host, results }, null, 1);
  try { await navigator.clipboard.writeText(text); status(`Copied ${results.length} results.`); } catch { const d = $('#dump'); d.hidden = false; d.textContent = text; status('Clipboard blocked: select the text below.'); }
});
$('#clear').addEventListener('click', () => { if (confirm('Clear all results?')) { results = []; save(); render(); } });
render();
