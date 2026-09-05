/**
 * The devnet run — `pnpm test:devnet`.
 *
 * Deliberately NOT part of `pnpm test`. The ordinary suite boots real apps and
 * encodes real vibes, and it does all of that with no Docker daemon; this one
 * brings a chain and, from #57 onward, both node shapes up in containers, so
 * it has its own configuration, its own timeout and its own CI job.
 *
 * What it is for is the thing nobody in this repository has ever seen: a
 * viber's packet crossing a hub and paying a broadcaster. It gets there one
 * slice at a time, and this is the first — the chain, and the settlement
 * contracts landing where the rest of the fleet says they land.
 *
 * ## Every expected value here is a literal
 *
 * Same rule as the three bundle guards. The deployment's own return value is
 * what the rest of a run uses, and the deterministic addresses are held here
 * and compared against it — so a replay that drifts is a loud failure naming
 * both addresses rather than a chain that is quietly not the fleet's, and a
 * configuration copied from a sibling repo is either right here or wrong here.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import { createWriteSigner } from '../../packages/slot-app/src/operator/write-signature.js';
import {
  anvilAccount,
  chainClients,
  channelOnChain,
  channelParticipant,
  CHANNEL_OPEN,
  deploySettlementContracts,
  fundGas,
  mintToken,
  tokenBalance,
  tokenDecimals,
  TOKEN_DECIMALS,
  type SettlementDeployment,
} from './chain.js';
import {
  generateCredentials,
  GENERATED_FILES,
  HUB_CONNECTOR_TOML,
  STATION_CONNECTOR_TOML,
  WORK_DIR,
  type DevnetCredentials,
} from './credentials.js';
import {
  CHAIN_URL_ON_THE_COMPOSE_NETWORK,
  renderHubConnectorToml,
  renderStationConnectorToml,
  type ChainSettings,
} from './config.js';
import {
  readSelfDescription,
  type SelfDescription,
} from './self-description.js';
import {
  basePriceOf,
  readAcceptedClaims,
  readCarriedPeerings,
  readCarriedRoutes,
  redeemLatestClaim,
  slopeOf,
  type AcceptedClaim,
  type CarriedPeering,
  type CarriedRoute,
} from './operator.js';
import {
  down,
  logs,
  requireDockerDaemon,
  restart,
  up,
  connectorPinOfRecord,
} from './compose.js';
import {
  generatePayerKey,
  openPayer,
  type Payer,
  type PayerKey,
} from './payer.js';
import {
  segmentDigest,
  startBroadcasting,
  stationNow,
  stopBroadcasting,
  uplinkLogs,
  waitForVibes,
  type StationNow,
} from './vibes.js';

/** The chain's own RPC, on loopback. Nothing in this topology is reachable off-box. */
const CHAIN_RPC_URL = 'http://127.0.0.1:8545';

/** The chain the whole fleet's local settlement runs on. */
const EXPECTED_CHAIN_ID = 31337;

/** How many accounts anvil funds, and therefore how many the deployer is one of. */
const EXPECTED_FUNDED_ACCOUNTS = 10;

/**
 * How long the chain is watched doing nothing, to prove no clock is mining.
 *
 * Anvil's shortest meaningful `--block-time` is one second, so a window
 * comfortably past that is what tells "no block time" apart from "a block time
 * that has not fired yet".
 */
const IDLE_OBSERVATION_MS = 2_500;

/**
 * A `{{PLACEHOLDER}}` nobody filled — the renderer's own shape, which is not
 * merely "two braces": both templates explain in their own headers that
 * `config.ts` fills every `{{…}}` below, and a check that matched prose would
 * fail on a file that had rendered perfectly.
 */
const AN_UNFILLED_PLACEHOLDER = /\{\{[A-Z_]+\}\}/;

/**
 * The deterministic addresses the rest of the fleet commits — the connector's
 * own `local/solo/connector.toml` names the first two, and every sibling
 * repo's devnet is configured against them.
 *
 * They are a function of account zero and its nonce, so they hold for as long
 * as the replay is these three transactions in this order from that account.
 * A fourth transaction inserted ahead of them moves all three silently, and a
 * configuration copied from a sibling repo would then be pointed at nothing.
 * That is what this file is here to make loud.
 */
const EXPECTED_TOKEN: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const EXPECTED_REGISTRY: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

const CHAIN_SERVICE = 'chain';

// ── The two nodes ────────────────────────────────────────────────────────────

/**
 * Each connector's client edge, on loopback and on its OWN host port. Two
 * connectors share a machine here, which is the whole reason these differ
 * while both containers still listen on 3000 inside.
 */
const HUB_EDGE_URL = 'http://127.0.0.1:3000';
const STATION_EDGE_URL = 'http://127.0.0.1:3001';

/** The hub's ILP apex — the same value the slot app is given as TOON_HUB_ADDRESS. */
const HUB_ADDRESS = 'g.toon.slopmachine';

/**
 * The apex the station is FIRST rendered at, and it is deliberately not one
 * this hub would ever grant.
 *
 * `deploy/README.md` tells a broadcaster to pull a quote before editing their
 * own `connector.toml`, because the prefix they are reachable at is the one
 * their hub grants and `demo` is a placeholder that was never theirs to
 * choose. A run boots here, quotes, and re-renders at the granted prefix —
 * the documented order, executed rather than described.
 */
const PLACEHOLDER_STATION_APEX = `${HUB_ADDRESS}.demo`;

/** Every route each node terminates, and at what price. The templates' own numbers. */
const EXPECTED_HUB_ROUTES: { prefix: string; price: bigint }[] = [
  { prefix: `${HUB_ADDRESS}.slot.quote`, price: 50n },
  { prefix: `${HUB_ADDRESS}.slot.buy`, price: 1_000_000n },
];
const EXPECTED_STATION_ROUTES: { rung: string; price: bigint }[] = [
  { rung: 'now', price: 50n },
  { rung: 'audio', price: 200n },
  { rung: '480p', price: 1000n },
];

/** Every service the two nodes are, in the order compose is asked for them. */
const NODE_SERVICES = [
  'station-origin',
  'station-connector',
  'hub-slot-app',
  'hub-connector',
];

/**
 * What each node's settlement key is funded with before it boots.
 *
 * Gas, because every key a run generates is fresh material with nothing behind
 * it; and the token, because a hub fronts collateral toward every broadcaster
 * it admits and a station has to be able to redeem what it was paid. Both are
 * generous on a chain whose money is play money — the point is that neither
 * node ever fails for want of funds, so a failure is about the thing under
 * test.
 */
const GAS_PER_NODE = 10n ** 18n; // one ether
const TOKEN_PER_NODE = 1_000_000_000n; // a thousand of a six-decimal token

// ── The broadcaster ──────────────────────────────────────────────────────────

/**
 * What the broadcaster's payer is given.
 *
 * The deposit covers a quote and a slot with room to spare — an under-funded
 * channel refuses a packet for a reason that has nothing to do with what a run
 * is proving, and this chain's money is play money.
 */
const BROADCASTER_FUNDING = {
  gas: 10n ** 18n,
  token: 1_000_000_000n,
  deposit: 100_000_000n,
};

/** The two rungs a station is asked to be holding vibes at before anything is bought. */
const LADDER = ['audio', '480p'];

/**
 * How long the encoders are given to produce a first segment at every rung.
 *
 * Segments are two seconds here, so this is many times over what it takes —
 * it is a bound on a failure, not an expectation. What it actually covers is
 * the uplink connecting and the origin accepting the stream key.
 */
const FIRST_SEGMENT_TIMEOUT_MS = 60_000;

/** What the hub charges for a quote, and what it charges for a slot. */
const EXPECTED_QUOTE_PRICE = 50n;
const EXPECTED_SLOT_PRICE = 1_000_000n;

/** The fixed segment duration the devnet configures its origin with. */
const EXPECTED_SEGMENT_SECONDS = 2;

// ── The viber ────────────────────────────────────────────────────────────────

/**
 * What the viber's payer is given. The same shape as the broadcaster's and for
 * the same reason: an under-funded channel refuses a packet for a reason that
 * has nothing to do with what a run is proving.
 */
const VIBER_FUNDING = {
  gas: 10n ** 18n,
  token: 1_000_000_000n,
  deposit: 100_000_000n,
};

/**
 * The two rungs the viber buys at, and they are two on purpose.
 *
 * A rung being its own address at its own price is the design (ADR 0002), and
 * a run that pulled once would exercise neither half of it. These are the
 * cheap one, carrying only sound, and a dearer one with a picture.
 */
const FIRST_RUNG = 'audio';
const SECOND_RUNG = '480p';

/**
 * A rung the station does not offer. The hub wrote one route per address the
 * station PUBLISHES, so this is an address nothing in the topology carries.
 */
const A_RUNG_THE_STATION_DOES_NOT_OFFER = '720p';

