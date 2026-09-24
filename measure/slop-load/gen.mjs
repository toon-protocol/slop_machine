// THROWAWAY measurement harness for ticket #28 "Measure Slop load latency on real mobile networks".
// Generates three synthetic Slop Versions, sized like real ones:
//   s  ≈ 100 KB  (a vanilla-canvas jam game)
//   m  ≈ 2 MB    (Phaser + ~0.8 MB of assets)
//   l  ≈ 9.9 MB  (Phaser + 6 × 1.45 MiB assets, just under the 10 MiB Version cap and the 1.5 MiB file cap)
// Assets are random bytes, so they don't compress, like PNG/OGG/WASM. Phaser compresses the way it would on a real host.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Phaser 3.90 stands in for a typical jam-game engine; fetched once, not committed.
async function phaser() {
  const file = path.join(here, 'slop/lib/phaser.min.js');
  if (!existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    const res = await fetch('https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.min.js');
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}
const KiB = 1024;
const MiB = 1024 * KiB;

// A few KB of plain game-ish JS, so even the small Slop has a script to parse.
const gameJs = (engine) => `// synthetic game code
window.__game = function start(done) {
  ${engine === 'phaser' ? phaserGame : canvasGame}
};
${Array.from({ length: 150 }, (_, i) => `function level${i}(t){return Math.sin(t*${i + 1})*${i}+Math.cos(t/${i + 2});}`).join('\n')}
`;
const canvasGame = `const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; document.body.append(c);
  const g = c.getContext('2d'); let t = 0;
  (function frame() { t += 0.05; g.fillStyle = '#123'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 12; i++) { g.fillStyle = 'hsl(' + (i * 30) + ',80%,60%)'; g.beginPath(); g.arc(c.width / 2 + Math.cos(t + i) * 80, c.height / 2 + Math.sin(t * 1.3 + i) * 120, 14, 0, 7); g.fill(); }
    requestAnimationFrame(frame); })();
  requestAnimationFrame(() => requestAnimationFrame(done));`;
const phaserGame = `new Phaser.Game({ type: Phaser.AUTO, width: innerWidth, height: innerHeight, backgroundColor: '#123', audio: { noAudio: true },
    scene: { create() { this.dots = Array.from({ length: 12 }, (_, i) => this.add.circle(0, 0, 14, Phaser.Display.Color.HSLToColor(i / 12, 0.8, 0.6).color));
                        requestAnimationFrame(() => requestAnimationFrame(done)); },
             update(t) { this.dots.forEach((d, i) => d.setPosition(innerWidth / 2 + Math.cos(t / 400 + i) * 80, innerHeight / 2 + Math.sin(t / 300 + i) * 120)); } } });`;

const versions = {
  s: { engine: 'canvas', assets: [['sprites.bin', 80 * KiB]] },
  m: { engine: 'phaser', assets: [['atlas.bin', 450 * KiB], ['music.bin', 400 * KiB]] },
  l: { engine: 'phaser', assets: Array.from({ length: 6 }, (_, i) => [`pack${i}.bin`, Math.floor(1.45 * MiB)]) },
};

for (const [id, v] of Object.entries(versions)) {
  const dir = path.join(here, 'slop', id);
  await mkdir(dir, { recursive: true });
  const files = [];
  if (v.engine === 'phaser') {
    await copyFile(await phaser(), path.join(dir, 'phaser.min.js'));
    files.push({ path: 'phaser.min.js', kind: 'script' });
  }
  await writeFile(path.join(dir, 'game.js'), gameJs(v.engine));
  files.push({ path: 'game.js', kind: 'script' });
  for (const [name, size] of v.assets) {
    await writeFile(path.join(dir, name), randomBytes(size));
    files.push({ path: name, kind: 'asset' });
  }
  const html = readFileSync(path.join(here, 'slop/template.html'), 'utf8').replace('/*FILES*/[]', JSON.stringify(files));
  await writeFile(path.join(dir, 'index.html'), html);
  console.log(id, files.map((f) => f.path).join(', '));
}
