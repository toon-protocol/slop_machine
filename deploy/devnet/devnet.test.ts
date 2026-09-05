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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import { createWriteSigner } from '../../packages/slot-app/src/operator/write-signature.js';
import {
  anvilAccount,
  chainClients,
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
import { startBroadcasting, waitForVibes } from './vibes.js';

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

/** The chain, as the document a node publishes names it. */
const EXPECTED_SETTLEMENT_CHAIN = `evm:${String(EXPECTED_CHAIN_ID)}`;

describe('the devnet', () => {
  let deployment: SettlementDeployment;
  let credentials: DevnetCredentials;
  let chain: ChainSettings;
  let hub: SelfDescription;
  let stationAtPlaceholder: SelfDescription;
  let station: SelfDescription;
  let liveEdge: Awaited<ReturnType<typeof waitForVibes>>;
  let broadcasterKey: PayerKey;
  let broadcaster: Payer;
  let quote: Quote;
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
    liveEdge = await waitForVibes({
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
    renderStationConnectorToml(chain, quote.prefix);
    await restart('station-connector');
    station = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);
  }, 900_000);

  afterEach((context) => {
    if (context.task.result?.state === 'fail') failed = true;
  });

  afterAll(async () => {
    await broadcaster?.client.close();

    // A red CI job has to be diagnosable without re-running it locally, and by
    // the time anybody reads it the containers are gone — so the logs go into
    // the run's own output before anything is torn down.
    if (failed) {
      console.log(
        `[devnet] the run failed; every node's logs follow\n${await logs()}`
      );
    }
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

  it('funds both settlement keys with gas and the token they will front', async () => {
    // A hub fronts collateral toward every broadcaster it admits, and a
    // station has to be able to redeem what it was paid. Neither key existed
    // before this run, so neither had anything behind it.
    const clients = await chainClients(CHAIN_RPC_URL);

    for (const [node, settlementAddress] of [
      ['hub', credentials.hub.settlementAddress],
      ['station', credentials.station.settlementAddress],
    ] as const) {
      expect(
        await clients.publicClient.getBalance({ address: settlementAddress }),
        `the ${node}'s settlement key ${settlementAddress} holds no gas, so it can open no channel and redeem nothing`
      ).toBe(GAS_PER_NODE);

      expect(
        await tokenBalance(CHAIN_RPC_URL, deployment.token, settlementAddress),
        `the ${node}'s settlement key holds none of the token it settles in`
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
      liveEdge.live,
      `the station's own *now* does not report an open publish, so nothing is being broadcast: ${JSON.stringify(liveEdge)}`
    ).toBe(true);

    expect(
      liveEdge.segmentSeconds,
      `the station cuts ${String(liveEdge.segmentSeconds)}-second segments, and the devnet configures ${String(EXPECTED_SEGMENT_SECONDS)}`
    ).toBe(EXPECTED_SEGMENT_SECONDS);

    for (const rung of LADDER) {
      const held = liveEdge.rungs.find((entry) => entry.rung === rung);
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
