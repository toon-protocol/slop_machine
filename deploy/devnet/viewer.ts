/**
 * The remote viewer — `pnpm demo:viewer`.
 *
 * The other half of `pnpm demo --anyone`: a DIFFERENT machine (or a different
 * terminal standing in for one), holding nothing but this repository, Docker,
 * and the lines the demo's host printed — the hub's `.anyone` address, the
 * station's prefix and seal-to key, and one funded private key. It builds its
 * own way onto the Anyone network, opens its own payment channel with the hub
 * OVER THE CIRCUIT, and then buys the broadcast exactly as the demo's own
 * viber does, one paid packet at a time, into the same page.
 *
 *   pnpm demo:viewer -- \
 *     --connector http://<56-char-address>.anyone \
 *     --station   g.toon.slopmachine.<handle> \
 *     --seal-to   <the station's edge identity, hex> \
 *     --price audio=200 --price 480p=1000 --price now=50 \
 *     --key 0x…
 *
 *   --price <rung>=<toStation>   optional, repeatable: what the STATION
 *                                charges to terminate that address, which is
 *                                what lets the page split each payment into
 *                                the broadcaster's share and the hub's. With
 *                                none given the page shows the spend and not
 *                                the split — honest, just less to see.
 *   --socks socks5h://…          a daemon you already run; nothing is built
 *                                or started when this is given
 *   --port 8088                  where the page is served
 *
 * ## What rides the circuit, and what this side never learns
 *
 * Everything. The self-description, the channel open and every deposit (chain
 * RPC rides the proxy by default — the hidden service fronts the chain on
 * port 8545 for exactly this, so a viewer's settlement address is never
 * broadcast from its own IP), the *now*, and every segment. The viewer never
 * reaches the station: it seals each pull to the key the host handed out —
 * public material, printed because a viewer cannot read the station's own
 * self-description — and the hub carries the packet the rest of the way.
 *
 * The station's ladder is not an argument: it is DISCOVERED from the first
 * paid `/now`, which names every rung the station holds. That is the design —
 * the *now* is the whole of a station's discovery surface — walked from
 * outside for the first time.
 *
 * ## The daemon
 *
 * With no `--socks`, the viewer runs its own anon v0.4.10.2 as a container
 * from `./anon/` (built on first use — the devnet publishes no image, so a
 * viewer builds where it stands), SOCKS-only, published on loopback at a port
 * that deliberately is NOT the demo host's 9050 — on a machine running both,
 * two daemons must not fight for one port. It is removed on Ctrl-C.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToonClient } from '@toon-protocol/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ANON_SOCKS_PORT, HS_HOSTNAME_PATTERN, viewerAnonrc } from './anon.js';
import {
  DEVNET_DIR,
  buildImage,
  execInContainer,
  imageExists,
  removeContainer,
  requireDockerDaemon,
  runBeside,
} from './compose.js';
import { WORK_DIR } from './credentials.js';
import { pullThroughTheHub } from './paid.js';
import type { Payer } from './payer.js';
import { startPlayer, type DemoState, type Player } from './player.js';
import {
  createLedger,
  createViberCycle,
  recordSpend,
  withCircuitPatience,
  type Ledger,
  type RungPrices,
} from './viber-loop.js';
import type { StationNow } from './vibes.js';

/** Where the page is served, unless `--port` says otherwise. */
const DEFAULT_PORT = 8088;

/**
 * The viewer's own budget, in base units per second — the paying side's
 * figure, which ADR 0005 says nothing across the loopback line can raise.
 * The demo's number, for the demo's reasons.
 */
const BUDGET_PER_SECOND = 1000n;

/** What the viewer locks into its channel with the hub. */
const CHANNEL_DEPOSIT = 100_000_000n;

/**
 * The viewer always rides a circuit, so it always takes the demo's WIDENED
 * pacing: a pull's round trip is tens of loopback's, and both numbers stay
 * under the station's 20-segment window — `demo.ts`'s `--anyone` constants
 * say why at length.
 */
const PREROLL_SEGMENTS = 5;
const MAX_SEGMENTS_BEHIND = 15;

/** The viewer's own working directory, under the ignored `run/`. */
const VIEWER_DIR = resolve(WORK_DIR, 'viewer');

/** The viewer's own daemon, when it runs one. */
const VIEWER_ANON_CONTAINER = 'devnet-viewer-anon';
const VIEWER_ANON_IMAGE = 'slopmachine-devnet-anon:v0.4.10.2';

