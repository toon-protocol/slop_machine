/**
 * The payer — `toon-client`, the fleet's own client side.
 *
 * **Neither app in this repository may hold payment code**, and that invariant
 * is what makes a devnet need a payer from outside it. The connector's own
 * `send` verb cannot stand in: it originates through a node's operator surface
 * and bypasses the claim gate entirely, so a run built on it would prove that
 * the hub can talk to the station rather than that a stranger can pay for
 * vibes. The fleet's real payer is the right thing to point at the fleet's
 * real path.
 *
 * It is a **development dependency of the devnet only**, pinned to an exact
 * release: a dependency of neither package, in no published image, and
 * imported by nothing under `packages/`. `bundle.test.ts` holds all three
 * still. The invariant is unchanged — no app in this repo contains payment
 * code, and the devnet is not an app.
 *
 * ## What a payer is, here
 *
 * Two of them appear across a run, and they are different parties with
 * different money:
 *
 * - the **broadcaster**, who pays the hub for a quote and then for a slot;
 * - the **viber**, who pays the hub for a broadcaster's vibes and whose
 *   packets cross the hop.
 *
 * Both hold exactly ONE channel — with the hub — which is the whole reason a
 * hub exists: a channel is derived from its two participants, so paying a
 * station you just found would otherwise mean an on-chain transaction, gas and
 * locked capital per broadcaster.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ToonClient } from '@toon-protocol/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { fundGas, mintToken } from './chain.js';
import { WORK_DIR } from './credentials.js';

/** One party's key, generated per run like everything else a devnet holds. */
export interface PayerKey {
  privateKey: Hex;
  address: Address;
}

/** A fresh EVM key. No literal, not even a well-known one — see `chain.ts`. */
export function generatePayerKey(): PayerKey {
  const privateKey = `0x${randomBytes(32).toString('hex')}` as Hex;
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** What a payer is given before it can pay for anything. */
export interface PayerFunding {
  /** Gas, for the transactions that open and fund the channel. Requests cost none. */
  gas: bigint;
  /** The settlement token — what the channel is collateralized with and what requests are paid in. */
  token: bigint;
  /** What is locked into the channel. Every request after that is a signature, not a transaction. */
  deposit: bigint;
}

export interface OpenPayerOptions {
  /** A name for this party, used in the log line and in its own channel store. */
  who: string;
  /**
   * The connector's client edge, as this payer reaches it — a loopback
   * publish, or in an `--anyone` run the hub's own `.anyone` address.
   */
  connectorUrl: string;
  /** The chain, as the driver reaches it. */
  rpcUrl: string;
  /** The settlement token, so this party can be minted some of it. */
  token: Address;
  key: PayerKey;
  funding: PayerFunding;
  /**
   * The `socks5h://` proxy a `.anyone` connector is reached through — a
   * running anon daemon's SOCKS port. Required by the client for any
   * hidden-service connector and refused beside a clearnet one, so it is set
   * exactly when `connectorUrl` is a circuit's.
   */
  socksProxy?: string;
  /**
   * Whether chain RPC rides the proxy too. The client defaults it to `true`,
   * which is the right answer for a payer on a strange network reading a
   * public RPC; the DRIVER's payers set `false`, because their chain is this
   * machine's own anvil on loopback and the circuit would buy nothing but
   * latency — `local/anyone`'s payer takes the same documented opt-out.
   */
  proxyRpc?: boolean;
}

/** A payer with an open, funded channel toward one node. */
export interface Payer {
  who: string;
  key: PayerKey;
  client: ToonClient;
  /** The channel this party holds with that node. */
  channelId: string;
  /** What was locked into it. */
  deposit: bigint;
}

/**
 * Fund a party on chain, then open and fund its channel.
 *
 * In that order and it has to be: a channel is collateralized with the
 * settlement token and opened by a transaction that costs gas, so a party with
 * neither can do nothing at all. Both come from the chain's own account zero,
 * which is what makes a devnet need no faucet.
 */
export async function openPayer(options: OpenPayerOptions): Promise<Payer> {
  await fundGas(options.rpcUrl, options.key.address, options.funding.gas);
  await mintToken(
    options.rpcUrl,
    options.token,
    options.key.address,
    options.funding.token
  );

  const client = await ToonClient.create({
    connector: options.connectorUrl,
    evmPrivateKey: options.key.privateKey,
    chain: 'evm',
    rpcUrl: options.rpcUrl,
    // Passed through only when set: the client refuses a socksProxy beside a
    // clearnet connector, and that refusal is right.
    ...(options.socksProxy === undefined
      ? {}
      : { socksProxy: options.socksProxy }),
    ...(options.proxyRpc === undefined ? {} : { proxyRpc: options.proxyRpc }),
    // A path rather than the in-memory default: the watermark is what stops a
    // claim being re-signed at a nonce the connector has already banked, and a
    // run makes many payments.
    channelStore: resolve(WORK_DIR, `${options.who}-channels.json`),
    // Nothing here is opened by accident. A run says when a channel is opened
    // and with what, because that is one of the things it is proving.
    autoOpenChannel: false,
  });

  const channel = await client.channel.open({
    deposit: options.funding.deposit,
  });

  return {
    who: options.who,
    key: options.key,
    client,
    channelId: channel.channelId,
    deposit: options.funding.deposit,
  };
}
