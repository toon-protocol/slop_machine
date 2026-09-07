/**
 * The viber's end of the demo: a rolling HLS window, on loopback, holding
 * nothing but segments that were paid for — and, since ADR 0005, the serving
 * side of the **playback contract**.
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
 * station was paid for one at a time. Every `.ts` under the window directory
 * arrived as the body of a fulfilled packet that spent a claim. A file here is
 * a receipt.
 *
 * ## The playback contract (ADR 0005)
 *
 * The versioned loopback surface between the guide and whatever pays. This
 * player serves it today; the toon-client daemon implements it from the ADR.
 * Across it the guide initiates and stops vibing, selects a rung, and reads
 * state — and NOTHING across it can raise the budget, which is the paying
 * side's own configuration. The spend-initiating writes check the request's
 * `Origin` against an allowlist, because loopback does not fence the browser:
 * any page a person has open can make the browser POST at 127.0.0.1.
 *
 * ## Loopback, and it matters as much here as anywhere
 *
 * This server has no notion of a payment — it hands out vibes to anyone who
 * asks, which is exactly what the segment port does and exactly why the
 * segment port is published on no interface. The difference is whose vibes
 * they are: these have already been bought, by the viber running this demo,
 * for that viber to watch. Serving them off-box would be reselling them — and
 * the contract half initiates spend, which off-box would be another machine
 * spending this viber's money.
 *
 * It is bound to 127.0.0.1 for both reasons and takes no configuration that
 * could move it.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORK_DIR } from './credentials.js';
import { PAGE } from './page.js';

/** Where the bought vibes land unless a suite moves them. Under `./run/`, which git ignores. */
const DEMO_DIR = resolve(WORK_DIR, 'demo');

/** The one interface this may ever bind. Not a setting: see the header. */
const LOOPBACK = '127.0.0.1';

/** The contract's version, which is the path prefix every route sits beneath. */
export const CONTRACT_VERSION = 'v1';
const CONTRACT_ROOT = `/contract/${CONTRACT_VERSION}`;

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

/** One rung, as the contract reports it (ADR 0005). Every amount a decimal string. */
export interface ContractRung {
  rung: string;
  price: string;
  toStation: string;
  toHub: string;
  /** Where this rung's synthesized playlist is served, on loopback. */
  playlist: string;
  edge: number | null;
  bought: number;
  spent: string;
}

/** The whole of what the guide may know, at `GET /contract/v1/state`. */
export interface ContractState {
  contract: typeof CONTRACT_VERSION;
  station: string;
  vibing: boolean;
  live: boolean;
  rung: string | null;
  segmentSeconds: number;
  /** Read-only across the line, by design and by test. */
  budgetPerSecond: string;
  rungs: ContractRung[];
  spent: string;
  toStation: string;
  toHub: string;
  packets: number;
}

/** The paying side's own terms, none of them settable across the line. */
export interface ContractOptions {
  /** The one station this payer holds a channel toward — the station `/vibe` can name. */
  station: string;
  /**
   * The most this viber spends per second, in base units. The paying side's
   * own figure: ADR 0005's invariant is that no request across the loopback
   * line can raise it.
   */
  budgetPerSecond: bigint;
  /**
   * Web origins allowed to initiate spend, beside the player's own page,
   * which is allowlisted by construction. A request with no Origin header is
   * not a web page and is fenced by the loopback binding instead.
   */
  allowedOrigins?: string[];
  /** Whether the paying side is already vibing when the surface comes up. */
  vibing?: boolean;
}

