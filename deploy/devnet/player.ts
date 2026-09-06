/**
 * The viber's end of the demo: a rolling HLS window, on loopback, holding
 * nothing but segments that were paid for.
 *
 * ## Why a player exists here at all
 *
 * **No playlist is served from a station**, and that is the design rather than
 * an omission — nothing free is, and a playlist is a free description of what
 * is for sale. `../../README.md` says the client daemon stands between the
 * station and the player and synthesizes whatever playlist its player needs
 * over loopback. Neither app in this repository may hold payment code, so the
 * daemon is not here and cannot be; this is the smallest thing that stands
 * where it stands, for one machine and one demo.
 *
 * So this file writes a playlist THE STATION NEVER SENT, out of segments the
 * station was paid for one at a time. Every `.ts` under `./run/demo/` arrived
 * as the body of a fulfilled packet that spent a claim. A file here is a
 * receipt.
 *
 * ## Loopback, and it matters as much here as anywhere
 *
 * This server has no notion of a payment — it hands out vibes to anyone who
 * asks, which is exactly what the segment port does and exactly why the
 * segment port is published on no interface. The difference is whose vibes
 * they are: these have already been bought, by the viber running this demo,
 * for that viber to watch. Serving them off-box would be reselling them.
 *
 * It is bound to 127.0.0.1 for that reason and takes no configuration that
 * could move it.
 */

import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORK_DIR } from './credentials.js';
import { PAGE } from './page.js';

/** Where the bought vibes land. Under `./run/`, which git ignores. */
const DEMO_DIR = resolve(WORK_DIR, 'demo');

/** The one interface this may ever bind. Not a setting: see the header. */
const LOOPBACK = '127.0.0.1';

/**
 * How many segments the playlist holds.
 *
 * The station retains 20 and a demo wants a window it can seek inside without
 * holding vibes the station itself has already dropped — a viber who scrolls
 * back past this is asking for something nobody has any more.
 */
const WINDOW_SEGMENTS = 12;

/** One segment, as the playlist knows it. */
interface Held {
  sequence: number;
  /** A gap ahead of it — a sequence that was asked for and was not vibes. */
  afterGap: boolean;
}

/** What the page is told, once a second. Every amount is a string: these are bigints. */
export interface DemoState {
  live: boolean;
  waitingFor: string;
  hubAddress: string;
  stationPrefix: string;
  handle: string;
  segmentSeconds: number;
  rungs: {
    rung: string;
    /** What one segment at this rung costs a viber, across the hop. */
    price: string;
    /** Of that, what the station charges and what the hub keeps. */
    toStation: string;
    toHub: string;
    edge: number | null;
    bought: number;
    spent: string;
  }[];
  /** Everything the viber has spent, on vibes and on finding the live edge. */
  spent: string;
  /**
   * How that split, at the two nodes' OWN prices — what the station charges to
   * terminate, and what the hub keeps for carrying. Carried here rather than
   * multiplied out by the page, because the `now` pulls are part of it too and
   * a page reconstructing this from per-rung counts would quietly under-report.
   */
  toStation: string;
  toHub: string;
  packets: number;
  /** What the station's own connector has banked, and what is on chain. */
  claimed: string;
  onChain: string;
  redeeming: boolean;
  redeemed: { at: number; moved: string } | null;
}

export interface PlayerOptions {
  port: number;
  rungs: string[];
  segmentSeconds: number;
  /** What the page asks for once a second. */
  state: () => DemoState;
  /** What the page's one button does: redeem the station's latest claim, on chain. */
  redeem: () => Promise<void>;
}

export interface Player {
  /** Where a human points a browser. */
  url: string;
  /** What ffplay or VLC is given instead, when a browser is not wanted. */
  playlistUrl: (rung: string) => string;
  /** One bought segment, into the window. */
  publish: (rung: string, sequence: number, body: Uint8Array) => void;
  /** A sequence that was paid for and was not vibes — the playlist skips it. */
  missed: (rung: string) => void;
  close: () => Promise<void>;
}

/**
 * Start the window and the server in front of it.
 *
 * The directory is emptied first: a playlist that named a segment from a
 * previous demo would be naming vibes this viber never bought.
 */
