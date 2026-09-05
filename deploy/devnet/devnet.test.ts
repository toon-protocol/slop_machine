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
import type { Address } from 'viem';
import {
  anvilAccount,
  chainClients,
  deploySettlementContracts,
  tokenDecimals,
  TOKEN_DECIMALS,
  type SettlementDeployment,
} from './chain.js';
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

describe('the devnet', () => {
  let deployment: SettlementDeployment;
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
  }, 600_000);

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
});
