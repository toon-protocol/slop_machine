// Local server for the #28 harness: `node serve.mjs` (PORT, default 5180). Mirrors a real static host:
// CORS for the sandboxed (opaque-origin) Slop, gzip for text, and a CDN-style x-cache header on repeat URLs.
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.bin': 'application/octet-stream' };
const seen = new Set();

http
  .createServer(async (req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      let body = await readFile(file);
      const type = types[path.extname(file)] ?? 'application/octet-stream';
      const headers = { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', 'cache-control': 'max-age=600', 'x-cache': seen.has(req.url) ? 'HIT' : 'MISS' };
      seen.add(req.url);
      if (type.startsWith('text/') && /gzip/.test(req.headers['accept-encoding'] ?? '')) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404, { 'access-control-allow-origin': '*' }).end('not found');
    }
  })
  .listen(Number(process.env.PORT ?? 5180), '0.0.0.0', () => console.log(`http://localhost:${process.env.PORT ?? 5180}/`));