export interface PlayerOptions {
  /** `0` binds an ephemeral port, which is how a suite runs players side by side. */
  port: number;
  rungs: string[];
  segmentSeconds: number;
  /** Where the window lives. The demo's run directory unless a suite moves it. */
  directory?: string;
  contract: ContractOptions;
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
  /** What the paying side reads to know whether to buy at all. */
  vibing: () => boolean;
  /** The rung the guide selected across the contract, if it has. */
  selectedRung: () => string | null;
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
export async function startPlayer(options: PlayerOptions): Promise<Player> {
  const directory = options.directory ?? DEMO_DIR;
  rmSync(directory, { recursive: true, force: true });
  for (const rung of options.rungs) {
    mkdirSync(resolve(directory, rung), { recursive: true, mode: 0o755 });
  }

  const held = new Map<string, Held[]>(options.rungs.map((rung) => [rung, []]));
  const gapPending = new Map<string, boolean>(
    options.rungs.map((rung) => [rung, false])
  );

  for (const rung of options.rungs) {
    writePlaylist(directory, rung, [], options);
  }

  // ── What the contract owns on this side of the line ────────────────────────
  let vibing = options.contract.vibing ?? false;
  let selectedRung: string | null = null;

  /** Filled in once the port is known — `0` binds an ephemeral one. */
  let baseUrl = '';
  const playlistUrl = (rung: string): string => `${baseUrl}/hls/${rung}.m3u8`;

  const contractState = (): ContractState => {
    const driver = options.state();
    return {
      contract: CONTRACT_VERSION,
      station: options.contract.station,
      vibing,
      live: driver.live,
      rung: selectedRung,
      segmentSeconds: driver.segmentSeconds,
      budgetPerSecond: options.contract.budgetPerSecond.toString(),
      rungs: driver.rungs.map((rung) => ({
        rung: rung.rung,
        price: rung.price,
        toStation: rung.toStation,
        toHub: rung.toHub,
        playlist: playlistUrl(rung.rung),
        edge: rung.edge,
        bought: rung.bought,
        spent: rung.spent,
      })),
      spent: driver.spent,
      toStation: driver.toStation,
      toHub: driver.toHub,
      packets: driver.packets,
    };
  };

  /**
   * The origins allowed to initiate spend. The player's own page is on it by
   * construction — under both spellings of loopback, because a person typing
   * `localhost` into a browser is still this machine's own page.
   */
  const allowedOrigins = new Set<string>(options.contract.allowedOrigins ?? []);

  const originOf = (request: IncomingMessage): string | undefined =>
    typeof request.headers.origin === 'string'
      ? request.headers.origin
      : undefined;

  const originAllowed = (origin: string | undefined): boolean =>
    origin === undefined || allowedOrigins.has(origin);

  const handleContract = (
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): void => {
    const origin = originOf(request);
    const cors = origin !== undefined && allowedOrigins.has(origin);
    const answer = (status: number, body: unknown): void => {
      sendJson(response, status, body, cors ? origin : undefined);
    };

    // THE INVARIANT, FIRST (ADR 0005): the budget lives on this side of the
    // line and no request across it can raise it. The path is reserved so a
    // client that tries learns the rule by name, not a 404 that reads as
    // "perhaps in v2".
    if (path === `${CONTRACT_ROOT}/budget`) {
      return answer(403, { error: 'budget_is_not_yours' });
    }

    if (!path.startsWith(`${CONTRACT_ROOT}/`)) {
      // A version this side does not speak, answered by name, so a guide can
      // say WHICH side is behind instead of rendering garbage.
      return answer(404, { error: 'unknown_contract_version' });
    }

    // A browser's preflight, ahead of any cross-origin write. Refusing it here
    // is the first fence; the Origin check on the write itself stands alone.
    if (request.method === 'OPTIONS') {
      if (!cors) return answer(403, { error: 'origin_not_allowed' });
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        vary: 'origin',
      });
      return void response.end();
    }

    if (path === `${CONTRACT_ROOT}/state`) {
      if (request.method !== 'GET') {
        return answer(405, { error: 'method_not_allowed' });
      }
      return answer(200, contractState());
    }

    const write = /^\/contract\/v1\/(vibe|stop|rung)$/.exec(path);
    if (write === null) return answer(404, { error: 'unknown_contract_path' });
    if (request.method !== 'POST') {
      return answer(405, { error: 'method_not_allowed' });
    }

    // The spend-initiating surface. A request with no Origin is not a web
    // page — curl, the paying side's own tooling — and the loopback binding
    // is its fence. A page's Origin must be on the paying side's own list.
    if (!originAllowed(origin)) {
      return answer(403, { error: 'origin_not_allowed' });
    }

    void readBody(request).then((raw) => {
      let body: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return answer(400, { error: 'unreadable_body' });
        }
      }

