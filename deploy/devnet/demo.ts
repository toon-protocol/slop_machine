/**
 * The demo — `pnpm demo`.
 *
 * The same topology `devnet.test.ts` runs, with two differences that are the
 * whole point of it: the vibes come from **the broadcaster's own OBS**, and
 * nothing is torn down at the end of a purchase. It stays up, a viber keeps
 * paying for segments as they play, and a browser on this machine shows the
 * picture arriving one paid packet at a time.
 *
 * ## It proves nothing, and that is the difference
 *
 * `pnpm test:devnet` is the evidence: every value it expects is a literal, it
 * asserts the money on chain, and it goes red. This asserts nothing. It is
 * here so that a thing which is true can also be SEEN, by somebody who has not
 * read the test — and the two share their setup, their credentials and their
 * paid requests (`paid.ts`) precisely so that what is demonstrated here is the
 * thing that is proved there.
 *
 * ## What a person does
 *
 *   pnpm demo
 *
 * It brings the chain, the hub and the station up, walks the documented
 * broadcaster order (quote, configure, restart), buys the slot, and then stops
 * and prints an OBS Server and Stream Key. Hit **Start Streaming**, and the
 * page it opened is watching a broadcast that is being paid for.
 *
 *   pnpm demo -- --pattern     the run's own ffmpeg test pattern instead of OBS
 *   pnpm demo -- --port 8088   where the page is served
 *
 * `--pattern` exists so the demo still runs with nobody at the keyboard —
 * it pushes the same generated pattern `devnet.test.ts` broadcasts, from the
 * ffmpeg inside the origin's own image, over this network.
 *
 * ## The one thing that is NOT like the test
 *
 * The station's ingest is published on loopback here — that is what OBS
 * connects to, and `docker-compose.yml` says at length why an authenticated,
 * unpaid direction is not a free door. Everything else holds: the slot app's
 * port and the segment port are published on no interface, and the only route
 * to a segment is a paid packet.
 */

import {
  deploySettlementContracts,
  fundGas,
  mintToken,
  tokenBalance,
  TOKEN_DECIMALS,
  type SettlementDeployment,
} from './chain.js';
import { generateCredentials, type DevnetCredentials } from './credentials.js';
import {
  CHAIN_URL_ON_THE_COMPOSE_NETWORK,
  renderHubConnectorToml,
  renderStationConnectorToml,
} from './config.js';
import { readSelfDescription } from './self-description.js';
import {
  readAcceptedClaims,
  redeemLatestClaim,
  sameChannel,
} from './operator.js';
import {
  connectorPinOfRecord,
  down,
  logs,
  requireDockerDaemon,
  restart,
  up,
} from './compose.js';
import { generatePayerKey, openPayer } from './payer.js';
import {
  startBroadcasting,
  stationNow,
  stopBroadcasting,
  type StationNow,
} from './vibes.js';
import {
  attemptBuy,
  pullQuote,
  pullThroughTheHub,
  type BoughtSlot,
} from './paid.js';
import { startPlayer, type DemoState, type Player } from './player.js';

// ── The topology, at the same numbers the run uses ───────────────────────────

const CHAIN_RPC_URL = 'http://127.0.0.1:8545';
const HUB_EDGE_URL = 'http://127.0.0.1:3000';
const STATION_EDGE_URL = 'http://127.0.0.1:3001';
const HUB_ADDRESS = 'g.toon.slopmachine';

/** The apex a station is configured at before its hub has granted it one. */
const PLACEHOLDER_STATION_APEX = `${HUB_ADDRESS}.demo`;

/** The station AS THE HUB REACHES IT — a compose service, never a loopback publish. */
const STATION_URL_FOR_THE_HUB = 'http://station-connector:3000/ilp';

/** Where the broadcaster's own encoder pushes, and the pair OBS asks for. */
const INGEST_SERVER = 'rtmp://127.0.0.1:1935/live';

const CHAIN_SERVICE = 'chain';
const NODE_SERVICES = [
  'station-origin',
  'station-connector',
  'hub-slot-app',
  'hub-connector',
];

/** The ladder the devnet's origin is configured with, cheapest first. */
const LADDER = ['audio', '480p'];

/** Play money, and generous: nothing here may fail for want of funds. */
const GAS_PER_NODE = 10n ** 18n;
const TOKEN_PER_NODE = 1_000_000_000n;
const FUNDING = {
  gas: 10n ** 18n,
  token: 1_000_000_000n,
  deposit: 100_000_000n,
};

