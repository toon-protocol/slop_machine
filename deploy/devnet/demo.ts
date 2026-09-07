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
 *   pnpm demo -- --anyone      host the hub behind an Anyone-network hidden
 *                              service, so REMOTE viewers can pay for the
 *                              broadcast over the circuit
 *
 * `--pattern` exists so the demo still runs with nobody at the keyboard —
 * it pushes the same generated pattern `devnet.test.ts` broadcasts, from the
 * ffmpeg inside the origin's own image, over this network.
 *
 * `--anyone` fronts the hub's client edge and the chain's RPC with ONE hidden
 * service (the `hub-anon` compose service, behind a profile so nothing else
 * ever starts it), makes every payer here dial the hub at its `.anyone`
 * address through the daemon's SOCKS side, and prints three funded keys and
 * the exact `pnpm demo:viewer` command a remote viewer runs. The address is
 * persisted in `run/hub-anon/hs/` so it survives across runs.
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
  execIn,
  logs,
  requireDockerDaemon,
  restart,
  up,
} from './compose.js';
import { ANYONE_PROFILE, HS_HOSTNAME_PATTERN } from './anon.js';
import { generatePayerKey, openPayer, type PayerKey } from './payer.js';
import {
  createLedger,
  createViberCycle,
  withCircuitPatience,
  type Ledger,
  type RungPrices,
} from './viber-loop.js';
import {
  startBroadcasting,
  stationNow,
  stopBroadcasting,
  type StationNow,
} from './vibes.js';
import { attemptBuy, pullQuote, type BoughtSlot } from './paid.js';
import {
  broadcasterVoice,
  publishClip,
  publishHeartbeat,
  publishProfile,
  publishStationAnnouncement,
} from './announce.js';
import { startPlayer, type DemoState, type Player } from './player.js';
import { FIRST_LIGHT, firstLightMedia } from './clip-media.js';

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
  'hub-relay',
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

/**
 * The viber's own budget, in base units per second — the paying side's figure,
 * which ADR 0005 says nothing across the loopback line can raise. Buying the
 * whole two-rung ladder plus the *now* runs to about 700 a second at the
 * devnet's prices, so this covers it with room and is still a real bound.
 */
const BUDGET_PER_SECOND = 1000n;

/**
 * Web origins allowed to initiate spend across the playback contract, beside
 * the player's own page (which is allowlisted by construction). This is the
 * guide as its own harness serves it — `pnpm test:guide` runs vite on 4173 —
 * under both spellings of loopback, because a person typing `localhost` is
 * still this machine. The allowlist is the paying side's own configuration
 * (ADR 0005): it is wired HERE, on the paying side, and nothing across the
 * line can extend it.
 */
const GUIDE_ORIGINS = ['http://127.0.0.1:4173', 'http://localhost:4173'];

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

/**
 * The same two numbers, widened for `--anyone` — and ONLY there. A pull over
 * the circuit pays for several overlay hops each way, so its round trip is
 * tens of loopback's: a viber that started three segments back would spend
 * its whole preroll on the first exchange, and the 10-segment jump threshold
 * would fire on ordinary circuit jitter rather than on real drift. Both stay
 * under the station's 20-segment window, which is the number that makes a
 * jump mean anything.
 */
const PREROLL_SEGMENTS_ANYONE = 5;
const MAX_SEGMENTS_BEHIND_ANYONE = 15;

/** The SOCKS side of the hub's own daemon, as `docker-compose.yml` publishes it. */
const HUB_SOCKS_PROXY = 'socks5h://127.0.0.1:9050';

/** How long a first bootstrap onto the live Anyone network may take. */
const HS_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

/** How many remote viewers an `--anyone` run funds keys for. */
const VIEWER_KEYS = 3;

// ── The announcements (ADR 0004) ─────────────────────────────────────────────

/** What a viber's client would render for this broadcaster, anywhere Nostr is read. */
const BROADCASTER_PROFILE = {
  name: 'The Demo Broadcaster',
  about: 'your own OBS, playing back one paid packet at a time',
  picture: 'https://example.invalid/demo-broadcaster.png',
};