      // The invariant's second half: a budget smuggled into a write's body is
      // refused by name rather than quietly dropped — a guide must never
      // believe it set what it did not.
      if ('budget' in body || 'budgetPerSecond' in body) {
        return answer(403, { error: 'budget_is_not_yours' });
      }

      switch (write[1]) {
        case 'vibe': {
          if (typeof body['station'] !== 'string') {
            return answer(400, { error: 'no_station' });
          }
          if (body['station'] !== options.contract.station) {
            // About channels, not directories: this payer vibes only with
            // stations it can pay, and it holds a channel toward one.
            return answer(404, { error: 'unknown_station' });
          }
          vibing = true;
          return answer(200, contractState());
        }
        case 'stop': {
          vibing = false;
          return answer(200, contractState());
        }
        case 'rung': {
          if (typeof body['rung'] !== 'string') {
            return answer(400, { error: 'no_rung' });
          }
          if (!options.rungs.includes(body['rung'])) {
            // The same name the origin's own miss uses, so a guide learns one
            // vocabulary for "that rung is not on this ladder".
            return answer(404, { error: 'unknown_rung' });
          }
          selectedRung = body['rung'];
          return answer(200, contractState());
        }
        default:
          return answer(404, { error: 'unknown_contract_path' });
      }
    });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK}`);
    const path = url.pathname;

    if (path.startsWith('/contract/')) {
      return handleContract(request, response, path);
    }

    if (path === '/' || path === '/index.html') {
      return send(response, 200, 'text/html; charset=utf-8', PAGE);
    }
    if (path === '/api/state') {
      // The page's superset: the demo's own extras plus the contract's two
      // facts the page follows — whether the paying side is vibing, and which
      // rung the guide selected.
      return send(
        response,
        200,
        'application/json',
        JSON.stringify({ ...options.state(), vibing, rung: selectedRung })
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
        resolve(directory, `${String(playlist[1])}.m3u8`),
        'application/vnd.apple.mpegurl'
      );
    }

    const segment = /^\/hls\/([a-z0-9]+)\/(\d+)\.ts$/.exec(path);
    if (segment) {
      return sendFile(
        response,
        resolve(directory, String(segment[1]), `${String(segment[2])}.ts`),
        'video/mp2t'
      );
    }

    send(response, 404, 'text/plain', 'no');
  });

  const port = await new Promise<number>((listening, refused) => {
    server.once('error', refused);
    server.listen(options.port, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        refused(new Error('the player bound no TCP port'));
        return;
      }
      listening(address.port);
    });
  });
  baseUrl = `http://${LOOPBACK}:${String(port)}`;
  // The player's own page, allowlisted by construction, under both loopback
  // spellings — a person typing `localhost` is still this machine.
  allowedOrigins.add(baseUrl);
  allowedOrigins.add(`http://localhost:${String(port)}`);

  return {
    url: `${baseUrl}/`,
    playlistUrl,
    vibing: () => vibing,
    selectedRung: () => selectedRung,

    publish(rung, sequence, body) {
      writeFileSync(resolve(directory, rung, `${String(sequence)}.ts`), body, {
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
          rmSync(resolve(directory, rung, `${String(dropped.sequence)}.ts`), {
            force: true,
          });
        }
      }
      held.set(rung, window);
      writePlaylist(directory, rung, window, options);
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
  directory: string,
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
  writeFileSync(resolve(directory, `${rung}.m3u8`), `${lines.join('\n')}\n`, {
    mode: 0o644,
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((read) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      read(Buffer.concat(chunks).toString('utf8'));
    });
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

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  corsOrigin?: string
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    // A CORS grant only ever names an allowlisted origin — a page not on the
    // list can neither act nor read, and spend totals are the viber's own.
    ...(corsOrigin === undefined
      ? {}
      : { 'access-control-allow-origin': corsOrigin }),
    vary: 'origin',
  });
  response.end(JSON.stringify(body));
}

function sendFile(response: ServerResponse, path: string, type: string): void {
  try {
    send(response, 200, type, readFileSync(path));
  } catch {
    // Evicted, or never bought. A miss, and the player asks for the next one.
    send(response, 404, 'text/plain', 'gone');
  }
}