/**
 * Where the viewer's own daemon answers SOCKS on the host — loopback, and
 * deliberately NOT 9050: on a machine also hosting `pnpm demo --anyone`, the
 * hub's daemon already holds that port, and the full-circuit rehearsal of
 * running both sides on one laptop must not fail on a port fight.
 */
const VIEWER_SOCKS_HOST_PORT = 9250;

/** How long a first bootstrap onto the live Anyone network may take. */
const BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

interface Arguments {
  connector: string;
  station: string;
  sealTo: string;
  key: Hex;
  /** `--price <rung>=<toStation>`, when given: the split's station half. */
  toStation: Map<string, bigint>;
  socks: string | null;
  port: number;
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));

  // ── The stop signal, armed before anything worth interrupting ──────────────
  let stopping = false;
  const stopped = new Promise<void>((halted) => {
    const halt = (): void => {
      stopping = true;
      halted();
    };
    process.once('SIGINT', halt);
    process.once('SIGTERM', halt);
  });

  // ── The way onto the network ───────────────────────────────────────────────
  let socksProxy = options.socks;
  let ownDaemon = false;
  if (socksProxy === null) {
    await requireDockerDaemon();
    ownDaemon = true;
    socksProxy = `socks5h://127.0.0.1:${String(VIEWER_SOCKS_HOST_PORT)}`;

    if (!(await imageExists(VIEWER_ANON_IMAGE))) {
      say('building the anon daemon image (first run only)…');
      await buildImage({
        tag: VIEWER_ANON_IMAGE,
        context: resolve(DEVNET_DIR, 'anon'),
      });
    }

    mkdirSync(VIEWER_DIR, { recursive: true, mode: 0o755 });
    const anonrcPath = resolve(VIEWER_DIR, 'anonrc');
    writeFileSync(anonrcPath, viewerAnonrc(), { mode: 0o644 });

    // A stale daemon from an interrupted run holds the name and the port.
    await removeContainer(VIEWER_ANON_CONTAINER);
    await runBeside({
      name: VIEWER_ANON_CONTAINER,
      image: VIEWER_ANON_IMAGE,
      ports: [
        `127.0.0.1:${String(VIEWER_SOCKS_HOST_PORT)}:${String(ANON_SOCKS_PORT)}`,
      ],
      volumes: [`${anonrcPath}:/etc/anon/anonrc:ro`],
    });
    say('anon is up — bootstrapping onto the live Anyone network…');
    await waitForBootstrap(() => stopping);
    if (stopping) {
      await removeContainer(VIEWER_ANON_CONTAINER);
      return;
    }
    say('bootstrapped; circuits build on demand from here');
  }

  const tearDownDaemon = async (): Promise<void> => {
    if (ownDaemon) await removeContainer(VIEWER_ANON_CONTAINER);
  };

  try {
    // ── The payer, entirely over the circuit ─────────────────────────────────
    //
    // Chain RPC rides the proxy too — `proxyRpc` is left at its default true,
    // and the RPC URL is the hidden service's own port 8545, so the channel
    // open below never touches the clearnet.
    say(
      'reading the hub and opening a channel over the circuit — this takes a while…'
    );
    // Every startup step below rides a circuit on a live third-party network,
    // so each one-shot exchange gets a few tries before it is believed.
    const client = await withCircuitPatience(true, 'reading the hub', say, () =>
      ToonClient.create({
        connector: options.connector,
        socksProxy,
        evmPrivateKey: options.key,
        chain: 'evm',
        rpcUrl: `${options.connector}:8545`,
        channelStore: resolve(VIEWER_DIR, 'channels.json'),
        autoOpenChannel: false,
      })
    );

    try {
      const channel = await withCircuitPatience(
        true,
        'opening the channel',
        say,
        () => client.channel.open({ deposit: CHANNEL_DEPOSIT })
      );
      say(
        `channel ${channel.channelId} open with ${CHANNEL_DEPOSIT.toString()} locked — every pull from here is a signature, not a transaction`
      );

      const viewer: Payer = {
        who: 'viewer',
        key: {
          privateKey: options.key,
          address: privateKeyToAccount(options.key).address,
        },
        client,
        channelId: channel.channelId,
        deposit: CHANNEL_DEPOSIT,
      };

      // ── The ladder, discovered from the station's own *now* ────────────────
      //
      // The first paid pull. Its answer names every rung the station holds,
      // which is the whole of a station's discovery surface — so the ladder
      // is never an argument a host could get wrong.
      const first = await withCircuitPatience(
        true,
        "the station's now",
        say,
        () =>
          pullThroughTheHub(viewer, options.sealTo, `${options.station}.now`)
      );
      if (first.status !== 200) {
        throw new Error(
          `the station's *now* answered ${String(first.status)}: ${first.text}`
        );
      }
      let edge: StationNow = JSON.parse(first.text) as StationNow;
      const ladder = edge.rungs.map((rung) => rung.rung);
      say(
        `the station holds ${ladder.join(', ')} — ${edge.live ? 'and it is on the air' : 'and it is off the air right now'}`
      );

      // ── What each address costs, asked of the hub itself ───────────────────
      //
      // The carried price comes off the hub's own free price surface, over
      // the circuit; the station's half of it is `--price`, handed out by the
      // host because a viewer cannot read the station's self-description. A
      // rung with no `--price` renders its price and no split.
      const prices = new Map<string, RungPrices>();
      for (const rung of [...ladder, 'now']) {
        const carried = await withCircuitPatience(
          true,
          `pricing ${rung}`,
          say,
          () => client.price(`${options.station}.${rung}`)
        );
        if (carried === null) continue;
        const toStation = options.toStation.get(rung) ?? 0n;
        prices.set(rung, {
          price: carried,
          toStation,
          toHub: toStation === 0n ? 0n : carried - toStation,
        });
      }

      const ledger: Ledger = createLedger(ladder);
      recordSpend(ledger, prices, 'now', first.paid);

      // ── The page ───────────────────────────────────────────────────────────
      const handle = options.station.split('.').pop() ?? options.station;
      const state = (): DemoState => ({
        live: edge.live,
        waitingFor: edge.live
          ? 'on the air'
          : 'the broadcaster is off the air — still watching',
        hubAddress: options.station.split('.').slice(0, -1).join('.'),
        stationPrefix: options.station,
        handle,
        segmentSeconds: edge.segmentSeconds,
        rungs: ladder.map((rung) => {
          const split = prices.get(rung);
          const held = ledger.perRung.get(rung);
          return {
            rung,
            price: (split?.price ?? 0n).toString(),
            toStation: (split?.toStation ?? 0n).toString(),
            toHub: (split?.toHub ?? 0n).toString(),
            edge:
              edge.rungs.find((held2) => held2.rung === rung)?.sequence ?? null,
            bought: held?.bought ?? 0,
            spent: (held?.spent ?? 0n).toString(),
          };
        }),
        spent: ledger.spent.toString(),
        toStation: ledger.toStation.toString(),
        toHub: ledger.toHub.toString(),
        packets: ledger.packets,
        // The broadcaster's own facts, which a viewer has no way to read and
        // does not pretend to: the page hides that card entirely, because
        // this player passes no `redeem`.
        claimed: '0',
        onChain: '0',
        redeeming: false,
        redeemed: null,
      });

      const player: Player = await startPlayer({
        port: options.port,
        rungs: ladder,
        segmentSeconds: edge.segmentSeconds,
        // The viewer's own run directory, not the demo's: on a machine
        // running both halves, two players must not empty each other's
        // windows.
        directory: resolve(VIEWER_DIR, 'window'),
        contract: {
          station: options.station,
          budgetPerSecond: BUDGET_PER_SECOND,
          vibing: true,
        },
        state,
        // No redeem: that is the broadcaster's own operator write, made with
        // a key that lives on the station's side of the world.
      });
      say(`the page is at ${player.url}`);

      const cycle = createViberCycle({
        viber: viewer,
        sealTo: options.sealTo,
        stationPrefix: options.station,
        ladder,
        prerollSegments: PREROLL_SEGMENTS,
        maxSegmentsBehind: MAX_SEGMENTS_BEHIND,
        ledger,
        prices,
        vibing: () => player.vibing(),
        stopping: () => stopping,
        onEdge: (now) => {
          edge = now;
        },
        publish: (rung, sequence, body) => {
          player.publish(rung, sequence, body);
        },
        missed: (rung) => {
          player.missed(rung);
        },
      });

      // ── Until somebody stops it ────────────────────────────────────────────
      while (!stopping) {
        try {
          await cycle();
        } catch (cause) {
          // A refused packet is not the end of a broadcast; a circuit hiccup
          // even less so. Say so and keep going.
          say(
            `a pull did not land: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        }
        await Promise.race([
          stopped,
          new Promise((waited) => setTimeout(waited, 1_000)),
        ]);
      }

      // ── The receipt ────────────────────────────────────────────────────────
      console.log('');
      say('what this viewer paid, over the circuit:');
      console.log(
        [
          `  spent      ${ledger.spent.toString()} in ${String(ledger.packets)} packets`,
          ...(options.toStation.size > 0
            ? [
                `  of which   ${ledger.toStation.toString()} to the broadcaster, ${ledger.toHub.toString()} to the hub`,
              ]
            : []),
          '',
          '  every one of those segments was a signature, not a transaction.',
        ].join('\n')
      );

      await player.close();
    } finally {
      await client.close();
    }
  } finally {
    await tearDownDaemon();
    say('torn down');
  }
}

/** Wait for the viewer's own daemon to have a circuit. */
async function waitForBootstrap(stopping: () => boolean): Promise<void> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  let said = 0;
  for (;;) {
    if (stopping()) return;
    try {
      const count = await execInContainer(VIEWER_ANON_CONTAINER, [
        'grep',
        '-c',
        'Bootstrapped 100%',
        '/var/lib/anon/notice.log',
      ]);
      if (Number(count.trim()) > 0) return;
    } catch {
      // `grep -c` exits non-zero on zero matches: still building circuits.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the anon daemon did not bootstrap within ${String(BOOTSTRAP_TIMEOUT_MS / 1000)}s — the Anyone network is a live third-party network, so this can be it or the way to it. \`docker logs ${VIEWER_ANON_CONTAINER}\` says which.`
      );
    }
    if (Date.now() - said > 15_000) {
      said = Date.now();
      say('still bootstrapping onto the Anyone network…');
    }
    await new Promise((waited) => setTimeout(waited, 5_000));
  }
}

function readArguments(argv: string[]): Arguments {
  let connector: string | null = null;
  let station: string | null = null;
  let sealTo: string | null = null;
  let key: string | null = null;
  let socks: string | null = null;
  let port = DEFAULT_PORT;
  const toStation = new Map<string, bigint>();

  const value = (at: number, flag: string): string => {
    const held = argv[at + 1];
    if (held === undefined || held.startsWith('--')) {
      throw new Error(`${flag} wants a value`);
    }
    return held;
  };

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    switch (argument) {
      case '--connector':
        connector = value(at, argument);
        at += 1;
        break;
      case '--station':
        station = value(at, argument);
        at += 1;
        break;
      case '--seal-to':
        sealTo = value(at, argument);
        at += 1;
        break;
      case '--key':
        key = value(at, argument);
        at += 1;
        break;
      case '--socks':
        socks = value(at, argument);
        at += 1;
        break;
      case '--port': {
        const wanted = Number(value(at, argument));
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65_535) {
          throw new Error(`--port wants a port number, not ${String(wanted)}`);
        }
        port = wanted;
        at += 1;
        break;
      }
      case '--price': {
        const pair = value(at, argument);
        const split = /^([a-z0-9]+)=(\d+)$/.exec(pair);
        if (split === null) {
          throw new Error(
            `--price wants <rung>=<what the station charges>, not "${pair}"`
          );
        }
        toStation.set(String(split[1]), BigInt(String(split[2])));
        at += 1;
        break;
      }
      default:
        throw new Error(
          `the viewer takes --connector, --station, --seal-to, --key, --price, --socks and --port, and does not know "${String(argument)}"`
        );
    }
  }

  if (
    connector === null ||
    station === null ||
    sealTo === null ||
    key === null
  ) {
    throw new Error(
      'a viewer needs --connector, --station, --seal-to and --key — all four are in the block the demo host printed'
    );
  }

  const host = /^http:\/\/([^/]+)$/.exec(connector)?.[1] ?? '';
  if (!HS_HOSTNAME_PATTERN.test(host)) {
    throw new Error(
      `--connector wants http://<56-char-address>.anyone, not "${connector}" — plain http, because no CA can certify a hidden service and the circuit authenticates the endpoint itself`
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('--key wants the 0x-prefixed private key the host printed');
  }
  if (!/^(0x)?[0-9a-fA-F]{64,}$/.test(sealTo)) {
    throw new Error(
      '--seal-to wants the station edge identity exactly as the host printed it: hex, possibly 0x-prefixed'
    );
  }

  return {
    connector,
    station,
    sealTo,
    key: key as Hex,
    toStation,
    socks,
    port,
  };
}

function say(what: string): void {
  console.log(`[viewer] ${what}`);
}

try {
  await main();
} catch (cause) {
  console.error(`\n[viewer] it did not come up: ${String(cause)}\n`);
  await removeContainer(VIEWER_ANON_CONTAINER);
  process.exitCode = 1;
}