/** Where the page is served, unless `--port` says otherwise. */
const DEFAULT_PORT = 8088;

/** What the devnet's origin is configured to cut, and what the playlist declares. */
const SEGMENT_SECONDS = 2;

/**
 * How far behind the live edge a viber starts buying.
 *
 * Not at the edge itself: a player with one segment in hand has nothing to
 * play while the next one is being paid for, and stalls between every span.
 */
const PREROLL_SEGMENTS = 3;

/**
 * And how far behind it is allowed to fall before it gives up and jumps.
 *
 * The station retains 20 segments. A viber that has drifted past this is
 * buying vibes that are about to be evicted underneath them, so it skips
 * forward — which is what a live player does, and the playlist says so with a
 * discontinuity.
 */
const MAX_SEGMENTS_BEHIND = 10;

// ── The ledger ───────────────────────────────────────────────────────────────

/**
 * What the viber has spent, and how it split.
 *
 * `toStation` and `toHub` are DERIVED FROM THE TWO NODES' OWN PRICES rather
 * than from a fee this file knows: the station publishes what it charges to
 * terminate, the hub's purchase answer says what it charges to carry, and the
 * difference is the hub's. A demo that hard-coded 20 would be showing its own
 * arithmetic.
 */
interface Ledger {
  spent: bigint;
  toStation: bigint;
  toHub: bigint;
  packets: number;
  perRung: Map<string, { bought: number; spent: bigint }>;
}

