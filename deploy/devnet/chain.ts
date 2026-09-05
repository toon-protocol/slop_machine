/**
 * The devnet's chain: the settlement contracts, replayed onto a fresh anvil.
 *
 * The connector's own deploy script, reproduced with `viem` from the trimmed
 * artifacts in `./contracts/` — the mock token at six decimals, the token
 * network registry, and a token network created through it, in that order and
 * from anvil's account zero. It runs in the driver's own process, so it adds
 * no service, no image and no published port to the topology; and it needs no
 * Foundry, no Rust and no submodules on the machine, which is what makes
 * Docker and this repository's own toolchain the whole prerequisite.
 *
 * Nothing here asserts. The addresses this returns are what the rest of a run
 * uses, and `devnet.test.ts` holds the deterministic ones as literals and
 * compares them — a replay that drifts is then a loud failure naming both,
 * rather than a chain that is silently not the fleet's.
 *
 * ## Anvil's own keys are not credentials, and they are still not committed
 *
 * The chain's default mnemonic funds account zero, and account zero is the
 * only thing that has any money before this module runs. It reaches this
 * process by being DERIVED from that published mnemonic, not by being written
 * down: `no credential literal enters this repository` is a rule about what a
 * reader finds when they grep, and a well-known key is exactly the literal
 * that teaches them the rule has exceptions. Every key the nodes themselves
 * use is fresh material generated per run and funded from here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';

const CONTRACTS_DIR = resolve(import.meta.dirname, 'contracts');

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function artifact(name: string): Artifact {
  const raw = JSON.parse(
    readFileSync(resolve(CONTRACTS_DIR, `${name}.json`), 'utf8')
  ) as { abi: Abi; bytecode: string };
  return { abi: raw.abi, bytecode: raw.bytecode as Hex };
}

/** The mock USD Coin a devnet settles in. Its `mint` is ungated, which is what lets a run fund a viber. */
export const MOCK_ERC20 = artifact('MockERC20');
/** The registry every connector resolves its token network through at boot. */
export const TOKEN_NETWORK_REGISTRY = artifact('TokenNetworkRegistry');

/**
 * Anvil's published test mnemonic, and account zero derived from it.
 *
 * Deliberately the mnemonic rather than the private key: this is the string
 * anvil prints on every start and every reader already knows, and deriving
 * from it keeps the repository free of anything that LOOKS like a key. It
 * holds nothing but this chain's play money and exists for two jobs — deploy
 * the contracts, and fund the fresh keys the nodes actually use.
 */
const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';

export function anvilDeployer(): HDAccount {
  return anvilAccount(0);
}

/**
 * One of the chain's funded accounts, by index.
 *
 * Only account zero is ever used to send a transaction — the deploy, and the
 * gas and tokens the nodes' own fresh keys are funded with. The rest exist so
 * that "ten funded accounts" is something a run can check rather than assume.
 */
export function anvilAccount(index: number): HDAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

/** The token's decimals. Six, like the USDC every price in this repository is quoted in. */
export const TOKEN_DECIMALS = 6;
const TOKEN_NAME = 'USD Coin';
const TOKEN_SYMBOL = 'USDC';

/** What a devnet run needs to know about the chain it is settling on. */
export interface ChainClients {
  rpcUrl: string;
  chainId: number;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: HDAccount;
}