/**
 * A sequence no station has ever held — far past the live edge of a broadcast
 * that has been running for seconds, and far past the window either way.
 */
const A_SEQUENCE_THE_STATION_DOES_NOT_HOLD = 999_999;

/** MPEG-TS packets begin with this byte, every 188 of them. */
const MPEG_TS_SYNC_BYTE = 0x47;

/** A claim coming TO a node — money it was paid, rather than money it sent. */
const INBOUND = 'inbound';

// ── The purchase ─────────────────────────────────────────────────────────────

/**
 * The station's self-description URL **as the hub reaches it**.
 *
 * The purchase body carries one thing and this is it. It is the compose
 * service and not the driver's loopback publish, because the hub GETs this URL
 * from inside its own network — the fetch is the hub's, not the run's.
 */
const STATION_URL_FOR_THE_HUB = 'http://station-connector:3000/ilp';

/** What the hub retains for carrying one packet, and what it fronts per broadcaster. */
const EXPECTED_PEERING_FEE = 20n;
const EXPECTED_PEERING_COLLATERAL = 50_000_000n;

/**
 * The refusal a station that is not at the prefix it was granted earns.
 *
 * It is a fact about the CALLER'S OWN NODE, discoverable only by going and
 * looking — which happens inside the paid request — so it is one of the few
 * refusals that cannot be moved to the cheap quote address. The run exercises
 * it rather than avoiding it: a devnet that walked only the happy path would
 * not be evidence about the path a broadcaster actually walks.
 */
const NOT_AT_PREFIX = 'station_not_at_prefix';

/** The chain, as the document a node publishes names it. */
const EXPECTED_SETTLEMENT_CHAIN = `evm:${String(EXPECTED_CHAIN_ID)}`;