interface RungPrices {
  /** What a viber pays for one segment at this rung, across the hop. */
  price: bigint;
  /** What the station charges to terminate it. */
  toStation: bigint;
  /** What the hub keeps for carrying it. */
  toHub: bigint;
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));

  const version = await requireDockerDaemon();
  say(`docker ${version}, connector pin ${connectorPinOfRecord()}`);

  // ── The chain ──────────────────────────────────────────────────────────────
  //
  // From nothing, always: a chain carrying a previous run's history lands the
  // settlement contracts at different addresses.
  await down();
  await up([CHAIN_SERVICE]);
  const deployment: SettlementDeployment =
    await deploySettlementContracts(CHAIN_RPC_URL);
  say(
    `chain up; token ${deployment.token}, registry ${deployment.registry} at ${String(TOKEN_DECIMALS)} decimals`
  );

  // ── The two nodes ──────────────────────────────────────────────────────────
  const credentials: DevnetCredentials = generateCredentials();
  for (const settlementAddress of [
    credentials.hub.settlementAddress,
    credentials.station.settlementAddress,
  ]) {
    await fundGas(CHAIN_RPC_URL, settlementAddress, GAS_PER_NODE);
    await mintToken(
      CHAIN_RPC_URL,
      deployment.token,
      settlementAddress,
      TOKEN_PER_NODE
    );
  }

  const chain = {
    rpcUrl: CHAIN_URL_ON_THE_COMPOSE_NETWORK,
    registry: deployment.registry,
    token: deployment.token,
    decimals: TOKEN_DECIMALS,
  };
  renderHubConnectorToml(chain, HUB_ADDRESS);
  // At a placeholder its hub never granted it, which is where a broadcaster's
  // node actually starts.
  renderStationConnectorToml(chain, PLACEHOLDER_STATION_APEX);

  await up(NODE_SERVICES);
  await readSelfDescription(`${HUB_EDGE_URL}/ilp`);
  say('hub and station up');

  // ── The broadcaster ────────────────────────────────────────────────────────
  //
  // Their encoder is asked for FIRST, so it can be connecting while the slot is
  // being bought. A station with no ingest publishes a ladder it is holding
  // nothing at.
  if (options.pattern) {
    await startBroadcasting(credentials.station.streamKey);
    say("broadcasting the run's own test pattern (--pattern)");
  } else {
    printObsInstructions(credentials.station.streamKey);
  }

  const broadcaster = await openPayer({
    who: 'broadcaster',
    connectorUrl: HUB_EDGE_URL,
    rpcUrl: CHAIN_RPC_URL,
    token: deployment.token,
    key: generatePayerKey(),
    funding: FUNDING,
  });

  // The documented order, executed: quote, configure, restart.
  const quote = await pullQuote(broadcaster, HUB_ADDRESS);
  say(
    `quoted: the hub would grant "${quote.prefix}" for ${quote.slotPrice.toString()} a period — that quote cost ${quote.paid.toString()}`
  );

  renderStationConnectorToml(chain, quote.prefix);
  await restart('station-connector');
  const station = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);

  const purchase = await attemptBuy(
    broadcaster,
    HUB_ADDRESS,
    STATION_URL_FOR_THE_HUB
  );
  if (purchase.status !== 200) {
    throw new Error(
      `the purchase was refused ${String(purchase.status)}: ${JSON.stringify(purchase.body)}`
    );
  }
  const bought = purchase.body as BoughtSlot;
  say(
    `slot bought for ${purchase.paid.toString()}: "${bought.prefix}", peered on channel ${bought.peering.channel.id}`
  );

  // ── What each rung costs, from the two nodes rather than from here ─────────
  const prices = new Map<string, RungPrices>();
  for (const rung of [...LADDER, 'now']) {
    const carried = bought.routes.find(
      (route) => route.prefix === `${bought.prefix}.${rung}`
    );
    const terminated = station.routes.find(
      (route) => route.prefix === `${bought.prefix}.${rung}`
    );
    if (carried === undefined || terminated === undefined) continue;

    const price = BigInt(carried.price);
    prices.set(rung, {
      price,
      toStation: terminated.price,
      toHub: price - terminated.price,
    });
  }

  // ── The viber ──────────────────────────────────────────────────────────────
  const viber = await openPayer({
    who: 'viber',
    connectorUrl: HUB_EDGE_URL,
    rpcUrl: CHAIN_RPC_URL,
    token: deployment.token,
    key: generatePayerKey(),
    funding: FUNDING,
  });
  const sealTo = station.edgeIdentity.publicKey;

  const ledger: Ledger = {
    spent: 0n,
    toStation: 0n,
    toHub: 0n,
    packets: 0,
    perRung: new Map(LADDER.map((rung) => [rung, { bought: 0, spent: 0n }])),
  };

  /**
   * Every paid send goes through here, one at a time.
   *
   * A claim strictly advances a nonce the connector has already banked, so two
   * pulls signing at once is two claims racing for one number — and the loser
   * is refused for a reason that has nothing to do with the demo.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const spend = (rung: string, paid: bigint): void => {
    const split = prices.get(rung);
    ledger.spent += paid;
    ledger.packets += 1;
    if (split !== undefined) {
      ledger.toStation += split.toStation;
      ledger.toHub += paid - split.toStation;
    }
    const held = ledger.perRung.get(rung);
    if (held !== undefined) {
      held.bought += 1;
      held.spent += paid;
    }
  };

  // ── What the page reads ────────────────────────────────────────────────────
  let live = false;
  let waitingFor = options.pattern
    ? 'starting the test pattern…'
    : 'waiting for OBS — hit Start Streaming';
  let edge: StationNow | undefined;
  let claimed = 0n;
  let onChain = 0n;
  let redeeming = false;
  let redeemed: { at: number; moved: string } | null = null;
  let stopping = false;

  const state = (): DemoState => ({
    live,
    waitingFor,
    hubAddress: HUB_ADDRESS,
    stationPrefix: bought.prefix,
    handle: bought.label,
    segmentSeconds: edge?.segmentSeconds ?? SEGMENT_SECONDS,
    rungs: LADDER.map((rung) => {
      const split = prices.get(rung);
      const held = ledger.perRung.get(rung);
      return {
        rung,
        price: (split?.price ?? 0n).toString(),
        toStation: (split?.toStation ?? 0n).toString(),
        toHub: (split?.toHub ?? 0n).toString(),
        edge:
          edge?.rungs.find((held2) => held2.rung === rung)?.sequence ?? null,
        bought: held?.bought ?? 0,
        spent: (held?.spent ?? 0n).toString(),
      };
    }),
    spent: ledger.spent.toString(),
    toStation: ledger.toStation.toString(),
    toHub: ledger.toHub.toString(),
    packets: ledger.packets,
    claimed: claimed.toString(),
    onChain: onChain.toString(),
    redeeming,
    redeemed,
  });

  const player: Player = startPlayer({
    port: options.port,
    rungs: LADDER,
    // What `docker-compose.yml` configures this origin's `TOON_SEGMENT_SECONDS`
    // with. The station's own *now* reports it too, but the playlist has to
    // declare a target duration before the first pull has been paid for.
    segmentSeconds: SEGMENT_SECONDS,
    state,
    redeem: async () => {
      if (redeeming) return;
      redeeming = true;
      try {
        const before = await tokenBalance(
          CHAIN_RPC_URL,
          deployment.token,
          credentials.station.settlementAddress
        );
        const answer = await redeemLatestClaim({
          baseUrl: STATION_EDGE_URL,
          writeKey: credentials.station.operatorWriteKey,
          channelId: bought.peering.channel.id,
        });
        if (answer.status !== 200) {
          throw new Error(
            `the station's connector answered ${String(answer.status)}: ${answer.body}`
          );
        }
        const after = await tokenBalance(
          CHAIN_RPC_URL,
          deployment.token,
          credentials.station.settlementAddress
        );
        onChain = after;
        redeemed = { at: Date.now(), moved: (after - before).toString() };
        say(
          `redeemed on chain: the broadcaster's balance moved by ${(after - before).toString()}, and the channel is still open`
        );
      } finally {
        redeeming = false;
      }
    },
  });

  say(`the page is at ${player.url}`);

  // ── The stop signal ────────────────────────────────────────────────────────
  //
  // Armed HERE, ahead of the wait below, because that wait is the longest
  // thing in the run and the likeliest moment for somebody to change their
  // mind. Armed after it, a Ctrl-C while looking for the Start Streaming
  // button would take the default signal — killing this process and leaving
  // five containers, a chain and a payment channel standing.
  const stopped = new Promise<void>((halted) => {
    const halt = (): void => {
      stopping = true;
      halted();
    };
    process.once('SIGINT', halt);
    process.once('SIGTERM', halt);
  });

  const tearDown = async (): Promise<void> => {
    await player.close();
    await viber.client.close();
    await broadcaster.client.close();
    await stopBroadcasting();
    await down();
    say('torn down');
  };

  // ── Waiting for vibes ──────────────────────────────────────────────────────
  edge = await waitForTheBroadcaster(() => stopping, options.pattern);
  if (stopping) {
    await tearDown();
    return;
  }
  live = true;
  waitingFor = 'on the air';
  say(`the station is on the air — buying from ${player.url}`);

  // ── The viber's loop ───────────────────────────────────────────────────────
  //
  // One `now` per cycle, paid for like everything else, and then every span
  // between where this viber got to and where the live edge is. There is no
  // free call in here: `/now` is a priced address of the station's precisely
  // so that finding the live edge is not the one thing a station gives away.
  const cursor = new Map<string, number>();

  const cycle = async (): Promise<void> => {
    const answer = await serially(() =>
      pullThroughTheHub(viber, sealTo, `${bought.prefix}.now`)
    );
    spend('now', answer.paid);
    if (answer.status !== 200) return;

    edge = JSON.parse(answer.text) as StationNow;
    live = edge.live;

    for (const rung of LADDER) {
      const latest = edge.rungs.find((held) => held.rung === rung)?.sequence;
      if (latest === null || latest === undefined) continue;

      let at = cursor.get(rung);
      if (at === undefined) at = Math.max(0, latest - PREROLL_SEGMENTS);
      // Fallen behind the station's own window: the vibes in between are
      // being evicted underneath us, so skip to where they still exist.
      if (latest - at > MAX_SEGMENTS_BEHIND) {
        at = latest - PREROLL_SEGMENTS;
        player.missed(rung);
      }

      for (; at <= latest; at += 1) {
        if (stopping) return;
        // Bound to a const before it is handed to the queue. `serially` runs
        // its closure later than it is written, and a closure over the loop
        // variable would pay for whichever sequence the loop had reached by
        // then rather than the one it meant to buy.
        const wanted = at;
        const segment = await serially(() =>
          pullThroughTheHub(
            viber,
            sealTo,
            `${bought.prefix}.${rung}`,
            `${String(wanted)}.ts`
          )
        );
        spend(rung, segment.paid);

        // A 404 rode home on a FULFILL and cost exactly what a 200 costs —
        // that is what a paid answer is. It is simply not vibes.
        if (segment.status === 200) player.publish(rung, wanted, segment.body);
        else player.missed(rung);
      }
      cursor.set(rung, at);
    }
  };

  // What the broadcaster's own node says it has banked, and what is on chain.
  // Read off the STATION's operator surface, never inferred from what the
  // viber paid: the two agreeing is the interesting part.
  const watchTheMoney = async (): Promise<void> => {
    try {
      const claims = await readAcceptedClaims(
        STATION_EDGE_URL,
        credentials.station.bearerToken
      );
      for (const claim of claims) {
        if (
          claim.direction === 'inbound' &&
          sameChannel(claim.channelId, bought.peering.channel.id) &&
          claim.cumulativeAmount > claimed
        ) {
          claimed = claim.cumulativeAmount;
        }
      }
      if (!redeeming) {
        onChain = await tokenBalance(
          CHAIN_RPC_URL,
          deployment.token,
          credentials.station.settlementAddress
        );
      }
    } catch {
      // A poll that missed is a poll; the next one is two seconds away.
    }
  };

  const money = setInterval(() => void watchTheMoney(), 2_000);

  // ── Until somebody stops it ────────────────────────────────────────────────
  while (!stopping) {
    try {
      await cycle();
    } catch (cause) {
      // A refused packet is not the end of a broadcast. Say so and keep going:
      // a demo that exited on one transient would be a worse demo than one
      // that shows a gap.
      say(
        `a pull did not land: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    await Promise.race([
      stopped,
      new Promise((waited) => setTimeout(waited, 1_000)),
    ]);
  }

  clearInterval(money);

  // ── The receipt ────────────────────────────────────────────────────────────
  console.log('');
  say('what happened:');
  console.log(
    [
      `  the viber paid          ${ledger.spent.toString()} in ${String(ledger.packets)} packets`,
      `  the broadcaster earned  ${ledger.toStation.toString()}`,
      `  the hub carried it for  ${ledger.toHub.toString()}`,
      `  banked off chain        ${claimed.toString()}`,
      `  settled on chain        ${onChain.toString()}`,
      '',
      '  every one of those segments was a signature, not a transaction.',
    ].join('\n')
  );

  await tearDown();
}

/**
 * Wait for a broadcaster who may be a person.
 *
 * Deliberately unbounded, unlike the run's own `waitForVibes`: that one is
 * putting a limit on a failure, and this one is waiting for somebody to find
 * the Start Streaming button. Ctrl-C is how it ends early.
 */
