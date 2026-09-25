// Upload a tiny throwaway Version (3 random files + path manifest) on Turbo's free tier,
// then poll each gateway until it serves the manifest and a file. Measures freshness, not speed.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const { TurboFactory } = await import('@ardrive/turbo-sdk/node');
const turbo = TurboFactory.authenticated({ privateKey: '0x' + randomBytes(32).toString('hex'), token: 'ethereum' });
const up = async (buf, type) => (await turbo.uploadFile({ fileStreamFactory: () => buf, fileSizeFactory: () => buf.length, dataItemOpts: { tags: [{ name: 'Content-Type', value: type }, { name: 'App-Name', value: 'slop-machine-gateway-probe' }] } })).id;
const files = {};
for (const n of ['a.bin', 'b.bin', 'c.bin']) files[n] = await up(randomBytes(90 * 1024), 'application/octet-stream');
const manifest = Buffer.from(JSON.stringify({ manifest: 'arweave/paths', version: '0.2.0', index: { path: 'a.bin' }, paths: Object.fromEntries(Object.entries(files).map(([k, id]) => [k, { id }])) }));
const mid = await up(manifest, 'application/x.arweave-manifest+json');
const t0 = Date.now();
console.log('manifest', mid, files);
const GWS = { ario: 4101, 'arweave-trusted': 4102, 'arweave-untrusted': 4103, turbo: 4104, chunks: 4105 };
const probes = [];
for (const [gw, port] of Object.entries(GWS)) for (const [what, url] of [['manifest', `/raw/${mid}`], ['file', `/raw/${files['b.bin']}`], ['path', `/${mid}/c.bin`]]) probes.push({ gw, port, what, url });
const done = new Map();
while (done.size < probes.length && Date.now() - t0 < +(process.argv[2] || 900) * 1000) {
  await Promise.all(probes.filter((p) => !done.has(p)).map(async (p) => {
    try {
      const r = await fetch(`http://localhost:${p.port}${p.url}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      await r.arrayBuffer();
      if (r.status === 200 || (r.status >= 300 && r.status < 400)) {
        let st = r.status;
        if (st >= 300) { // follow the sandbox redirect with a Host header
          const loc = new URL(r.headers.get('location'));
          const r2 = await fetch(`http://localhost:${p.port}${loc.pathname}${loc.search}`, { headers: { host: loc.host }, signal: AbortSignal.timeout(20000) });
          await r2.arrayBuffer(); st = r2.status; if (st !== 200) return;
        }
        done.set(p, (Date.now() - t0) / 1000);
        console.log(`${p.gw.padEnd(18)} ${p.what.padEnd(8)} served after ${done.get(p)}s`);
      }
    } catch {}
  }));
  await new Promise((r) => setTimeout(r, 2000));
}
for (const p of probes) appendFileSync('fresh.jsonl', JSON.stringify({ mid, gw: p.gw, what: p.what, s: done.get(p) ?? null }) + '\n');
for (const p of probes) if (!done.has(p)) console.log(`${p.gw.padEnd(18)} ${p.what.padEnd(8)} NOT served`);