describe('the devnet', () => {
  let deployment: SettlementDeployment;
  let credentials: DevnetCredentials;
  /** What each node's settlement key held once funded, before either spent any of it. */
  const funded: Record<string, { gas: bigint; token: bigint }> = {};
  let chain: ChainSettings;
  let hub: SelfDescription;
  let stationAtPlaceholder: SelfDescription;
  let station: SelfDescription;
  /** The station's *now* the moment it first held a segment at every rung. */
  let firstVibes: StationNow;
  /** And where its live edge is by the time a viber goes looking. */
  let liveEdge: StationNow;
  let broadcasterKey: PayerKey;
  let broadcaster: Payer;
  let quote: Quote;
  let refusedAtWrongPrefix: BuyAttempt;
  let bought: BoughtSlot;
  let paidForTheSlot: bigint;
  let carriedRoutes: CarriedRoute[];
  let carriedPeerings: CarriedPeering[];
  let viber: Payer;
  let now: PaidPull;
  const segments: BoughtSegment[] = [];
  let missingSegment: PaidPull;
  let stationClaims: AcceptedClaim[];
  let stationBalanceBefore: bigint;
  let stationBalanceAfter: bigint;
  let redemption: { status: number; body: string };
  let channelAfterRedemption: Awaited<ReturnType<typeof channelOnChain>>;

  /**
   * Every paid pull the viber made across the hop, in the order it made them.
   *
   * The *now*, both segments, and the miss — the miss included, because it
   * crossed the hop and was answered like any other, and a connector fulfils
   * on any complete answer whatever its status.
   */
  const everyPull = (): PaidPull[] => [
    now,
    ...segments.map((segment) => segment.answer),
    missingSegment,
  ];
  /** Set by the first failure, so a red run leaves the logs behind and a green one does not. */
  let failed = false;

  beforeAll(async () => {
    // First, and on its own, because everything after it depends on a daemon
    // and none of it says so when there is not one.
    const version = await requireDockerDaemon();
    console.log(
      `[devnet] docker ${version}, connector pin ${connectorPinOfRecord()}`
    );

    // A previous run that was killed rather than torn down leaves containers
    // and volumes behind, and a chain with somebody else's history on it lands
    // the contracts at different addresses. Start from nothing, always.
    await down();
    await up([CHAIN_SERVICE]);

    deployment = await deploySettlementContracts(CHAIN_RPC_URL);

    // Every credential, fresh, into a directory git ignores — both connectors'
    // signer and settlement keys, both bearer tokens and allowlists, the slot
    // app's operator seed, and the station's stream key. The repository gains
    // no credential literal, anvil's included.
    credentials = generateCredentials();

    // Fund what a run generated. Nothing here has an account, a faucet or any
    // real money behind it: anvil funded account zero, and account zero funds
    // these.
    const clients = await chainClients(CHAIN_RPC_URL);
    for (const [node, settlementAddress] of [
      ['hub', credentials.hub.settlementAddress],
      ['station', credentials.station.settlementAddress],
    ] as const) {
      await fundGas(CHAIN_RPC_URL, settlementAddress, GAS_PER_NODE);
      await mintToken(
        CHAIN_RPC_URL,
        deployment.token,
        settlementAddress,
        TOKEN_PER_NODE
      );
      // Read back HERE, and remembered. Both nodes go on to SPEND from these
      // keys — the hub's gas on opening a channel and its tokens on the
      // collateral it fronts, the station's on redeeming what it was paid — so
      // a balance read at the end of a run is a fact about that spending
      // rather than about the funding. What "funded" claims is that the chain
      // received it, which is what these two readings are.
      funded[node] = {
        gas: await clients.publicClient.getBalance({
          address: settlementAddress,
        }),
        token: await tokenBalance(
          CHAIN_RPC_URL,
          deployment.token,
          settlementAddress
        ),
      };
    }

    // Both configurations, rendered from the committed templates: the chain
    // repointed at the compose service, the addresses this run's replay landed
    // at, six decimals, plaintext peer endpoints allowed, and each node
    // publishing the endpoint its own clients reach it at.
    chain = {
      rpcUrl: CHAIN_URL_ON_THE_COMPOSE_NETWORK,
      registry: deployment.registry,
      token: deployment.token,
      decimals: TOKEN_DECIMALS,
    };
    renderHubConnectorToml(chain, HUB_ADDRESS);
    renderStationConnectorToml(chain, PLACEHOLDER_STATION_APEX);

    await up(NODE_SERVICES);

    hub = await readSelfDescription(`${HUB_EDGE_URL}/ilp`);
    // The station as it is BEFORE the documented order is walked: configured
    // at a placeholder apex its hub never granted it, which is the state every
    // broadcaster's node is in before they pull a quote.
    stationAtPlaceholder = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);

    // The broadcaster's vibes go in before anything is bought: a station with
    // no ingest publishes a ladder it is holding nothing at, and a slot bought
    // for one would be a slot for an address that answers 404.
    await startBroadcasting(credentials.station.streamKey);
    firstVibes = await waitForVibes({
      rungs: LADDER,
      timeoutMs: FIRST_SEGMENT_TIMEOUT_MS,
    });

    // The broadcaster's own payer, and its one channel — with the HUB. That is
    // the whole reason a hub exists: a channel is derived from its two
    // participants, so paying each station directly would be an on-chain
    // transaction, gas and locked capital per broadcaster.
    broadcasterKey = generatePayerKey();
    broadcaster = await openPayer({
      who: 'broadcaster',
      connectorUrl: HUB_EDGE_URL,
      rpcUrl: CHAIN_RPC_URL,
      token: deployment.token,
      key: broadcasterKey,
      funding: BROADCASTER_FUNDING,
    });

    // ── The documented order: quote, configure, restart ─────────────────────
    //
    // `deploy/README.md` tells a broadcaster to pull a quote BEFORE editing
    // their own `connector.toml`, because the prefix they are reachable at is
    // the one the hub grants. Executing that order rather than describing it is
    // what makes the instruction testable.
    quote = await pullQuote(broadcaster);

    // Before the station is reconfigured — a purchase by a broadcaster who
    // bought before they configured. It is refused, it costs them the slot
    // price, and it is the refusal the documented order exists to prevent.
    refusedAtWrongPrefix = await attemptBuy(broadcaster);

    renderStationConnectorToml(chain, quote.prefix);
    await restart('station-connector');
    station = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);

    // And now the purchase that works. The fulfill means peered, funded and
    // routed — all of it inside the request, before the answer.
    const purchase = await attemptBuy(broadcaster);
    if (purchase.status !== 200) {
      throw new Error(
        `the purchase was refused ${String(purchase.status)}: ${JSON.stringify(purchase.body)}`
      );
    }
    bought = purchase.body as BoughtSlot;
    paidForTheSlot = purchase.paid;

    // What the hub's own connector holds, read over its operator surface —
    // never what the answer said it wrote.
    carriedRoutes = await readCarriedRoutes(
      HUB_EDGE_URL,
      credentials.hub.bearerToken
    );
    carriedPeerings = await readCarriedPeerings(
      HUB_EDGE_URL,
      credentials.hub.bearerToken
    );

    // ── A viber ─────────────────────────────────────────────────────────────
    //
    // A different party from the broadcaster, with its own money — and, like
    // the broadcaster's, exactly ONE channel, with the hub.
    viber = await openPayer({
      who: 'viber',
      connectorUrl: HUB_EDGE_URL,
      rpcUrl: CHAIN_RPC_URL,
      token: deployment.token,
      key: generatePayerKey(),
      funding: VIBER_FUNDING,
    });

    // Where the live edge is, from the station's own side, so a run buys a
    // sequence that exists rather than one it hoped for.
    liveEdge = await stationNow();

    // The station's *now*, PAID FOR and across the hop: what a viber pulls to
    // start at the live edge instead of at the beginning.
    // Sealed to the STATION's edge identity: a payload is sealed to the
    // connector that TERMINATES it, and the hub is a hop that cannot open it.
    // No hop may name that key on another node's behalf, which is why it comes
    // off the station's own self-description.
    const sealTo = station.edgeIdentity.publicKey;
    now = await pullThroughTheHub(viber, sealTo, `${quote.prefix}.now`);

    // And the vibes themselves, at two rungs, each at that rung's own price.
    for (const rung of [FIRST_RUNG, SECOND_RUNG]) {
      const sequence = sequenceHeldAt(liveEdge, rung);
      const answer = await pullThroughTheHub(
        viber,
        sealTo,
        `${quote.prefix}.${rung}`,
        `${String(sequence)}.ts`
      );
      segments.push({
        rung,
        sequence,
        answer,
        // What the STATION holds at that address, hashed on the station's own
        // side — the segment port is published on no interface, so there is no
        // other way to have the file and no reason to want one.
        held: await segmentDigest(rung, sequence),
      });
    }

    // A sequence the station does not hold: a paid answer that is not vibes,
    // and says so.
    missingSegment = await pullThroughTheHub(
      viber,
      sealTo,
      `${quote.prefix}.${FIRST_RUNG}`,
      `${String(A_SEQUENCE_THE_STATION_DOES_NOT_HOLD)}.ts`
    );

    // ── The money ───────────────────────────────────────────────────────────
    //
    // What the STATION was paid, read off the broadcaster's own connector.
    stationClaims = await readAcceptedClaims(
      STATION_EDGE_URL,
      credentials.station.bearerToken
    );

    // And then redeemed, on chain, against the channel the hub funded — which
    // is what turns "a counter advanced" into "money moved". The station's
    // balance is read either side of it.
    stationBalanceBefore = await tokenBalance(
      CHAIN_RPC_URL,
      deployment.token,
      credentials.station.settlementAddress
    );
    redemption = await redeemLatestClaim({
      baseUrl: STATION_EDGE_URL,
      writeKey: credentials.station.operatorWriteKey,
      channelId: bought.peering.channel.id,
    });
    stationBalanceAfter = await tokenBalance(
      CHAIN_RPC_URL,
      deployment.token,
      credentials.station.settlementAddress
    );
    channelAfterRedemption = await channelOnChain({
      rpcUrl: CHAIN_RPC_URL,
      tokenNetwork: deployment.tokenNetwork,
      channelId: bought.peering.channel.id as `0x${string}`,
    });
  }, 900_000);

  afterEach((context) => {
    if (context.task.result?.state === 'fail') failed = true;
  });

  afterAll(async () => {
    await broadcaster?.client.close();
    await viber?.client.close();

    // A red CI job has to be diagnosable without re-running it locally, and by
    // the time anybody reads it the containers are gone — so the logs go into
    // the run's own output before anything is torn down.
    if (failed) {
      console.log(
        `[devnet] the run failed; every node's logs follow\n${await logs()}`
      );
      // The uplink is not part of the compose project, so its log is not in
      // that one — and "the station held no vibes" is usually a question about
      // exactly this container.
      console.log(
        `[devnet] the broadcaster's uplink said:\n${await uplinkLogs()}`
      );
    }
    // It is not part of the project either, so `down` does not reap it.
    await stopBroadcasting();
    // Everything, volumes included, so a second run starts from the same place
    // as the first.
    await down();
  }, 600_000);

  // ── The chain ──────────────────────────────────────────────────────────────

  it('comes up on the chain id the fleet settles on', async () => {
    const clients = await chainClients(CHAIN_RPC_URL);

    expect(
      clients.chainId,
      `the devnet chain reports id ${String(clients.chainId)} — every sibling repo's local settlement is configured for ${String(EXPECTED_CHAIN_ID)}, so a different id is a chain nothing else in the fleet can be copied from`
    ).toBe(EXPECTED_CHAIN_ID);
  });

  it('funds its accounts, so nothing needs an account, a faucet or real money', async () => {
    // The whole point of a local chain: anybody who clones this repository can
    // run it. There is no testnet here, no faucet to ask and no key to
    // provision — anvil funds these itself, and every key the nodes use is
    // generated per run and funded from the first of them.
    const clients = await chainClients(CHAIN_RPC_URL);

    for (let index = 0; index < EXPECTED_FUNDED_ACCOUNTS; index += 1) {
      const account = anvilAccount(index);
      expect(
        await clients.publicClient.getBalance({ address: account.address }),
        `account ${String(index)} (${account.address}) holds nothing — the chain was asked for ${String(EXPECTED_FUNDED_ACCOUNTS)} funded accounts, and a devnet that needed a faucet would not be one`
      ).toBeGreaterThan(0n);
    }
  });

  it('mines per transaction, so nothing in a run ever waits on a clock', async () => {
    // The chain runs with NO `--block-time`, and that is two claims rather than
    // one: a clock mines nothing, and a transaction mines itself. Both are
    // checked, because either alone would pass on a chain doing the other — and
    // both are checked against the height before and after a transaction of the
    // run's own, rather than against a count of the ones setup happened to
    // send, which is a number every later slice of this epic changes.
    const clients = await chainClients(CHAIN_RPC_URL);
    const idle = await clients.publicClient.getBlockNumber();

    await new Promise((slept) => setTimeout(slept, IDLE_OBSERVATION_MS));

    expect(
      await clients.publicClient.getBlockNumber(),
      `the devnet chain mined a block while nothing was happening — with a block time, every run's duration becomes a function of a clock rather than of the work it does`
    ).toBe(idle);

    // And one transaction is one block. Zero value to the account that sends
    // it: the cheapest transaction there is, and the run wants nothing from it
    // but the block.
    await fundGas(CHAIN_RPC_URL, anvilAccount(0).address, 0n);

    expect(
      await clients.publicClient.getBlockNumber(),
      `one transaction did not produce exactly one block — a transaction is supposed to wait on itself here`
    ).toBe(idle + 1n);
  });

  it('is answered by the anvil in the digest-pinned image', async () => {
    // The compose file pins the chain by digest and the bundle guard holds
    // that literal still; this is the other half — what actually answered.
    // Some other JSON-RPC would deploy these contracts perfectly well and put
    // them somewhere else, so the run says out loud which one it got.
    const clients = await chainClients(CHAIN_RPC_URL);
    const client = await clients.publicClient.request({
      method: 'web3_clientVersion',
    });

    expect(
      client,
      `the devnet's chain identifies itself as "${String(client)}" — the pinned image is a foundry release, and anvil is what a run's deterministic addresses and per-transaction mining are properties of`
    ).toMatch(/^anvil/i);
  });

  // ── The contracts ──────────────────────────────────────────────────────────

  it('lands the settlement contracts where the rest of the fleet says they land', () => {
    // The connector's own deploy script, replayed with viem from the trimmed
    // artifacts under ./contracts/ — no Foundry, no Rust and no submodules on
    // the machine. Both addresses are a function of account zero and its
    // nonce, so this passes for as long as the replay stays these three
    // transactions in this order.
    expect(
      deployment.token,
      `the mock token landed at ${deployment.token}, and the fleet commits ${EXPECTED_TOKEN}. A configuration copied from a sibling repo would be pointed at an address this chain does not hold — check whether the replay's order changed, or a transaction was inserted ahead of it.`
    ).toBe(EXPECTED_TOKEN);

    expect(
      deployment.registry,
      `the registry landed at ${deployment.registry}, and the fleet commits ${EXPECTED_REGISTRY}. Every connector resolves its token network through this address at boot, and a wrong one is a refuse-to-start rather than a degraded run.`
    ).toBe(EXPECTED_REGISTRY);
  });

  it('creates the token network through the registry, so a connector can resolve it', async () => {
    // What a connector actually does at boot: resolve the token network for
    // its configured token through the registry. A token network that is not
    // there, or is the zero address, is `exit 1` before it serves anything.
    expect(
      BigInt(deployment.tokenNetwork),
      `the registry reports no token network for the mock token`
    ).toBeGreaterThan(0n);

    expect(
      deployment.tokenNetwork,
      `the token network is at the registry's own address, which cannot be right`
    ).not.toBe(deployment.registry);

    expect(deployment.chainId).toBe(EXPECTED_CHAIN_ID);
  });

  it('settles in a token of six decimals, like every price in this repository', async () => {
    // A connector reads the token's own `decimals()` at boot and refuses a
    // mismatch with its configuration. Every price in both bundles is quoted
    // in this token's base units, so a devnet at any other precision would be
    // proving the paid path at prices that mean something else.
    expect(
      await tokenDecimals(CHAIN_RPC_URL, deployment.token),
      `the devnet's token does not report ${String(TOKEN_DECIMALS)} decimals`
    ).toBe(TOKEN_DECIMALS);
  });

  // ── Both nodes, describing themselves ──────────────────────────────────────

  it('generates every credential a run needs, and commits none of them', () => {
    // The repository gains no credential literal — not a signer key, not a
    // settlement key, not a bearer token, not the operator seed, not the
    // station's stream key, and not anvil's own well-known keys either. All of
    // it is fresh material per run, in a directory git ignores, and the bundle
    // guard holds the other half: the compose file mounts exactly these paths
    // and no committed devnet file carries a 64-hex run.
    for (const file of GENERATED_FILES) {
      const path = resolve(WORK_DIR, file);
      expect(existsSync(path), `${file} was not generated`).toBe(true);
      // World-readable, because a bind mount keeps its HOST ownership inside
      // the container and these are read by two images running as two
      // different unprivileged users.
      expect(
        statSync(path).mode & 0o004,
        `${file} is not readable by the container that mounts it`
      ).toBeGreaterThan(0);
    }
  });

  it("derives the operator write key's public half with the app's own ed25519 handling", () => {
    // Nothing shells into another repo's binary to learn a keyid. The driver
    // calls the slot app's own signer, so the allowlist a run writes into the
    // hub's connector is the allowlist that app's signatures are actually
    // verified against — rather than a value learned some other way and hoped
    // to be the same one.
    expect(
      credentials.hub.operatorKeyid,
      `the hub's keyid is "${credentials.hub.operatorKeyid}", which is not the hex public half of an ed25519 key`
    ).toMatch(/^[0-9a-f]{64}$/);

    expect(
      createWriteSigner(credentials.hub.operatorWriteKey).keyid,
      `the allowlist the connector holds does not name the seed the slot app was mounted`
    ).toBe(credentials.hub.operatorKeyid);

    expect(
      readFileSync(resolve(WORK_DIR, 'hub/operator-write.keys'), 'utf8').trim(),
      `the hub connector's allowlist does not hold the slot app's public half — every write the app signs would be refused`
    ).toBe(credentials.hub.operatorKeyid);
  });

  it('funds both settlement keys with gas and the token they will front', () => {
    // A hub fronts collateral toward every broadcaster it admits, and a station
    // has to be able to redeem what it was paid. Neither key existed before
    // this run, so neither had anything behind it — and both balances are read
    // off the chain the moment they are funded, because both nodes go on to
    // spend from them and a reading taken later says nothing about the funding.
    for (const node of ['hub', 'station'] as const) {
      expect(
        funded[node]?.gas,
        `the ${node}'s settlement key received no gas, so it can open no channel and redeem nothing`
      ).toBe(GAS_PER_NODE);

      expect(
        funded[node]?.token,
        `the ${node}'s settlement key received none of the token it settles in`
      ).toBe(TOKEN_PER_NODE);
    }
  });

  it('boots both nodes from configuration nothing under deploy/ supplied', () => {
    // The two shipped bundles' `connector.toml`s are an operator's files,
    // frozen by their own guards and pointed at a public chain. The devnet
    // renders its own from the templates beside it, and reads neither of
    // theirs — in either direction.
    for (const [node, path] of [
      ['hub', HUB_CONNECTOR_TOML],
      ['station', STATION_CONNECTOR_TOML],
    ] as const) {
      const rendered = readFileSync(path, 'utf8');

      expect(
        rendered,
        `the ${node}'s rendered configuration still holds an unfilled placeholder`
      ).not.toMatch(AN_UNFILLED_PLACEHOLDER);
      // The chain repointed at the compose SERVICE, never at the driver's
      // loopback publish: a container reaching its own host's 127.0.0.1
      // reaches itself.
      expect(
        rendered,
        `the ${node} is not pointed at the devnet's own chain`
      ).toContain(`rpc_url = "${CHAIN_URL_ON_THE_COMPOSE_NETWORK}"`);
      expect(
        rendered,
        `the ${node} does not carry this run's replayed registry`
      ).toContain(`contract_address = "${deployment.registry}"`);
      expect(
        rendered,
        `the ${node} does not carry this run's replayed token`
      ).toContain(`token_address = "${deployment.token}"`);
      expect(
        rendered,
        `the ${node} does not settle at ${String(TOKEN_DECIMALS)} decimals`
      ).toContain(`decimals = ${String(TOKEN_DECIMALS)}`);

      // Both nodes are EVM-only. There is no Solana validator in this
      // topology, so a `[settlement.solana]` table would be a node refusing to
      // start on a chain it cannot reach.
      //
      // Read from the DIRECTIVES, because both templates say in their own
      // comments that they carry no such table — a check against the whole
      // file would fail on a configuration that was exactly right.
      expect(
        directivesOf(rendered).includes('[settlement.solana]'),
        `the ${node} declares a Solana settlement, and nothing in this topology answers one`
      ).toBe(false);

      // Plaintext peer endpoints, because there is no certificate anywhere
      // here and the two nodes dial each other by compose service name.
      expect(
        rendered,
        `the ${node} refuses plaintext peer endpoints, and every endpoint in this topology is one`
      ).toContain('peer_allow_plaintext_endpoints = true');
    }
  });

  it('has each node publish the endpoint its own clients reach it at', () => {
    // A node cannot introspect this: from inside a container it sees 0.0.0.0
    // and a private network. It is configuration, and what it has to name is
    // the address the parties who pay THAT node can dial — which is why the two
    // are different here.
    //
    // A hub's payers are a broadcaster and a viber, and in this topology both
    // are the driver, on the host, coming in through the loopback publish; a
    // station's only client is the hub, dialing from inside the compose
    // network. A viber never reaches a station directly, which is exactly what
    // the hub is for.
    expect(
      hub.httpEndpoint,
      `the hub publishes "${hub.httpEndpoint}", which its own payers cannot dial`
    ).toBe('http://127.0.0.1:3000/ilp');
    expect(
      stationAtPlaceholder.httpEndpoint,
      `the station publishes "${stationAtPlaceholder.httpEndpoint}"`
    ).toBe('http://station-connector:3000/ilp');
  });

  it('has each node publish an edge identity, which is what a payload is sealed to', () => {
    // A payload is sealed to the connector that TERMINATES it, so a node with
    // no edge identity can be paid for nothing.
    for (const [name, node] of [
      ['hub', hub],
      ['station', stationAtPlaceholder],
    ] as const) {
      expect(
        node.edgeIdentity.publicKey,
        `the ${name} publishes no edge identity public key`
      ).not.toBe('');
      expect(
        node.edgeIdentity.keyId,
        `the ${name} publishes no edge identity key id`
      ).not.toBe('');
    }
  });

  it('has each node publish exactly one settlement entry, on the local chain', () => {
    // Exactly one, because this topology has one chain and no validator: a
    // second entry would be a node claiming to be a counterparty somewhere
    // nothing in a run can pay it.
    for (const [name, node, settlementAddress] of [
      ['hub', hub, credentials.hub.settlementAddress],
      ['station', stationAtPlaceholder, credentials.station.settlementAddress],
    ] as const) {
      expect(
        node.settlements.length,
        `the ${name} publishes ${String(node.settlements.length)} settlement entries — a devnet node settles on one chain`
      ).toBe(1);

      const settlement = node.settlements[0];
      expect(settlement?.chain).toBe(EXPECTED_SETTLEMENT_CHAIN);
      expect(settlement?.decimals).toBe(TOKEN_DECIMALS);

      // The registry, the token and the token network are this run's replay,
      // and the settlement address is the key the run generated and funded.
      // Compared case-insensitively: a document spells an address however its
      // node serialised it, and what is being asserted is which contract.
      for (const [what, published, expected] of [
        ['its registry', settlement?.tokenNetworkRegistry, deployment.registry],
        ['its token', settlement?.tokenAddress, deployment.token],
        [
          'its token network',
          settlement?.tokenNetwork,
          deployment.tokenNetwork,
        ],
        [
          'its settlement address',
          settlement?.settlementAddress,
          settlementAddress,
        ],
      ] as const) {
        expect(
          String(published).toLowerCase(),
          `the ${name} publishes ${what} as ${String(published)}, and this run's is ${String(expected)}`
        ).toBe(String(expected).toLowerCase());
      }
    }
  });

  it('has the hub publish the two priced routes it terminates and nothing else', () => {
    // A prefix terminated but never advertised is an address no broadcaster
    // can discover — `GET /ilp` is how a stranger who has only heard of this
    // hub finds where to buy. One advertised but not terminated is a paid 404.
    expect(
      pricedAddresses(hub),
      `the hub publishes ${JSON.stringify(hub.routes.map((r) => r.prefix))} — the quote and the buy, each beneath its own prefix and neither reachable at the other's price`
    ).toEqual(byPrefix(EXPECTED_HUB_ROUTES));

    expect(hub.ilpAddresses.slice().sort()).toEqual(
      EXPECTED_HUB_ROUTES.map((route) => route.prefix).sort()
    );
  });

  it('has the station publish its ladder, at the placeholder apex it has not corrected yet', () => {
    // This is the state a broadcaster's node is in before they pull a quote:
    // configured at a prefix their hub never granted them. It is what makes
    // the documented order — quote, configure, restart — something a run can
    // walk rather than describe, and what makes the refusal at the buy
    // something it can exercise.
    expect(
      pricedAddresses(stationAtPlaceholder),
      `the station publishes ${JSON.stringify(stationAtPlaceholder.routes.map((r) => r.prefix))}`
    ).toEqual(
      byPrefix(
        EXPECTED_STATION_ROUTES.map((rung) => ({
          prefix: `${PLACEHOLDER_STATION_APEX}.${rung.rung}`,
          price: rung.price,
        }))
      )
    );

    // Flat per segment, every one of them: a price is a schedule over the
    // INBOUND payload and the vibes are in the fulfill, so a slope on a
    // station route prices asking rather than receiving.
    for (const route of stationAtPlaceholder.routes) {
      expect(
        route.pricePerKib,
        `the station publishes a slope on ${route.prefix} — every station price is flat per segment`
      ).toBe(0n);
    }

    expect(stationAtPlaceholder.ilpAddresses.slice().sort()).toEqual(
      EXPECTED_STATION_ROUTES.map(
        (rung) => `${PLACEHOLDER_STATION_APEX}.${rung.rung}`
      ).sort()
    );
  });

  // ── Vibes, a payer, and the documented order ───────────────────────────────

  it("takes a broadcaster's vibes in, encoded by the origin image's own ffmpeg", () => {
    // A generated test pattern, pushed over RTMP by the ffmpeg inside the
    // station origin's own image — so the devnet introduces no image to encode
    // with, and the origin's own encoders are what cut what a viber will buy.
    expect(
      firstVibes.live,
      `the station's own *now* does not report an open publish, so nothing is being broadcast: ${JSON.stringify(firstVibes)}`
    ).toBe(true);

    expect(
      firstVibes.segmentSeconds,
      `the station cuts ${String(firstVibes.segmentSeconds)}-second segments, and the devnet configures ${String(EXPECTED_SEGMENT_SECONDS)}`
    ).toBe(EXPECTED_SEGMENT_SECONDS);

    for (const rung of LADDER) {
      const held = firstVibes.rungs.find((entry) => entry.rung === rung);
      expect(
        held?.sequence,
        `the station holds no segment at "${rung}" — a slot bought for a ladder holding nothing is a slot for an address that answers 404`
      ).not.toBeNull();
    }
  });

  it("opens and funds the broadcaster's channel toward the hub", async () => {
    // ONE channel, with the hub — which is the whole reason a hub exists. A
    // channel is derived from its two participants, so paying every station
    // directly would mean an on-chain transaction, gas and locked capital per
    // broadcaster.
    const state = await broadcaster.client.channel.state({ onChain: true });

    expect(
      state.depositTotal,
      `the broadcaster's channel holds ${String(state.depositTotal)} on chain, and the run locked ${String(BROADCASTER_FUNDING.deposit)}`
    ).toBe(BROADCASTER_FUNDING.deposit);

    expect(
      state.channelId,
      `the channel the client reports and the channel it opened are not the same`
    ).toBe(broadcaster.channelId);

    // The other participant is the HUB's settlement address — the key this run
    // generated and funded, not the hub's ILP signer, which holds no money.
    expect(
      state.counterparty.toLowerCase(),
      `the broadcaster's channel is against ${state.counterparty}, and the hub settles at ${credentials.hub.settlementAddress}`
    ).toBe(credentials.hub.settlementAddress.toLowerCase());
  });

  it('answers a PAID quote at the hub, and names the prefix it would grant', () => {
    // The cheap address, and the first thing a broadcaster does. It is paid
    // like everything else the hub terminates — the run's channel is what pays
    // for it — and what comes back is the address the hub would grant, which
    // the broadcaster then writes into their own configuration.
    expect(
      quote.paid,
      `the quote cost ${String(quote.paid)} — the hub prices it at ${String(EXPECTED_QUOTE_PRICE)}, and an answer that cost nothing did not come through the connector`
    ).toBe(EXPECTED_QUOTE_PRICE);

    expect(quote.hubAddress).toBe(HUB_ADDRESS);
    expect(quote.slotPrice).toBe(EXPECTED_SLOT_PRICE);
    expect(
      quote.hasCapacity,
      `the hub says it has no capacity, so nothing can be bought on it`
    ).toBe(true);

    // THE HANDLE IS THE HUB'S TO ASSIGN. It is derived from the payer the hub's
    // own connector verified, so it is not a name the broadcaster picked and
    // not one anybody else can take.
    expect(
      quote.prefix,
      `the hub would grant "${quote.prefix}", which is not beneath its own apex`
    ).toBe(`${HUB_ADDRESS}.${quote.label}`);
    expect(
      quote.prefix,
      `the hub would grant the placeholder prefix the station was already configured at, which would make the whole documented order a no-op`
    ).not.toBe(PLACEHOLDER_STATION_APEX);
  });

  it('re-renders the station at the granted prefix and restarts it', () => {
    // The second and third steps of the documented order. A station still
    // saying `demo` publishes nothing beneath the prefix its hub granted, so
    // the hub's forwarded routes and the station's own terminations would name
    // different prefixes and every packet the hub carried would arrive
    // somewhere that connector does not terminate.
    const rendered = readFileSync(STATION_CONNECTOR_TOML, 'utf8');

    expect(
      rendered,
      `the station's configuration was not re-rendered at the prefix the hub granted`
    ).toContain(`"${quote.prefix}.now"`);
    expect(
      rendered.includes(`${PLACEHOLDER_STATION_APEX}.`),
      `the station's configuration still names the placeholder apex it was never granted`
    ).toBe(false);
  });

  it('has the station publish beneath the granted prefix after the restart', () => {
    // Read back off the node itself rather than off the file: the point of the
    // restart is that the running connector now terminates what its
    // configuration says, and this is the document the HUB will read on the
    // purchase.
    expect(
      pricedAddresses(station),
      `after the restart the station publishes ${JSON.stringify(station.routes.map((r) => r.prefix))}, and the hub granted ${quote.prefix}`
    ).toEqual(
      byPrefix(
        EXPECTED_STATION_ROUTES.map((rung) => ({
          prefix: `${quote.prefix}.${rung.rung}`,
          price: rung.price,
        }))
      )
    );

    for (const address of station.ilpAddresses) {
      expect(
        address.startsWith(`${quote.prefix}.`),
        `the station still advertises "${address}", which is not beneath the prefix its hub granted`
      ).toBe(true);
    }
  });

  // ── The buy ────────────────────────────────────────────────────────────────

  it('refuses a purchase against a station that is not at the prefix it was granted', () => {
    // The refusal the documented order exists to prevent, exercised rather
    // than avoided. A station still publishing beneath an apex its hub never
    // granted would be carried at prefixes it does not terminate, so every
    // packet the hub forwarded would arrive somewhere that connector answers
    // nothing — and the hub refuses rather than selling that.
    //
    // It is a fact about the CALLER'S OWN NODE and discoverable only by going
    // and looking, which happens inside the paid request, so it is one of the
    // few refusals that cannot be moved to the cheap quote address. It is
    // named as such rather than disguised as the hub's own failure.
    expect(
      refusedAtWrongPrefix.status,
      `a purchase against a station at the wrong prefix was answered ${String(refusedAtWrongPrefix.status)}: ${JSON.stringify(refusedAtWrongPrefix.body)}`
    ).toBe(502);
    expect(
      (refusedAtWrongPrefix.body as { error?: string }).error,
      `the refusal does not name what is wrong with the caller's node`
    ).toBe(NOT_AT_PREFIX);

    // And it was PAID FOR. A connector fulfils on any complete answer whatever
    // its status, so an app in this repository cannot decline payment by
    // refusing — which is the whole reason every foreseeable refusal lives at
    // the quote instead.
    expect(
      refusedAtWrongPrefix.paid,
      `the refusal cost ${String(refusedAtWrongPrefix.paid)} — a refusal at a paid address is paid for, and a devnet that showed otherwise would be evidence for something untrue`
    ).toBe(EXPECTED_SLOT_PRICE);
  });

  it('sells a slot, and the answer names the prefix, the peering and the routes', () => {
    expect(paidForTheSlot).toBe(EXPECTED_SLOT_PRICE);

    // The prefix is the one the QUOTE named. Same payer, same handle, for
    // ever: it is derived from the payer the hub's own connector verified, so
    // a broadcaster who configured their station against the quote is
    // configured against what they bought.
    expect(
      bought.prefix,
      `the hub granted ${bought.prefix} and quoted ${quote.prefix}`
    ).toBe(quote.prefix);
    expect(bought.label).toBe(quote.label);
    expect(bought.hubAddress).toBe(HUB_ADDRESS);

    // The peering is named for what it is — never for the slot that was
    // bought — and its local label is the handle the hub derived.
    expect(bought.peering.localLabel).toBe(quote.label);
    expect(
      bought.peering.channel.status,
      `a first purchase opens the channel rather than finding one`
    ).toBe('created');
    expect(bought.peering.channel.chain).toContain('evm');

    // One route per address the station publishes, each beneath the granted
    // prefix and nowhere else: the app can never point somebody else's address
    // at a station.
    expect(
      bought.routes.map((route) => route.prefix).sort(),
      `the hub wrote ${JSON.stringify(bought.routes.map((r) => r.prefix))}`
    ).toEqual(station.ilpAddresses.slice().sort());

    for (const route of bought.routes) {
      expect(
        route.prefix.startsWith(`${quote.prefix}.`),
        `the hub wrote a route for ${route.prefix}, which is not beneath the prefix it granted`
      ).toBe(true);
    }
  });

  it("matches the hub's own routing table against what the purchase claimed", async () => {
    // The buy's answer is the slot app's account of what it wrote; this is the
    // connector's account of what it is carrying. Where they disagree, a
    // broadcaster holds a fulfill that promised something nothing will honour.
    const written = carriedRoutes.filter((route) => route.source === 'runtime');

    expect(
      written.map((route) => route.prefix).sort(),
      `the hub's routing table carries ${JSON.stringify(written.map((r) => r.prefix))} at runtime, and the purchase answered ${JSON.stringify(bought.routes.map((r) => r.prefix))}`
    ).toEqual(bought.routes.map((route) => route.prefix).sort());

    for (const route of written) {
      // Every row points at the peering the purchase created, by the label the
      // hub derived — which is the key the connector's own referential rule is
      // on, and therefore what a lapse would have to select by.
      expect(
        route.peerId,
        `the row for ${route.prefix} forwards to "${route.peerId}", and the purchase's peering is "${bought.peering.localLabel}"`
      ).toBe(bought.peering.localLabel);

      const answered = bought.routes.find(
        (candidate) => candidate.prefix === route.prefix
      );
      expect(
        basePriceOf(route),
        `the hub carries ${route.prefix} at ${String(basePriceOf(route))} and its answer said ${String(answered?.price)}`
      ).toBe(BigInt(answered?.price ?? '0'));
    }

    // And the peering itself is there, at runtime, carrying the hub's own fee.
    const peering = carriedPeerings.find(
      (candidate) => candidate.id === bought.peering.localLabel
    );
    expect(
      peering,
      `the hub holds no peering called "${bought.peering.localLabel}", and its own routing table forwards to it`
    ).toBeDefined();
    expect(peering?.source).toBe('runtime');
    expect(
      BigInt(peering?.fee ?? 0),
      `the peering retains ${String(peering?.fee)} per packet, and the hub's policy is ${String(EXPECTED_PEERING_FEE)}`
    ).toBe(EXPECTED_PEERING_FEE);
  });

  it('funds the channel it opened, and the chain says so', async () => {
    // THE ASSERTION THIS WHOLE EPIC EXISTS TO MAKE, and the one that would
    // have caught the defect on the first pull. Establishing a peering OPENS a
    // channel; it does not fund one. A hub that stopped there is peered,
    // routed, on the roster, visible in the quote — and its own connector
    // refuses to sign a covering claim for the first packet it tries to
    // forward, answering T00 about its own internal state rather than about
    // the missing deposit.
    //
    // Asserted on chain rather than in the buy's answer, because the answer is
    // the hub's account of what it did and the chain is what happened.
    const channelId = bought.peering.channel.id as `0x${string}`;

    const state = await channelOnChain({
      rpcUrl: CHAIN_RPC_URL,
      tokenNetwork: deployment.tokenNetwork,
      channelId,
    });
    expect(
      state.state,
      `the channel behind the peering is in state ${String(state.state)} on chain, and a channel that carries a packet is open`
    ).toBe(CHANNEL_OPEN);

    // Both participants are who they should be: the hub's settlement key and
    // the station's. A channel is derived from its two participants, so this is
    // also what makes the id itself checkable.
    const parties = [state.participant1, state.participant2].map((address) =>
      address.toLowerCase()
    );
    expect(parties).toContain(credentials.hub.settlementAddress.toLowerCase());
    expect(parties).toContain(
      credentials.station.settlementAddress.toLowerCase()
    );

    // And the hub's own side holds exactly what its collateral policy says it
    // fronts per broadcaster — the number that makes TOON_SLOT_CAP bound a
    // real commitment rather than an intention.
    const hubSide = await channelParticipant({
      rpcUrl: CHAIN_RPC_URL,
      tokenNetwork: deployment.tokenNetwork,
      channelId,
      participant: credentials.hub.settlementAddress,
    });
    expect(
      hubSide.deposit,
      `the hub's side of the channel holds ${String(hubSide.deposit)} on chain, and its policy fronts ${String(EXPECTED_PEERING_COLLATERAL)} per broadcaster. A channel holding nothing is a station that is peered, routed, on the roster — and cannot carry a packet.`
    ).toBe(EXPECTED_PEERING_COLLATERAL);
  });

  it("prices every route it carries above the station's own termination", () => {
    // THE FEE ARITHMETIC NOTHING IN THE FLEET ENFORCES. A hub collects its
    // route's price at its client edge, retains its flat carriage fee, and
    // forwards the rest; the station's connector checks per packet that a
    // peer-wire arrival covers its OWN termination price. So a hub route
    // priced any lower forwards into an F03 — reachable, paid for, and dead —
    // and no code anywhere checks it, because a connector cannot know what the
    // next hop charges.
    //
    // "At every payload length the run touches" is a finite claim here for a
    // stated reason: every station route publishes a slope of zero, so the
    // station's price is the same at every length, and the hub carries no
    // slope either. Both halves are asserted, because a slope on one side and
    // not the other is exactly how this arithmetic would start being true only
    // for small packets.
    const published = new Map(
      station.routes.map((route) => [route.prefix, route])
    );

    for (const carried of carriedRoutes.filter(
      (route) => route.source === 'runtime'
    )) {
      const stationRoute = published.get(carried.prefix);
      expect(
        stationRoute,
        `the hub carries ${carried.prefix}, and the station publishes no such address`
      ).toBeDefined();

      const hubPrice = basePriceOf(carried) ?? 0n;
      const stationPrice = stationRoute?.price ?? 0n;

      expect(
        hubPrice,
        `the hub carries ${carried.prefix} at ${String(hubPrice)}, and the station terminates it at ${String(stationPrice)} plus the hub's fee of ${String(EXPECTED_PEERING_FEE)}`
      ).toBe(stationPrice + EXPECTED_PEERING_FEE);

      expect(
        hubPrice - EXPECTED_PEERING_FEE >= stationPrice,
        `the hub forwards ${String(hubPrice - EXPECTED_PEERING_FEE)} toward ${carried.prefix}, and the station refuses anything under ${String(stationPrice)}`
      ).toBe(true);

      // No slope on either side, which is what makes the line above a claim
      // about every payload length rather than about one.
      expect(
        slopeOf(carried),
        `the hub carries ${carried.prefix} with a slope — a station price is flat per segment, so a slope on the hop makes the arithmetic above true only up to some size`
      ).toBe(0n);
      expect(stationRoute?.pricePerKib).toBe(0n);
    }
  });

  // ── A viber pays for vibes, through the hub ────────────────────────────────

  it("opens and funds the viber's channel toward the hub", async () => {
    // ONE channel, with the hub, exactly like the broadcaster's — and this is
    // the case the hub exists for. Without it a viber sampling a station they
    // just found would need an on-chain transaction, gas and locked capital
    // with that broadcaster before hearing a second of them.
    const state = await viber.client.channel.state({ onChain: true });

    expect(
      state.depositTotal,
      `the viber's channel holds ${String(state.depositTotal)} on chain`
    ).toBe(VIBER_FUNDING.deposit);
    expect(state.counterparty.toLowerCase()).toBe(
      credentials.hub.settlementAddress.toLowerCase()
    );

    // A DIFFERENT channel from the broadcaster's: two parties, two channels,
    // one hub.
    expect(
      state.channelId,
      `the viber and the broadcaster hold the same channel, which would make them the same party`
    ).not.toBe(broadcaster.channelId);
  });

  it("buys the station's *now* through the hub, at its own cheap price", () => {
    // What a viber pulls to start at the live edge instead of at the
    // beginning — and it is priced apart from the segments on purpose, so
    // re-syncing is never charged a segment's price and no segment is ever
    // reachable at this address's price.
    expect(
      now.status,
      `the *now* answered ${String(now.status)} across the hop: ${now.text.slice(0, 200)}`
    ).toBe(200);

    const nowPrice = priceOf('now');
    expect(
      now.paid,
      `the *now* cost ${String(now.paid)} across the hop, and the station prices it at ${String(nowPrice - EXPECTED_PEERING_FEE)} plus the hub's carriage of ${String(EXPECTED_PEERING_FEE)}`
    ).toBe(nowPrice);

    // And it is the STATION's own report, come back through the hub: the live
    // edge at every rung, with the fixed duration a flat price is a rate over.
    const reported = JSON.parse(now.text) as StationNow;
    expect(reported.live).toBe(true);
    expect(reported.segmentSeconds).toBe(EXPECTED_SEGMENT_SECONDS);
    expect(
      reported.rungs.map((rung) => rung.rung).sort(),
      `the *now* reports ${JSON.stringify(reported.rungs.map((r) => r.rung))}`
    ).toEqual([...LADDER].sort());
  });

  it('buys a segment at one rung and a second at another, each at its own price', () => {
    expect(
      segments.map((segment) => segment.rung),
      `the run bought at ${JSON.stringify(segments.map((s) => s.rung))} — two rungs, because a rung being its own address at its own price is the whole design`
    ).toEqual([FIRST_RUNG, SECOND_RUNG]);

    for (const segment of segments) {
      expect(
        segment.answer.status,
        `the ${segment.rung} segment answered ${String(segment.answer.status)}: ${segment.answer.text.slice(0, 200)}`
      ).toBe(200);

      expect(
        segment.answer.paid,
        `a ${segment.rung} segment cost ${String(segment.answer.paid)} across the hop, and that rung is carried at ${String(priceOf(segment.rung))}`
      ).toBe(priceOf(segment.rung));
    }

    // The dearer rung costs more, which is what makes a budget a control: a
    // viber climbs and drops rungs to stay inside one.
    const [cheap, dear] = segments;
    expect(
      dear?.answer.paid,
      `the ${String(dear?.rung)} rung does not cost more than ${String(cheap?.rung)}, so choosing a rung is not choosing a price`
    ).toBeGreaterThan(cheap?.answer.paid ?? 0n);
  });

  it('returns each segment byte for byte as the station encoded it', () => {
    // Not "a 200 came back". A paid packet that returned an error page, a
    // truncated body or somebody else's rung would all be 200s, and the whole
    // point of the run is that a viber got the vibes they paid for.
    //
    // Compared by digest against what is on the STATION's disk, taken from the
    // station's own side: the segment port is published on no interface, so
    // there is no other way to have the file and no reason to want one.
    for (const segment of segments) {
      expect(
        segment.answer.body.length,
        `the ${segment.rung} segment came back empty`
      ).toBeGreaterThan(0);

      expect(
        createHash('sha256').update(segment.answer.body).digest('hex'),
        `the ${segment.rung} segment at sequence ${String(segment.sequence)} came back as ${String(segment.answer.body.length)} bytes that are not what the station holds at that address`
      ).toBe(segment.held);

      // And it is vibes rather than something that merely matched: an MPEG-TS
      // stream begins with its own sync byte.
      expect(
        segment.answer.body[0],
        `the ${segment.rung} segment does not begin with the MPEG-TS sync byte`
      ).toBe(MPEG_TS_SYNC_BYTE);
    }
  });

  it('carries no rung the station does not offer', async () => {
    // The hub wrote one route per address the station PUBLISHES, so a rung
    // that is not on this station's ladder is an address nothing in the
    // topology carries — and the hub says so by pricing no route for it, which
    // is an answer rather than a failure.
    expect(
      await viber.client.price(
        `${quote.prefix}.${A_RUNG_THE_STATION_DOES_NOT_OFFER}`
      ),
      `the hub prices a route for "${A_RUNG_THE_STATION_DOES_NOT_OFFER}", which this station does not offer — a viber would pay to reach nothing`
    ).toBeNull();

    // While the rungs it does offer are priced, so the check above is about
    // this rung rather than about the lookup.
    expect(
      await viber.client.price(`${quote.prefix}.${FIRST_RUNG}`),
      `the hub prices no route for a rung the station publishes`
    ).toBe(priceOf(FIRST_RUNG));
  });

  it('answers a sequence the station no longer holds as a miss, not as vibes', () => {
    // A viber whose sequence has gone re-syncs from the *now*; one whose RUNG
    // has gone falls back to another. They are told apart by name, which is
    // what makes a player able to do the right one — and neither is silently
    // accepted in place of vibes.
    //
    // It is a PAID answer, like every refusal at a paid address: the connector
    // fulfils on any complete answer whatever its status.
    expect(
      missingSegment.status,
      `a sequence the station does not hold answered ${String(missingSegment.status)}`
    ).toBe(404);
    expect(
      (JSON.parse(missingSegment.text) as { error?: string }).error,
      `the miss does not name itself, so a player cannot tell it from a rung that has gone`
    ).toBe('unknown_segment');
    expect(
      missingSegment.paid,
      `the miss cost ${String(missingSegment.paid)} and the rung is carried at ${String(priceOf(FIRST_RUNG))}`
    ).toBe(priceOf(FIRST_RUNG));

    // And it is not vibes: nothing in that body could be played.
    expect(
      missingSegment.body[0],
      `a segment the station does not hold came back beginning like an MPEG-TS stream`
    ).not.toBe(MPEG_TS_SYNC_BYTE);
  });

  // ── The money ──────────────────────────────────────────────────────────────

  it("advances the station's claim by exactly its own price, per pull", () => {
    // "The broadcaster was paid" has to mean something other than a counter
    // somewhere. It means this: the claim the STATION holds against the hub's
    // channel has advanced by exactly what the station charges, once per thing
    // the viber pulled — including the miss, because a connector fulfils on any
    // complete answer whatever its status, and a 404 is an answer.
    const inbound = stationClaims.filter(
      (claim) =>
        claim.direction === INBOUND &&
        claim.channelId.toLowerCase() ===
          bought.peering.channel.id.toLowerCase()
    );

    expect(
      inbound.length,
      `the station holds ${String(inbound.length)} inbound claims on the channel the hub funded: ${JSON.stringify(stationClaims)}`
    ).toBe(1);

    // A claim is CUMULATIVE, so this is everything that channel has carried —
    // which here is the whole of what the viber pulled and nothing else, since
    // the broadcaster's own quote and buy terminated at the hub and never
    // crossed this hop.
    const received = inbound[0]?.cumulativeAmount ?? 0n;
    const owed = everyPull().reduce(
      (total, pull) => total + pull.paid - EXPECTED_PEERING_FEE,
      0n
    );

    expect(
      received,
      `the station's claim stands at ${String(received)}, and the ${String(everyPull().length)} pulls that crossed the hop are worth ${String(owed)} at its own prices`
    ).toBe(owed);

    // Stated the other way round, as the sum of the station's OWN published
    // prices, so the figure is not merely the hub's arithmetic restated.
    expect(
      received,
      `the station's own prices for what the viber pulled do not add up to what it was paid`
    ).toBe(
      priceOf('now') -
        EXPECTED_PEERING_FEE +
        (priceOf(FIRST_RUNG) - EXPECTED_PEERING_FEE) * 2n +
        (priceOf(SECOND_RUNG) - EXPECTED_PEERING_FEE)
    );
  });

  it('leaves the hub exactly its carriage fee, per packet and no more', () => {
    // THE FEE ARITHMETIC NOBODY'S CODE CHECKS, checked against money that
    // actually moved rather than against two configured numbers. A hub is paid
    // for carrying — never by holding anyone's money — and this is the whole
    // of what it earned on this station: one flat fee per packet, the same
    // figure whichever prefix it carried.
    const paidByTheViber = everyPull().reduce(
      (total, pull) => total + pull.paid,
      0n
    );
    const received =
      stationClaims.find(
        (claim) =>
          claim.direction === INBOUND &&
          claim.channelId.toLowerCase() ===
            bought.peering.channel.id.toLowerCase()
      )?.cumulativeAmount ?? 0n;

    expect(
      paidByTheViber - received,
      `the viber paid ${String(paidByTheViber)}, the station was paid ${String(received)}, and the difference is what the hub retained for ${String(everyPull().length)} packets at a fee of ${String(EXPECTED_PEERING_FEE)}`
    ).toBe(EXPECTED_PEERING_FEE * BigInt(everyPull().length));
  });

  it('redeems the station on chain, against a channel that stays open', async () => {
    // A counter advancing is not money moving. This is the redemption — the
    // connector's own `redeem-latest`, signed by the broadcaster with the seed
    // that matches the only line in their own node's allowlist, because on a
    // station the private half does not live on the box at all.
    expect(
      redemption.status,
      `the station's own connector answered ${String(redemption.status)} to a signed redemption: ${redemption.body}`
    ).toBe(200);

    const received =
      stationClaims.find(
        (claim) =>
          claim.direction === INBOUND &&
          claim.channelId.toLowerCase() ===
            bought.peering.channel.id.toLowerCase()
      )?.cumulativeAmount ?? 0n;

    expect(
      stationBalanceAfter - stationBalanceBefore,
      `the broadcaster's settlement address went from ${String(stationBalanceBefore)} to ${String(stationBalanceAfter)}, and its claim stood at ${String(received)}. This is the difference between a counter having advanced and the broadcaster having been paid.`
    ).toBe(received);

    // NO TIME TRAVEL WAS NEEDED. Redemption does not require a closed channel,
    // so the money moved while the station stayed reachable — which is what a
    // broadcaster actually wants, and what a run that had to close a channel
    // to prove this could not have shown.
    expect(
      channelAfterRedemption.state,
      `the channel is in state ${String(channelAfterRedemption.state)} after the redemption, and it is supposed to still be open`
    ).toBe(CHANNEL_OPEN);

    // And what the hub fronted is still behind it, less what has been drawn
    // down — the collateral is a commitment, not a payment.
    const hubSide = await channelParticipant({
      rpcUrl: CHAIN_RPC_URL,
      tokenNetwork: deployment.tokenNetwork,
      channelId: bought.peering.channel.id as `0x${string}`,
      participant: credentials.hub.settlementAddress,
    });
    expect(
      hubSide.deposit,
      `the hub's deposit changed when the station redeemed, and a redemption draws against collateral rather than returning it`
    ).toBe(EXPECTED_PEERING_COLLATERAL);
  });
});

