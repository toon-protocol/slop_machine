/**
 * The guide, served — a static file server for `packages/guide/dist`, in the
 * driver, on the `player.ts` pattern: plain `node:http`, no new dependency,
 * no container and no new image.
 *
 * ## Why it exists here
 *
 * `pnpm demo --anyone` fronts this server with a hidden service of its own,
 * so a SOCKS-proxied browser anywhere can open the guide at its `.anyone`
 * address. The daemon forwards that service's port 80 to the compose
 * network's GATEWAY address — the one address on the network that is the
 * HOST, which is where the driver runs — so this binds the gateway, plus
 * loopback for checking it from this machine.
 *
 * ## What it deliberately does not do
 *
 * It does not BUILD the guide. The devnet guard holds that the only binary a
 * run ever spawns is `docker`, and a vite build is exactly the kind of
 * toolchain step that rule exists to keep out of the driver — and the build
 * bakes `VITE_RELAY_URL`, a value only the person running the demo can decide
 * to bake (it is one build per stable address, not per run). The demo checks
 * for `dist/index.html` and prints the exact build command when it is
 * missing: an honest absence, never a broken page.
 *
 * ## SPA fallback
 *
 * The guide routes client-side (`/b/:handle`, `/categories/...`), so any path
 * that is not a file on disk answers `index.html` and lets the router take it
 * from there — exactly what `vite preview` would do. Paths are resolved and
 * fenced inside the dist directory, so `..` climbs nowhere.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/** What vite's output actually contains, plus the safe fallbacks. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export interface GuideServer {
  /** Every address this is listening on, for the log line. */
  urls: string[];
  close: () => Promise<void>;
}

/**
 * Serve one built guide from `distDir`, on every host in `hosts` at `port`.
 *
 * The caller decides the hosts: the demo binds the compose gateway (for the
 * hidden service's forward) and loopback (for checking from this machine); a
 * standalone check binds loopback alone.
 */
export async function startGuideServer(options: {
  distDir: string;
  port: number;
  hosts: string[];
}): Promise<GuideServer> {
  const dist = resolve(options.distDir);
  const index = resolve(dist, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `${index} does not exist — the guide has not been built, and this server serves a build rather than making one`
    );
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://guide');
    // Resolved, then FENCED: a path that escapes the dist directory is
    // answered as if it were any other route — with the app shell, which
    // holds nothing but the page.
    const wanted = resolve(dist, `.${url.pathname}`);
    const inside = wanted === dist || wanted.startsWith(`${dist}${sep}`);

    let file = index;
    if (inside && existsSync(wanted) && statSync(wanted).isFile()) {
      file = wanted;
    }

    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        'content-type':
          CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        // The shell must never go stale — a rebuilt guide renames its hashed
        // assets, and a cached index.html would keep asking for the old ones.
        // The hashed assets themselves are immutable by construction.
        ...(file === index
          ? { 'cache-control': 'no-cache' }
          : { 'cache-control': 'public, max-age=31536000, immutable' }),
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no');
    }
  };

  const servers: Server[] = [];
  const urls: string[] = [];
  for (const host of options.hosts) {
    const server = createServer(handle);
    await new Promise<void>((listening, refused) => {
      server.once('error', refused);
      server.listen(options.port, host, () => {
        listening();
      });
    });
    servers.push(server);
    urls.push(`http://${host}:${String(options.port)}/`);
  }

  return {
    urls,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((closed) => {
              server.closeAllConnections();
              server.close(() => {
                closed();
              });
            })
        )
      );
    },
  };
}
