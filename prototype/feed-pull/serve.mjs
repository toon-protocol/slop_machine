// PROTOTYPE, throwaway. Answers ticket #7 "What should pulling through the Feed feel like?"
// Three variants of the Feed's Pull mechanic, switchable via `?variant=A|B|C`.
// Serves the Feed on PORT and the Slop on PORT+1, so every Slop iframe is cross-origin (as in the real design).
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FEED_PORT = Number(process.env.PORT ?? 5173);
const SLOP_PORT = FEED_PORT + 1;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };

function serve(root, port) {
  http
    .createServer(async (req, res) => {
      let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(root)) return res.writeHead(403).end();
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })
    .listen(port, '0.0.0.0');
}

serve(path.join(here, 'feed'), FEED_PORT);
serve(path.join(here, 'slop'), SLOP_PORT);

const hosts = ['localhost', ...Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)];
console.log(`Feed prototype (Slop served cross-origin on :${SLOP_PORT})`);
for (const h of hosts) console.log(`  http://${h}:${FEED_PORT}/?variant=A   (B, C also)`);
