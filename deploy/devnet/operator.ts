/**
 * Reading a hub's own tables over its operator surface — the read half, and
 * only the read half.
 *
 * A run asserts what the hub **actually holds** rather than what a purchase
 * said it did. The two are different claims: the buy's answer is the slot
 * app's account of what it wrote, and this is the connector's account of what
 * it is carrying. Where they disagree, a broadcaster has a fulfill that
 * promised something nothing will honour.
 *
 * **Reads only, and bearer-gated, which is the connector's own split.** Every
 * write to this surface needs an RFC 9421 signature from a key on the
 * allowlist, and the devnet signs none: the slot app is the only thing in this
 * topology that writes here, because writing here is what a purchase buys. A
 * run that wrote its own rows would be proving that a driver can edit a
 * routing table.
 */

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