export function startPlayer(options: PlayerOptions): Player {
  rmSync(DEMO_DIR, { recursive: true, force: true });
  for (const rung of options.rungs) {
    mkdirSync(resolve(DEMO_DIR, rung), { recursive: true, mode: 0o755 });
  }

  const held = new Map<string, Held[]>(options.rungs.map((rung) => [rung, []]));
  const gapPending = new Map<string, boolean>(
    options.rungs.map((rung) => [rung, false])
  );

  for (const rung of options.rungs) writePlaylist(rung, [], options);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK}`);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return send(response, 200, 'text/html; charset=utf-8', PAGE);
    }
    if (path === '/api/state') {
      return send(
        response,
        200,
        'application/json',
        JSON.stringify(options.state())
      );
    }
    if (path === '/api/redeem' && request.method === 'POST') {
      // The answer is the state, so the page learns what moved from the same
      // place it learns everything else rather than from this reply.
      return void options
        .redeem()
        .then(() =>
          send(response, 200, 'application/json', JSON.stringify({ ok: true }))
        )
        .catch((cause: unknown) =>
          send(
            response,
            500,
            'application/json',
            JSON.stringify({ error: String(cause) })
          )
        );
    }

    const playlist = /^\/hls\/([a-z0-9]+)\.m3u8$/.exec(path);
    if (playlist) {
      return sendFile(
        response,
        resolve(DEMO_DIR, `${String(playlist[1])}.m3u8`),
        'application/vnd.apple.mpegurl'
      );
    }

    const segment = /^\/hls\/([a-z0-9]+)\/(\d+)\.ts$/.exec(path);
    if (segment) {
      return sendFile(
        response,
        resolve(DEMO_DIR, String(segment[1]), `${String(segment[2])}.ts`),
        'video/mp2t'
      );
    }

    send(response, 404, 'text/plain', 'no');
  });

  server.listen(options.port, LOOPBACK);

  return {
    url: `http://${LOOPBACK}:${String(options.port)}/`,
    playlistUrl: (rung) =>
      `http://${LOOPBACK}:${String(options.port)}/hls/${rung}.m3u8`,

    publish(rung, sequence, body) {
      writeFileSync(resolve(DEMO_DIR, rung, `${String(sequence)}.ts`), body, {
        mode: 0o644,
      });

      const window = held.get(rung) ?? [];
      window.push({ sequence, afterGap: gapPending.get(rung) === true });
      gapPending.set(rung, false);

      // Evicted by count, like the station's own window and for the same
      // reason: a demo left running overnight must not fill a disk.
      while (window.length > WINDOW_SEGMENTS) {
        const dropped = window.shift();
        if (dropped !== undefined) {
          rmSync(resolve(DEMO_DIR, rung, `${String(dropped.sequence)}.ts`), {
            force: true,
          });
        }
      }
      held.set(rung, window);
      writePlaylist(rung, window, options);
    },

    missed(rung) {
      // The next segment that DOES arrive is discontinuous with the last one,
      // and a player told otherwise stalls waiting for vibes nobody holds.
      gapPending.set(rung, true);
    },

    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => {
          closed();
        });
      }),
  };
}

/**
 * A LIVE playlist, which is one with no `#EXT-X-ENDLIST`.
 *
 * `#EXT-X-MEDIA-SEQUENCE` carries the sequence of the first segment still in
 * the window, which is how a player that has been watching knows the window
 * slid rather than restarted. The sequence numbers are the STATION'S own —
 * a viber and a broadcaster name the same span the same way.
 */
function writePlaylist(
  rung: string,
  window: Held[],
  options: PlayerOptions
): void {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${String(Math.ceil(options.segmentSeconds))}`,
    `#EXT-X-MEDIA-SEQUENCE:${String(window[0]?.sequence ?? 0)}`,
  ];

  for (const segment of window) {
    if (segment.afterGap) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${options.segmentSeconds.toFixed(3)},`);
    lines.push(`${rung}/${String(segment.sequence)}.ts`);
  }

  // Written whole and replaced, never appended to: a player that reads a
  // half-written playlist sees a truncated one and gives up on the station.
  writeFileSync(resolve(DEMO_DIR, `${rung}.m3u8`), `${lines.join('\n')}\n`, {
    mode: 0o644,
  });
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array
): void {
  response.writeHead(status, {
    'content-type': type,
    // A live window: every one of these is stale within seconds.
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendFile(response: ServerResponse, path: string, type: string): void {
  try {
    send(response, 200, type, readFileSync(path));
  } catch {
    // Evicted, or never bought. A miss, and the player asks for the next one.
    send(response, 404, 'text/plain', 'gone');
  }
}