/** The station's own about, and the free-form categories it announces itself under. */
const STATION_ABOUT = 'whatever you point OBS at';
const STATION_CATEGORIES = ['slop', 'demo'];

// The clip is `clip-media.ts`'s: real sound the run itself serves, so the
// clip event names a URL the guide's broadcaster page can genuinely play.
// Published after the player is up, because the URL is the player's.

/**
 * The heartbeat cadence, while on the air. The expiry is three beats, so one
 * missed republish is not a false death — and when this process dies, the
 * station reads as off the air within a minute with no sign-off published,
 * because none exists to publish.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_EXPIRES_IN_SECONDS = 45;

// The ledger, the one-at-a-time queue and the pull cycle live in
// `viber-loop.ts` — one implementation, shared with the remote viewer, so
// that "how a viber buys a broadcast" cannot drift into two.

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

  // ── The hidden service, when asked for ─────────────────────────────────────
  //
  // BEFORE the hub's configuration can be rendered, because the hub has to
  // advertise the address and the address does not exist until the daemon has
  // generated it — the same circle a real operator breaks by starting their
  // daemon first and copying the hostname down. The daemon's own healthcheck
  // gates on SOCKS answering; full bootstrap and the address are waited for
  // here, because a container that is Up is not a container with a circuit.
  let hubHiddenService: string | null = null;
  if (options.anyone) {
    await up(['hub-anon'], { profiles: [ANYONE_PROFILE] });
    say('anon is up — bootstrapping onto the live Anyone network…');
    hubHiddenService = await waitForHiddenService();
    say(`the hub is reachable at http://${hubHiddenService}`);
  }

  // In `--anyone` mode every payer — the broadcaster, this run's own viber,
  // and any remote viewer — dials the hub at its `.anyone` address, so that
  // is what the hub advertises; otherwise its payers are on this machine's
  // loopback publish, exactly as `devnet.test.ts` renders it.
  renderHubConnectorToml(
    chain,
    HUB_ADDRESS,
    hubHiddenService === null
      ? `${HUB_EDGE_URL}/ilp`
      : `http://${hubHiddenService}/ilp`
  );
  // At a placeholder its hub never granted it, which is where a broadcaster's
  // node actually starts.
  renderStationConnectorToml(chain, PLACEHOLDER_STATION_APEX);

  await up(NODE_SERVICES);
  await readSelfDescription(`${HUB_EDGE_URL}/ilp`);
  say('hub and station up');

  // How this run's own payers reach the hub: over the circuit when there is
  // one — the point of `--anyone` is that the paid path rides it — and over
  // the loopback publish otherwise. The chain stays direct either way: it is
  // this machine's own anvil, and `proxyRpc: false` is the documented opt-out
  // for exactly that case (connector ADR 0070 decision 4; `local/anyone`'s
  // payer takes the same one).
  const payerReach =
    hubHiddenService === null
      ? { connectorUrl: HUB_EDGE_URL }
      : {
          connectorUrl: `http://${hubHiddenService}`,
          socksProxy: HUB_SOCKS_PROXY,
          proxyRpc: false,
        };

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

  const onCircuit = hubHiddenService !== null;
  const broadcaster = await withCircuitPatience(
    onCircuit,
    "the broadcaster's channel",
    say,
    () =>
      openPayer({
        who: 'broadcaster',
        ...payerReach,
        rpcUrl: CHAIN_RPC_URL,
        token: deployment.token,
        key: generatePayerKey(),
        funding: FUNDING,
      })
  );

  // The documented order, executed: quote, configure, restart.
  const quote = await withCircuitPatience(onCircuit, 'the quote', say, () =>
    pullQuote(broadcaster, HUB_ADDRESS)
  );
  say(
    `quoted: the hub would grant "${quote.prefix}" for ${quote.slotPrice.toString()} a period — that quote cost ${quote.paid.toString()}`
  );

  renderStationConnectorToml(chain, quote.prefix);
  await restart('station-connector');
  const station = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);

  // Safe to repeat over a flaky circuit: the buy is retry-safe by the slot
  // app's own design — a repeat finds the established peering, deposits only
  // a shortfall, and upserts the routes.
  const purchase = await withCircuitPatience(
    onCircuit,
    'the purchase',
    say,
    () => attemptBuy(broadcaster, HUB_ADDRESS, STATION_URL_FOR_THE_HUB)
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

  // ── The announcements ──────────────────────────────────────────────────────
  //
  // Reachable, and now FOUND: the profile and the station announcement, each
  // an ordinary paid write through the hub's announce route, signed with the
  // per-broadcaster keypair this run minted. The ladder is DERIVED from the
  // station connector's own published routes — the demo restates no price.
  // The clip follows once the player is up, because the clip event names a
  // URL the player serves; the heartbeat starts once the station is on the
  // air.
  const voice = broadcasterVoice(credentials.station.nostrSecretKey);
  await withCircuitPatience(onCircuit, 'the profile announcement', say, () =>
    publishProfile(broadcaster, HUB_ADDRESS, voice, BROADCASTER_PROFILE)
  );
  await withCircuitPatience(onCircuit, 'the station announcement', say, () =>
    publishStationAnnouncement(broadcaster, HUB_ADDRESS, voice, {
      prefix: bought.prefix,
      segmentSeconds: SEGMENT_SECONDS,
      rungs: LADDER.flatMap((rung) => {
        const published = station.routes.find(
          (route) => route.prefix === `${bought.prefix}.${rung}`
        );
        return published === undefined
          ? []
          : [{ rung, price: published.price }];
      }),
      categories: STATION_CATEGORIES,
      about: STATION_ABOUT,
    })
  );
  say(
    `announced: profile and station are on the relay, signed by ${voice.pubkey.slice(0, 12)}…`
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
  const viber = await withCircuitPatience(
    onCircuit,
    "the viber's channel",
    say,
    () =>
      openPayer({
        who: 'viber',
        ...payerReach,
        rpcUrl: CHAIN_RPC_URL,
        token: deployment.token,
        key: generatePayerKey(),
        funding: FUNDING,
      })
  );
  const sealTo = station.edgeIdentity.publicKey;

  const ledger: Ledger = createLedger(LADDER);

  // ── The remote viewers, when there is a circuit for them ───────────────────
  //
  // Three keys, each funded with gas and the settlement token on this run's
  // chain — no channel: a viewer's own client opens one over the circuit,
  // which is the half `pnpm demo:viewer` exists to prove. What is printed is
  // everything a viewer needs and nothing the host must hold back: the
  // address is public, the seal-to key is the station's PUBLIC edge identity
  // (a viewer seals segment pulls to the station and cannot read the
  // station's self-description, so the host hands it out), and the keys are
  // this play-chain's money.
  if (hubHiddenService !== null) {
    const viewerKeys: PayerKey[] = [];
    for (let held = 0; held < VIEWER_KEYS; held += 1) {
      const key = generatePayerKey();
      await fundGas(CHAIN_RPC_URL, key.address, GAS_PER_NODE);
      await mintToken(
        CHAIN_RPC_URL,
        deployment.token,
        key.address,
        TOKEN_PER_NODE
      );
      viewerKeys.push(key);
    }
    printViewerInstructions({
      hiddenService: hubHiddenService,
      stationPrefix: bought.prefix,
      sealTo,
      keys: viewerKeys,
      prices,
    });
  }

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

  const player: Player = await startPlayer({
    port: options.port,
    rungs: LADDER,
    // What `docker-compose.yml` configures this origin's `TOON_SEGMENT_SECONDS`
    // with. The station's own *now* reports it too, but the playlist has to
    // declare a target duration before the first pull has been paid for.
    segmentSeconds: SEGMENT_SECONDS,
    // The playback contract (ADR 0005): the demo IS the paying side, so it
    // starts vibing of its own accord — the state is the record, and the
    // page's rung buttons select through the contract like any guide would.
    contract: {
      station: bought.prefix,
      budgetPerSecond: BUDGET_PER_SECOND,
      allowedOrigins: GUIDE_ORIGINS,
      vibing: true,
    },
    // The demo's one clip: real sound this run serves itself, free to read.
    clip: {
      fileName: FIRST_LIGHT.fileName,
      contentType: FIRST_LIGHT.contentType,
      body: firstLightMedia(),
    },
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

  // ── The clip ───────────────────────────────────────────────────────────────
  //
  // One clip, one event (ADR 0004), pointed at media the run itself serves —
  // the player's own loopback URL — so a guide reading the relay can play it
  // from a free fetch, for real. On a real station this URL is an Arweave
  // gateway's; the shape of the event is identical.
  if (player.clipUrl !== null) {
    const clipUrl = player.clipUrl;
    await withCircuitPatience(onCircuit, 'the clip announcement', say, () =>
      publishClip(broadcaster, HUB_ADDRESS, voice, {
        url: clipUrl,
        title: FIRST_LIGHT.title,
        durationSeconds: FIRST_LIGHT.durationSeconds,
        description: FIRST_LIGHT.description,
      })
    );
    say(`a clip is on the relay: "${FIRST_LIGHT.title}" at ${player.clipUrl}`);
  }

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

  // ── The heartbeat, while on the air ────────────────────────────────────────
  //
  // Liveness IS the existence of an unexpired heartbeat (ADR 0004): while the
  // station is on the air this republishes one on a cadence, each with a
  // short NIP-40 expiry, and when the process dies the claim expires on its
  // own. One beat in flight at a time — a claim strictly advances a nonce, so
  // two writes signing at once would race for one number.
  let heartbeatInFlight = false;
  const beat = async (): Promise<void> => {
    if (heartbeatInFlight || stopping) return;
    heartbeatInFlight = true;
    try {
      await publishHeartbeat(
        broadcaster,
        HUB_ADDRESS,
        voice,
        Math.floor(Date.now() / 1000) + HEARTBEAT_EXPIRES_IN_SECONDS
      );
    } catch (cause) {
      say(
        `a heartbeat did not land: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    } finally {
      heartbeatInFlight = false;
    }
  };
  await beat();
  const heartbeats = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

  // ── The viber's loop ───────────────────────────────────────────────────────
  //
  // The shared cycle (`viber-loop.ts`): one `now` per call, paid for like
  // everything else, and then every span between where this viber got to and
  // where the live edge is. There is no free call in there — `/now` is a
  // priced address of the station's precisely so that finding the live edge
  // is not the one thing a station gives away. Over a circuit the viber
  // starts further back and tolerates more drift, because a pull's round trip
  // is tens of loopback's — the constants say so at length.
  const cycle = createViberCycle({
    viber,
    sealTo,
    stationPrefix: bought.prefix,
    ladder: LADDER,
    prerollSegments:
      hubHiddenService === null ? PREROLL_SEGMENTS : PREROLL_SEGMENTS_ANYONE,
    maxSegmentsBehind:
      hubHiddenService === null
        ? MAX_SEGMENTS_BEHIND
        : MAX_SEGMENTS_BEHIND_ANYONE,
    ledger,
    prices,
    vibing: () => player.vibing(),
    stopping: () => stopping,
    onEdge: (now) => {
      edge = now;
      live = now.live;
    },
    publish: (rung, sequence, body) => {
      player.publish(rung, sequence, body);
    },
    missed: (rung) => {
      player.missed(rung);
    },
  });

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
  clearInterval(heartbeats);

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

/**
 * Wait for the hub's daemon to have a circuit AND an address.
 *
 * The healthcheck already gated on the SOCKS port answering; this waits for
 * `Bootstrapped 100%` in the daemon's own log — the first moment a descriptor
 * can be published — and for the hostname file, read out of the container
 * because the daemon owns that directory. The address is then validated by
 * shape, and an `.onion` answer is diagnosed as what it is: the OLDER daemon,
 * from before upstream renamed the TLD — a wrong build, not a wrong config.
 */
