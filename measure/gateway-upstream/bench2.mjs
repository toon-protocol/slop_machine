// Cold 4 MiB "Version" (3 data items ~1.4 MiB each, fetched in parallel) through each gateway, then warm.
import { readFileSync, appendFileSync } from 'node:fs';
const items = JSON.parse(readFileSync('all.json'));
const GWS = { ario: 4101, turbo: 4104, 'turbo+ario,30s': 4106 };
const names = Object.keys(GWS), rounds = +process.argv[2] || 5, TIMEOUT = 90_000;
async function get(port, id) {
  const t0 = performance.now();
  try {
    const r = await fetch(`http://localhost:${port}/raw/${id}`, { signal: AbortSignal.timeout(TIMEOUT) });
    const b = await r.arrayBuffer();
    return { id, http: r.status, bytes: b.byteLength, s: (performance.now() - t0) / 1000, cache: r.headers.get('x-cache'), verified: r.headers.get('x-ar-io-verified'), trusted: r.headers.get('x-ar-io-trusted') };
  } catch (e) { return { id, error: e.name, s: (performance.now() - t0) / 1000 }; }
}
let k = 0;
for (let r = 0; r < rounds; r++) {
  const order = names.map((_, i) => names[(i + r) % names.length]);
  for (const gw of order) {
    const group = items.slice(k, k + 3); k += 3;
    for (const phase of ['cold', 'warm']) {
      const t0 = performance.now();
      const res = await Promise.all(group.map((it) => get(GWS[gw], it.id)));
      const row = { round: r, gw, phase, wall: +((performance.now() - t0) / 1000).toFixed(2), mib: +(res.reduce((a, x) => a + (x.bytes || 0), 0) / 2 ** 20).toFixed(2), ok: res.every((x) => x.http === 200), items: res };
      appendFileSync('results2.jsonl', JSON.stringify(row) + '\n');
      console.log(r, gw.padEnd(18), phase, String(row.wall).padStart(6) + 's', row.mib + 'MiB', res.map((x) => x.error ?? `${x.http}/${x.cache}`).join(' '));
    }
  }
}