async function waitForTheBroadcaster(
  stopping: () => boolean,
  pattern: boolean
): Promise<StationNow> {
  let said = 0;
  for (;;) {
    if (stopping()) return { live: false, segmentSeconds: 0, rungs: [] };

    let now: StationNow | undefined;
    try {
      now = await stationNow();
    } catch {
      // The origin is up — compose waited for its healthcheck — so this is a
      // blip rather than news.
    }

    const holding = (now?.rungs ?? []).filter((rung) => rung.sequence !== null);
    if (now?.live === true && holding.length === LADDER.length) return now;

    if (Date.now() - said > 10_000) {
      said = Date.now();
      say(
        pattern
          ? 'waiting for the test pattern to fill its first segments…'
          : 'waiting for OBS — Start Streaming, and this will pick it up within a couple of seconds'
      );
    }
    await new Promise((waited) => setTimeout(waited, 1_500));
  }
}

/** The Server and Stream Key pair, which is exactly what OBS asks for. */
function printObsInstructions(streamKey: string): void {
  console.log(
    [
      '',
      '  ┌─ OBS ────────────────────────────────────────────────────────────',
      '  │  Settings → Stream',
      '  │    Service      Custom…',
      `  │    Server       ${INGEST_SERVER}`,
      `  │    Stream Key   ${streamKey}`,
      '  │',
      '  │  Settings → Output → Output Mode: Advanced → Streaming',
      '  │    Keyframe Interval   2 s     ← this one matters: the origin cuts',
      '  │                                  2-second segments on keyframes',
      '  │',
      '  │  Then hit Start Streaming.',
      '  └──────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

interface Arguments {
  pattern: boolean;
  port: number;
}

function readArguments(argv: string[]): Arguments {
  const parsed: Arguments = { pattern: false, port: DEFAULT_PORT };

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === '--pattern') parsed.pattern = true;
    else if (argument === '--port') {
      const port = Number(argv[at + 1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(
          `--port wants a port number, not ${String(argv[at + 1])}`
        );
      }
      parsed.port = port;
      at += 1;
    } else if (argument !== undefined) {
      throw new Error(
        `the demo takes --pattern and --port, and does not know "${argument}"`
      );
    }
  }
  return parsed;
}

function say(what: string): void {
  console.log(`[demo] ${what}`);
}

try {
  await main();
} catch (cause) {
  console.error(`\n[demo] it did not come up: ${String(cause)}\n`);
  // The same courtesy a red run pays: the logs of what actually happened,
  // before the containers that hold them are gone. Every step of this is
  // wrapped, because the commonest reason to be here at all is that Docker did
  // not answer — and a teardown that then throws its own error buries the one
  // sentence the reader needed.
  try {
    console.error(await logs());
  } catch {
    // No project to read logs from. The error above is the whole story.
  }
  try {
    await stopBroadcasting();
    await down();
  } catch {
    // Nothing came up, so there is nothing to take down.
  }
  process.exitCode = 1;
}