async function waitForHiddenService(): Promise<string> {
  const deadline = Date.now() + HS_BOOTSTRAP_TIMEOUT_MS;
  let address = '';
  let said = 0;

  for (;;) {
    try {
      address = (
        await execIn('hub-anon', [
          'cat',
          '/var/lib/anon/hidden_service/hostname',
        ])
      ).trim();
    } catch {
      // Not generated yet — key generation is seconds in, so this is early.
    }

    let bootstrapped = false;
    try {
      const count = await execIn('hub-anon', [
        'grep',
        '-c',
        'Bootstrapped 100%',
        '/var/lib/anon/notice.log',
      ]);
      bootstrapped = Number(count.trim()) > 0;
    } catch {
      // `grep -c` exits non-zero on zero matches: still building circuits.
    }

    if (address.length > 0 && bootstrapped) break;

    if (Date.now() > deadline) {
      throw new Error(
        `the anon daemon did not bootstrap within ${String(HS_BOOTSTRAP_TIMEOUT_MS / 1000)}s — the Anyone network is a live third-party network, so this can be it or the way to it. \`docker compose logs hub-anon\` says which. (Hostname so far: ${JSON.stringify(address)})`
      );
    }
    if (Date.now() - said > 15_000) {
      said = Date.now();
      say('still bootstrapping onto the Anyone network…');
    }
    await new Promise((waited) => setTimeout(waited, 5_000));
  }

  if (!HS_HOSTNAME_PATTERN.test(address)) {
    throw new Error(
      `the daemon produced "${address}", which is not a 56-character .anyone address. An address ending .onion means the image is anon v0.4.9.7 — the release before upstream renamed the TLD — and the payer refuses that spelling; deploy/devnet/anon/Dockerfile is the build that fixes it.`
    );
  }
  return address;
}

