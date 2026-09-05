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
  up,
  connectorPinOfRecord,
} from './compose.js';

/** The chain's own RPC, on loopback. Nothing in this topology is reachable off-box. */
const CHAIN_RPC_URL = 'http://127.0.0.1:8545';

/** The chain the whole fleet's local settlement runs on. */
const EXPECTED_CHAIN_ID = 31337;

/** How many accounts anvil funds, and therefore how many the deployer is one of. */
const EXPECTED_FUNDED_ACCOUNTS = 10;

/**
 * How many transactions the replay sends: the mock token, the registry, and
 * the `createTokenNetwork` call. One block each, because the chain has NO
 * block time — which is what makes the height an assertion rather than a race.
 */
const REPLAY_TRANSACTIONS = 3;

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

/** The chain, as the document a node publishes names it. */
const EXPECTED_SETTLEMENT_CHAIN = `evm:${String(EXPECTED_CHAIN_ID)}`;

describe('the devnet', () => {
  let deployment: SettlementDeployment;
  let credentials: DevnetCredentials;
  let chain: ChainSettings;
  let hub: SelfDescription;
  let station: SelfDescription;
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
    // at, six decimals, plaintext peer endpoints allowed, and each node's own
    // endpoint named at its compose service.
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
    station = await readSelfDescription(`${STATION_EDGE_URL}/ilp`);
  }, 900_000);

  afterEach((context) => {
    if (context.task.result?.state === 'fail') failed = true;
  });

  afterAll(async () => {
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
    // The chain runs with no `--block-time`, which means a transaction waits on
    // ITSELF. Asserted rather than trusted: with one block per transaction and
    // nothing else touching this chain, the height after the replay IS the
    // number of transactions the replay sent.
    const clients = await chainClients(CHAIN_RPC_URL);

    expect(
      await clients.publicClient.getBlockNumber(),
      `the devnet chain is ${String(await clients.publicClient.getBlockNumber())} blocks in after ${String(REPLAY_TRANSACTIONS)} transactions — one block per transaction is what "no block time" means, and a mining interval would make every run's duration a function of a clock`
    ).toBe(BigInt(REPLAY_TRANSACTIONS));
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
      ).not.toMatch(/\{\{/);
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
      expect(
        rendered.includes('[settlement.solana]'),
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

  it('has each node publish an endpoint at its own compose service', () => {
    // A node cannot introspect this: from inside a container it sees 0.0.0.0
    // and a private network, never the name the other half of the topology
    // dials it by. It is configuration, and a node that published the wrong
    // one is a node the hub peers with and cannot reach.
    expect(hub.httpEndpoint, `the hub publishes "${hub.httpEndpoint}"`).toBe(
      'http://hub-connector:3000/ilp'
    );
    expect(
      station.httpEndpoint,
      `the station publishes "${station.httpEndpoint}"`
    ).toBe('http://station-connector:3000/ilp');
  });

  it('has each node publish an edge identity, which is what a payload is sealed to', () => {
    // A payload is sealed to the connector that TERMINATES it, so a node with
    // no edge identity can be paid for nothing.
    for (const [name, node] of [
      ['hub', hub],
      ['station', station],
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
      ['station', station, credentials.station.settlementAddress],
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
      hub.routes.map((route) => ({ prefix: route.prefix, price: route.price })),
      `the hub publishes ${JSON.stringify(hub.routes.map((r) => r.prefix))} — the quote and the buy, each beneath its own prefix and neither reachable at the other's price`
    ).toEqual(EXPECTED_HUB_ROUTES);

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
      station.routes.map((route) => ({
        prefix: route.prefix,
        price: route.price,
      })),
      `the station publishes ${JSON.stringify(station.routes.map((r) => r.prefix))}`
    ).toEqual(
      EXPECTED_STATION_ROUTES.map((rung) => ({
        prefix: `${PLACEHOLDER_STATION_APEX}.${rung.rung}`,
        price: rung.price,
      }))
    );

    // Flat per segment, every one of them: a price is a schedule over the
    // INBOUND payload and the vibes are in the fulfill, so a slope on a
    // station route prices asking rather than receiving.
    for (const route of station.routes) {
      expect(
        route.pricePerKib,
        `the station publishes a slope on ${route.prefix} — every station price is flat per segment`
      ).toBe(0n);
    }

    expect(station.ilpAddresses.slice().sort()).toEqual(
      EXPECTED_STATION_ROUTES.map(
        (rung) => `${PLACEHOLDER_STATION_APEX}.${rung.rung}`
      ).sort()
    );
  });
});
