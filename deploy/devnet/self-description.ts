/**
 * Reading a node's own self-description — `GET /ilp`, connector ADR 0050.
 *
 * It is the free, unauthenticated document a stranger needs and nothing else
 * to transact with a node: the ILP addresses it answers to, where clients
 * reach it, its edge identity, what it settles in and on which chain, and the
 * price of every route it terminates.
 *
 * A run reads it for two different jobs, and they are worth telling apart.
 *
 * - **Its own two nodes**, to check they came up describing themselves the way
 *   their generated configuration said they would. A node that boots but
 *   publishes the wrong endpoint, no settlement entry, or a route list that is
 *   not what it was configured with is a node nothing downstream can be
 *   believed about.
 * - **The station, as the HUB reads it.** This is the same document the slot
 *   app fetches on a purchase and derives every route price from, so a run
 *   asserting against it is asserting against what the hub will actually see —
 *   not against a value the run itself supplied.
 *
 * The shape is the connector's (`connector_domain::node`), and prices are
 * decimal STRINGS, because a `u64` of an asset's base units is not
 * representable in a JSON number a JavaScript reader can be trusted with. They
 * are read as `bigint` here for the same reason the slot app reads them that
 * way: a price quietly rounded is a route priced below the station's own
 * termination.
 */

/** One priced address a node publishes. */
export interface PublishedRoute {
  prefix: string;
  /** What a packet of any size costs there, in the settlement asset's base units. */
  price: bigint;
  /** What each started kibibyte of payload adds, or `0n` where there is no slope. */
  pricePerKib: bigint;
}

/** What a node settles in, on one chain. */
export interface PublishedSettlement {
  /** `evm:<chain id>` — the chain, as the document names it. */
  chain: string;
  /** The address channels are opened against on that chain. */
  settlementAddress: string;
  /** The registry a token network is resolved through. */
  tokenNetworkRegistry: string;
  /** The token network channels live on. */
  tokenNetwork: string;
  /** The token, and what it reports about itself. */
  tokenAddress: string;
  decimals: number;
}

/** A node's self-description, as a run reads it. */
export interface SelfDescription {
  /** Every ILP address this node answers to. */
  ilpAddresses: string[];
  /** Where a client reaches it — a devnet node names its compose service. */
  httpEndpoint: string;
  /** The identity a client seals a payload to. A node with none can terminate nothing. */
  edgeIdentity: { keyId: string; publicKey: string };
  /** What it settles in. A devnet node has exactly one entry, on the local chain. */
  settlements: PublishedSettlement[];
  /** Every priced address it terminates, in the order it published them. */
  routes: PublishedRoute[];
}

/** The whole exchange's budget. A node that is up answers this in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

function decimal(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(
      `a self-description published ${what} as ${JSON.stringify(value)} — a price is a decimal string of base units, and a reader that guessed at anything else would be rounding somebody's money`
    );
  }
  return BigInt(value);
}

/**
 * Read one node's self-description.
 *
 * Failures name the URL, because in a topology with two connectors on two host
 * ports the first question about any failure here is which node it was.
 */
export async function readSelfDescription(
  url: string
): Promise<SelfDescription> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `${url} answered ${String(response.status)} rather than a self-description`
    );
  }

  const document = (await response.json()) as Record<string, unknown>;
  const routes = (document['routes'] ?? []) as Record<string, unknown>[];
  const settlements = (document['settlements'] ?? []) as Record<
    string,
    unknown
  >[];
  const identity = (document['edgeIdentity'] ?? {}) as Record<string, unknown>;

  return {
    ilpAddresses: (document['ilpAddresses'] ?? []) as string[],
    httpEndpoint: String(document['httpEndpoint'] ?? ''),
    edgeIdentity: {
      keyId: String(identity['keyId'] ?? ''),
      publicKey: String(identity['publicKey'] ?? ''),
    },
    settlements: settlements.map((entry) => ({
      chain: String(entry['chain'] ?? ''),
      settlementAddress: String(entry['settlementAddress'] ?? ''),
      tokenNetworkRegistry: String(entry['tokenNetworkRegistry'] ?? ''),
      tokenNetwork: String(entry['tokenNetwork'] ?? ''),
      tokenAddress: String(entry['tokenAddress'] ?? ''),
      decimals: Number(entry['decimals'] ?? 0),
    })),
    routes: routes.map((route) => ({
      prefix: String(route['prefix'] ?? ''),
      price: decimal(route['price'], `a price for ${String(route['prefix'])}`),
      pricePerKib:
        route['pricePerKib'] === undefined
          ? 0n
          : decimal(
              route['pricePerKib'],
              `a slope for ${String(route['prefix'])}`
            ),
    })),
  };
}