/**
 * Everything a remote viewer needs, printed once — and nothing here is a
 * secret the host should have kept: the address is the station's public door,
 * the seal-to key is public material, and the keys hold this run's play
 * money, minted to be handed out.
 */
function printViewerInstructions(options: {
  hiddenService: string;
  stationPrefix: string;
  sealTo: string;
  keys: PayerKey[];
  prices: Map<string, RungPrices>;
}): void {
  const pricePairs = [...options.prices.entries()]
    .map(([rung, split]) => `--price ${rung}=${split.toStation.toString()}`)
    .join(' ');

  console.log(
    [
      '',
      '  ┌─ Remote viewers ─────────────────────────────────────────────────',
      '  │  From a checkout of this repository, with Docker running:',
      '  │',
      '  │    pnpm demo:viewer -- \\',
      `  │      --connector http://${options.hiddenService} \\`,
      `  │      --station ${options.stationPrefix} \\`,
      `  │      --seal-to ${options.sealTo} \\`,
      `  │      ${pricePairs} \\`,
      '  │      --key <one of the keys below>',
      '  │',
      "  │  One funded key per viewer (gas and token, on this run's chain):",
      ...options.keys.map((key) => `  │    ${key.privateKey}`),
      '  │',
      '  │  The viewer builds its own anon daemon image on first run and pays',
      '  │  over the circuit — bootstrap takes a minute or two, and the first',
      '  │  segments a while longer. --socks skips the managed daemon if one',
      '  │  is already running.',
      '  └──────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

interface Arguments {
  pattern: boolean;
  port: number;
  anyone: boolean;
}

function readArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    pattern: false,
    port: DEFAULT_PORT,
    anyone: false,
  };

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === '--pattern') parsed.pattern = true;
    else if (argument === '--anyone') parsed.anyone = true;
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
        `the demo takes --pattern, --anyone and --port, and does not know "${argument}"`
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