function chainFor(rpcUrl: string, chainId: number): Chain {
  return {
    id: chainId,
    name: `devnet-${String(chainId)}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/** Clients for a chain that is already answering — compose's healthcheck is what waits. */
export async function chainClients(rpcUrl: string): Promise<ChainClients> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain = chainFor(rpcUrl, chainId);
  const deployer = anvilDeployer();

  return {
    rpcUrl,
    chainId,
    // `cacheTime: 0`, deliberately. viem caches a block number for its polling
    // interval by default, which is exactly right for an app watching a public
    // chain and exactly wrong for a driver that sends a transaction and then
    // asks what happened: the answer would be the height from before it, and
    // the assertion would be about a cache rather than about the chain.
    publicClient: createPublicClient({
      chain,
      transport: http(rpcUrl),
      cacheTime: 0,
    }),
    walletClient: createWalletClient({
      chain,
      account: deployer,
      transport: http(rpcUrl),
    }),
    deployer,
  };
}

/** Where the settlement contracts landed on this run's chain. */
export interface SettlementDeployment {
  chainId: number;
  /** The mock USDC, at six decimals. Every price in this repository is in its base units. */
  token: Address;
  /** The registry a connector resolves the token network through at boot. */
  registry: Address;
  /** The token network the channels are opened on. */
  tokenNetwork: Address;
}

/**
 * Wait for one transaction, and return the address it created, CHECKSUMMED.
 *
 * A receipt reports an address in lower case; the fleet writes its addresses in
 * EIP-55 mixed case, which is what every `connector.toml` in every sibling repo
 * carries, and therefore what a devnet compares itself against and renders into
 * its own generated configuration. Normalising here means one form reaches
 * everything downstream, rather than a comparison that turns out to be about
 * casing.
 */
async function waitFor(
  clients: ChainClients,
  hash: Hex,
  what: string
): Promise<Address | undefined> {
  const receipt = await clients.publicClient.waitForTransactionReceipt({
    hash,
  });
  if (receipt.status !== 'success') {
    throw new Error(`${what} reverted on the devnet chain (${hash})`);
  }
  return receipt.contractAddress === null ||
    receipt.contractAddress === undefined
    ? undefined
    : getAddress(receipt.contractAddress);
}

/**
 * Replay the connector's deploy script: the mock token, the registry, and a
 * token network created through it.
 *
 * The ORDER is the whole point. Each of these is a `CREATE` from account zero,
 * so the address of each is a function of that account and its nonce — which
 * is why the same three transactions in the same order land at the same
 * addresses every sibling repo commits, and why a fourth transaction inserted
 * ahead of them would silently move all three.
 */
export async function deploySettlementContracts(
  rpcUrl: string
): Promise<SettlementDeployment> {
  const clients = await chainClients(rpcUrl);

  const token = await waitFor(
    clients,
    await clients.walletClient.deployContract({
      abi: MOCK_ERC20.abi,
      bytecode: MOCK_ERC20.bytecode,
      args: [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS],
      account: clients.deployer,
      chain: clients.walletClient.chain,
    }),
    'the mock token deployment'
  );
  if (token === undefined) {
    throw new Error('the mock token deployment produced no contract address');
  }

  const registry = await waitFor(
    clients,
    await clients.walletClient.deployContract({
      abi: TOKEN_NETWORK_REGISTRY.abi,
      bytecode: TOKEN_NETWORK_REGISTRY.bytecode,
      args: [],
      account: clients.deployer,
      chain: clients.walletClient.chain,
    }),
    'the registry deployment'
  );
  if (registry === undefined) {
    throw new Error('the registry deployment produced no contract address');
  }

  await waitFor(
    clients,
    await clients.walletClient.writeContract({
      address: registry,
      abi: TOKEN_NETWORK_REGISTRY.abi,
      functionName: 'createTokenNetwork',
      args: [token],
      account: clients.deployer,
      chain: clients.walletClient.chain,
    }),
    'createTokenNetwork'
  );

  const tokenNetwork = getAddress(
    (await clients.publicClient.readContract({
      address: registry,
      abi: TOKEN_NETWORK_REGISTRY.abi,
      functionName: 'getTokenNetwork',
      args: [token],
    })) as Address
  );

  if (BigInt(tokenNetwork) === 0n) {
    throw new Error(
      `the registry at ${registry} reports no token network for ${token} after createTokenNetwork — a connector booting against this chain would fail to resolve its own settlement`
    );
  }

  return { chainId: clients.chainId, token, registry, tokenNetwork };
}

/** What the token reports about itself. A connector reads this at boot and refuses a mismatch. */
export async function tokenDecimals(
  rpcUrl: string,
  token: Address
): Promise<number> {
  const clients = await chainClients(rpcUrl);
  return Number(
    await clients.publicClient.readContract({
      address: token,
      abi: MOCK_ERC20.abi,
      functionName: 'decimals',
    })
  );
}

/**
 * Send gas to an address the run generated.
 *
 * Every key both nodes use is fresh material with nothing behind it, so each
 * has to be funded before it can do anything on chain — opening a channel,
 * funding one, or redeeming a claim. This is where a devnet's "no account, no
 * faucet, no real money" actually happens: anvil funded account zero, and
 * account zero funds these.
 */
export async function fundGas(
  rpcUrl: string,
  to: Address,
  wei: bigint
): Promise<void> {
  const clients = await chainClients(rpcUrl);
  const hash = await clients.walletClient.sendTransaction({
    to,
    value: wei,
    account: clients.deployer,
    chain: clients.walletClient.chain,
  });
  await waitFor(clients, hash, `funding ${to} with gas`);
}

/**
 * Mint the settlement token to an address.
 *
 * The mock token's `mint` is deliberately ungated, and that is exactly why the
 * devnet deploys it rather than rehydrating a state snapshot: a hub has to
 * hold the collateral it fronts per broadcaster, and a viber has to hold what
 * they are about to spend.
 */
export async function mintToken(
  rpcUrl: string,
  token: Address,
  to: Address,
  amount: bigint
): Promise<void> {
  const clients = await chainClients(rpcUrl);
  const hash = await clients.walletClient.writeContract({
    address: token,
    abi: MOCK_ERC20.abi,
    functionName: 'mint',
    args: [to, amount],
    account: clients.deployer,
    chain: clients.walletClient.chain,
  });
  await waitFor(clients, hash, `minting ${String(amount)} to ${to}`);
}

/** What an address holds of the settlement token, in base units. */
export async function tokenBalance(
  rpcUrl: string,
  token: Address,
  owner: Address
): Promise<bigint> {
  const clients = await chainClients(rpcUrl);
  return (await clients.publicClient.readContract({
    address: token,
    abi: MOCK_ERC20.abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}
