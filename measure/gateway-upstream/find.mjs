// Find random Arweave data items (bundled, like Turbo uploads) sized 1.2-1.5 MiB.
const want = +process.argv[2] || 48, lo = 1.2 * 2**20, hi = 1.5 * 2**20;
const out = new Map();
const tip = (await (await fetch('https://arweave.net/info')).json()).height;
for (let a = 0; a < 150 && out.size < want; a++) {
  const min = 1_300_000 + Math.floor(Math.random() * (tip - 1_300_000 - 2000));
  const q = `{ transactions(first: 100, block:{min:${min},max:${min + 3000}}, tags:[{name:"Content-Type", values:["image/png","image/jpeg","image/webp","application/javascript","audio/mpeg","video/mp4","application/octet-stream"]}]) { edges { node { id bundledIn { id } block { height } data { size } } } } }`;
  try {
    const r = await (await fetch('https://arweave-search.goldsky.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })).json();
    if (r.errors) { console.error(JSON.stringify(r.errors).slice(0, 300)); continue; }
    for (const { node } of r.data.transactions.edges) {
      const s = +node.data.size;
      if (s >= lo && s <= hi && node.bundledIn && !out.has(node.id)) { out.set(node.id, { id: node.id, size: s, height: node.block?.height }); break; } // one per window, spread out
    }
  } catch (e) { console.error(e.message); }
}
console.log(JSON.stringify([...out.values()], null, 1));
console.error('tip', tip, 'found', out.size);
