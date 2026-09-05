/**
 * Reading a node's own tables over its operator surface — and, once, writing.
 *
 * A run asserts what the hub **actually holds** rather than what a purchase
 * said it did. The two are different claims: the buy's answer is the slot
 * app's account of what it wrote, and this is the connector's account of what
 * it is carrying. Where they disagree, a broadcaster has a fulfill that
 * promised something nothing will honour.
 *
 * **Reads are bearer-gated and writes are signature-gated, which is the
 * connector's own split.** The reads here are a hub operator's own: what its
 * routing table holds, who it is peered with, what its channels hold. Nothing
 * in a run writes to the HUB's surface — the slot app is the only thing in
 * this topology that does, because writing there is what a purchase buys, and
 * a run that wrote its own rows would be proving that a driver can edit a
 * routing table.
 *
 * The one write is to the STATION's own surface, and it is the broadcaster's:
 * redeeming what their station was paid. It is signed with the seed a run
 * keeps in memory, whose public half is the only line in that node's
 * allowlist — because on a station the private half does not live on the box
 * at all. The signature is made with the SLOT APP's own RFC 9421
 * implementation, which is the fleet's only one in TypeScript and is held to
 * the verifier it targets; a second implementation here would be a second
 * thing to be wrong.
 */

import { createWriteSigner } from '../../packages/slot-app/src/operator/write-signature.js';

/** The whole exchange's budget for one read. A node that is up answers in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/** One row of the hub's routing table, as the operator surface answers it. */
export interface CarriedRoute {
  /** The ILP prefix this row carries. */
  prefix: string;
  /** The peering it forwards to — the hub's own local label for that relation. */
  peerId: string;
  /** `runtime` for a row written over this surface, `config` for the operator's own. */
  source: string;
  /**
   * What the hub charges to carry it, in the operator's own two spellings: a
   * bare integer for a flat price, `{ base, per_kib }` for one with a slope.
   */
  price?: number | { base: number; per_kib: number };
}

/** One peering the hub holds. */
export interface CarriedPeering {
  id: string;
  /** What the hub retains for carrying one packet over it — flat, per packet. */
  fee?: number;
  source: string;
}

/** One payment channel the hub's connector knows about. */
export interface CarriedChannel {
  id: string;
  status?: string;
  chain?: string;
}

async function read<T>(
  baseUrl: string,
  bearerToken: string,
  path: string
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `the hub's operator surface answered ${String(response.status)} to ${path}: ${await response.text()}`
    );
  }
  return (await response.json()) as T;
}

/**
 * The hub's forwarded routing table.
 *
 * `source` is read rather than assumed, because it is the difference between a
 * row the slot app wrote and one the hub operator's own config file owns — and
 * the whole of what a purchase writes is the first kind.
 */
export async function readCarriedRoutes(
  baseUrl: string,
  bearerToken: string
): Promise<CarriedRoute[]> {
  const rows = await read<Record<string, unknown>[]>(
    baseUrl,
    bearerToken,
    '/routes/peers'
  );

  return rows.map((row) => ({
    prefix: String(row['prefix'] ?? ''),
    peerId: String(row['peer_id'] ?? ''),
    source: String(row['source'] ?? ''),
    price: row['price'] as CarriedRoute['price'],
  }));
}

/** Who the hub is peered with. */
export async function readCarriedPeerings(
  baseUrl: string,
  bearerToken: string
): Promise<CarriedPeering[]> {
  const rows = await read<Record<string, unknown>[]>(
    baseUrl,
    bearerToken,
    '/peers'
  );

  return rows.map((row) => ({
    id: String(row['id'] ?? ''),
    fee: typeof row['fee'] === 'number' ? row['fee'] : undefined,
    source: String(row['source'] ?? ''),
  }));
}

/** What channels the hub's connector holds, and what it says about each. */
export async function readCarriedChannels(
  baseUrl: string,
  bearerToken: string
): Promise<CarriedChannel[]> {
  const rows = await read<Record<string, unknown>[]>(
    baseUrl,
    bearerToken,
    '/channels'
  );

  return rows.map((row) => ({
    id: String(row['id'] ?? row['channel_id'] ?? ''),
    status: row['status'] === undefined ? undefined : String(row['status']),
    chain: row['chain'] === undefined ? undefined : String(row['chain']),
  }));
}

/** The flat half of a route's price, whichever spelling the row arrived in. */
export function basePriceOf(route: CarriedRoute): bigint | undefined {
  if (typeof route.price === 'number') return BigInt(route.price);
  if (typeof route.price === 'object' && route.price !== null) {
    return BigInt(route.price.base);
  }
  return undefined;
}

/** The slope, or `0n` on a flat price — which every station route in the fleet is. */
export function slopeOf(route: CarriedRoute): bigint {
  if (typeof route.price === 'object' && route.price !== null) {
    return BigInt(route.price.per_kib);
  }
  return 0n;
}

/**
 * What a claim this node accepted has advanced to.
 *
 * `cumulativeAmount` is the whole point and the thing that is easy to misread:
 * a claim is CUMULATIVE, so this is everything that channel has ever carried,
 * not what the last packet paid. The difference between two readings is what
 * one packet moved.
 */
export interface AcceptedClaim {
  channelId: string;
  /** `inbound` for money coming to this node. */
  direction: string;
  nonce: number;
  cumulativeAmount: bigint;
  /** Which book it came out of — the peer semantics's, or the client edge's. */
  book?: string;
}

/** Every claim this node has accepted, out of both of its books. */
export async function readAcceptedClaims(
  baseUrl: string,
  bearerToken: string
): Promise<AcceptedClaim[]> {
  const rows = await read<Record<string, unknown>[]>(
    baseUrl,
    bearerToken,
    '/claims'
  );

  return rows.map((row) => ({
    channelId: String(row['channel_id'] ?? ''),
    direction: String(row['direction'] ?? ''),
    nonce: Number(row['nonce'] ?? 0),
    cumulativeAmount: BigInt(String(row['cumulative_amount'] ?? '0')),
    book: row['book'] === undefined ? undefined : String(row['book']),
  }));
}

/**
 * Redeem the latest claim this node accepted on one channel, ON CHAIN.
 *
 * The connector's own verb — `POST /channels/:id/redeem-latest` — so a run
 * redeems the way a broadcaster does rather than reassembling a balance proof
 * and calling the token network itself. Redemption does NOT require a closed
 * channel: the money moves and the channel stays open, which is what makes
 * "the broadcaster was paid" a thing a run can prove without time travel.
 *
 * A signed write, with no body. The signature is bound to the exact bytes
 * being sent, so an empty body is signed as one.
 */
export async function redeemLatestClaim(options: {
  baseUrl: string;
  writeKey: string;
  channelId: string;
}): Promise<{ status: number; body: string }> {
  const path = `/channels/${options.channelId}/redeem-latest`;
  const body = '';
  const signed = await createWriteSigner(options.writeKey).sign(
    'POST',
    path,
    body
  );

  const response = await fetch(`${options.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-digest': signed['content-digest'],
      'signature-input': signed['signature-input'],
      signature: signed.signature,
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  return { status: response.status, body: await response.text() };
}