/**
 * The priced addresses a node publishes, BY PREFIX.
 *
 * A connector serialises its routes in its own order — sorted by prefix, not
 * in the order the configuration lists them — and that is its business rather
 * than a fact worth freezing here. What a run is entitled to assert is the SET
 * of addresses and what each costs, which is what the hub reads to price its
 * own routes and what a viber pays.
 */
function byPrefix(
  routes: readonly { prefix: string; price: bigint }[]
): { prefix: string; price: bigint }[] {
  return [...routes]
    .map((route) => ({ prefix: route.prefix, price: route.price }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function pricedAddresses(
  node: SelfDescription
): { prefix: string; price: bigint }[] {
  return byPrefix(node.routes);
}

/**
 * A rendered configuration with its comments removed.
 *
 * Both templates explain at length what they must NOT contain — no second
 * settlement chain, no committed address — so a check for a forbidden string
 * has to read what the file does rather than what it says about itself.
 */
function directivesOf(toml: string): string {
  return toml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** What a hub answers at its cheap address, plus what the answer cost. */
interface Quote {
  prefix: string;
  label: string;
  hubAddress: string;
  slotPrice: bigint;
  slotPeriodSeconds: number;
  hasCapacity: boolean;
  /** What the connector actually charged for it — read off the claim, not asserted into it. */
  paid: bigint;
}

/**
 * Pull a paid quote through the hub.
 *
 * This is the first thing a broadcaster does and the first paid packet in a
 * run. The destination is the hub's own quote prefix; nothing is sealed to
 * anybody else, because the hub TERMINATES this address rather than forwarding
 * it.
 */
async function pullQuote(payer: Payer): Promise<Quote> {
  const answer = await payer.client.send(`${HUB_ADDRESS}.slot.quote`, {
    method: 'GET',
  });

  if (!answer.fulfilled) {
    throw new Error(
      `the hub refused a paid quote: ${answer.code} ${answer.message}`
    );
  }
  if (answer.status !== 200) {
    throw new Error(
      `the hub's quote answered ${String(answer.status)}: ${answer.text()}`
    );
  }

  const body = answer.json<{
    prefix: string;
    label: string;
    hubAddress: string;
    slotPrice: number;
    slotPeriodSeconds: number;
    hasCapacity: boolean;
  }>();

  return {
    prefix: body.prefix,
    label: body.label,
    hubAddress: body.hubAddress,
    slotPrice: BigInt(body.slotPrice),
    slotPeriodSeconds: body.slotPeriodSeconds,
    hasCapacity: body.hasCapacity,
    paid: answer.claim?.amount ?? 0n,
  };
}

/** A purchase's answer, whatever it was, and what the connector charged for it. */
interface BuyAttempt {
  status: number;
  body: unknown;
  paid: bigint;
}

/** The slot a broadcaster reads back once they are peered. */
interface BoughtSlot {
  prefix: string;
  label: string;
  hubAddress: string;
  lapsesAt: number;
  slotPeriodSeconds: number;
  peering: {
    localLabel: string;
    channel: { id: string; status: string; chain: string };
  };
  routes: { prefix: string; price: string; pricePerKib?: string }[];
}

/**
 * Buy a slot, naming the station's own self-description URL.
 *
 * The body carries exactly one thing and everything else is derived — the
 * handle from the payer the hub's connector verified, the prices from the
 * station's own document, the carriage terms from the hub's configuration.
 *
 * It never throws on a refusal: a refusal IS the answer, it is paid for like
 * any other, and one of them is a thing this run is here to see.
 */
async function attemptBuy(payer: Payer): Promise<BuyAttempt> {
  const answer = await payer.client.send(`${HUB_ADDRESS}.slot.buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { stationUrl: STATION_URL_FOR_THE_HUB },
  });

  if (!answer.fulfilled) {
    throw new Error(
      `the hub never answered a purchase at all: ${answer.code} ${answer.message}. That is a packet that did not become an answer, which is a different thing from a refusal.`
    );
  }

  return {
    status: answer.status,
    body: answer.json<unknown>(),
    paid: answer.claim?.amount ?? 0n,
  };
}

/** One paid answer that crossed the hop. */
interface PaidPull {
  status: number;
  body: Uint8Array;
  text: string;
  /** What the connector charged — read off the claim, never asserted into it. */
  paid: bigint;
}

/** One segment a viber bought, and what the station holds at that address. */
interface BoughtSegment {
  rung: string;
  sequence: number;
  answer: PaidPull;
  /** The SHA-256 of the file on the station's own disk. */
  held: string;
}

/**
 * Pay for one request that crosses the hub to the station.
 *
 * Two things make this different from paying the hub itself. The destination
 * is a prefix the hub FORWARDS rather than terminates, so the payload is
 * sealed to the connector that terminates it — `sealTo` is the station's own
 * edge identity, taken off its own self-description, because no hop may name
 * that key on another node's behalf. And the amount is whatever the hub prices
 * the forwarded route at, which the client reads from the hub itself: a run
 * that supplied the figure would be asserting its own arithmetic rather than
 * the hub's.
 */
async function pullThroughTheHub(
  payer: Payer,
  sealTo: string,
  destination: string,
  target?: string
): Promise<PaidPull> {
  const answer = await payer.client.send(
    destination,
    { method: 'GET', ...(target === undefined ? {} : { target }) },
    { sealTo }
  );

  if (!answer.fulfilled) {
    throw new Error(
      `${destination} was refused by ${answer.refusedBy}: ${answer.code} ${answer.message}`
    );
  }

  return {
    status: answer.status,
    body: answer.body,
    text: answer.text(),
    paid: answer.claim?.amount ?? 0n,
  };
}

/** What the hub charges a viber to cross the hop to one of the station's addresses. */
function priceOf(label: string): bigint {
  const rung = EXPECTED_STATION_ROUTES.find(
    (candidate) => candidate.rung === label
  );
  if (rung === undefined) {
    throw new Error(`the devnet's station has no address called "${label}"`);
  }
  return rung.price + EXPECTED_PEERING_FEE;
}

/** The newest sequence the station holds at one rung, from its own *now*. */
function sequenceHeldAt(edge: StationNow, rung: string): number {
  const held = edge.rungs.find((candidate) => candidate.rung === rung);
  if (held?.sequence === null || held?.sequence === undefined) {
    throw new Error(
      `the station holds nothing at rung "${rung}": ${JSON.stringify(edge)}`
    );
  }
  return held.sequence;
}
