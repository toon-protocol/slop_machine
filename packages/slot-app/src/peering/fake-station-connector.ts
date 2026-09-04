/**
 * A fake of a **station connector's own self-description** — a fake, not a
 * mock, on the read side of the purchase.
 *
 * The suite's seam here mirrors the one on the write side. The write side is
 * `--operator-url` pointed at a fake operator surface; the read side is the
 * `stationUrl` a broadcaster sends, pointed at this. Neither is an injected
 * port on the app's own API: what the app does in the suite is what it does
 * on a hub, and the only difference is which host answered.
 *
 * **What makes it a fake is that it publishes a real document.** It answers
 * `GET /ilp` with the shape a connector actually serializes (connector ADR
 * 0050, `connector_domain::node`) — `ilpAddresses`, `httpEndpoint`,
 * `btpEndpoint`, `peerCarriages`, `edgeIdentity`, `settlements`, `routes`,
 * `supportedVersions`, `defaultVersion` — with prices spelled as decimal
 * strings, because that is how a `u64` of base units goes on that wire. So
 * the prices a test asserts are prices the hub **derived from a document**,
 * not values a stub handed it.
 *
 * **It is a ladder beneath an apex**, which is what a station is: one rung
 * per quality level plus the station's own *now*, each at its own price,
 * each terminated beneath one prefix. {@link FakeStationConnector.terminateAt}
 * is the step a real broadcaster performs by hand — pull a quote, take the
 * prefix the hub granted, write it into `connector.toml` where the committed
 * bundle says `demo`, and boot. A station that never did it publishes a
 * ladder beneath somebody else's apex, and this fake can be left that way on
 * purpose.
 *
 * **This module is test scaffolding and ships in no bundle** — nothing the
 * app's entrypoints import reaches it.
 *
 * @module
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

/** One rung of a station's ladder, priced as its own connector prices it. */
export interface FakeStationRung {
  /**
   * The last segment of its prefix — `now`, `audio`, `480p`. A station's
   * addresses are its apex plus one of these.
   */
  rung: string;
  /**
   * What that address costs, in the settlement asset's base units, as a
   * decimal string — the document's own spelling.
   */
  price: string;
  /**
   * What each started kibibyte of payload adds, where this route has a slope
   * (connector ADR 0065). No station route in the fleet has one; a hub may
   * still be pointed at a connector that does.
   */
  pricePerKib?: string;
}

/** How the fake behaves. */
export interface FakeStationConnectorOptions {
  /**
   * The prefix the ladder is terminated beneath. The committed station bundle
   * ships `g.toon.slopmachine.demo`, where `demo` is a placeholder a
   * broadcaster replaces with the handle their quote granted them.
   */
  apex: string;
  /** The ladder this station sells, in the order it publishes it. */
  ladder: readonly FakeStationRung[];
  /**
   * Priced addresses published verbatim, beneath no apex — a node that
   * terminates something besides its own ladder, which a hub granting one
   * prefix has no business pointing at anybody.
   */
  alsoPublishes?: readonly { prefix: string; price: string }[];
  /**
   * Answer this status instead of a document — an origin behind the URL, a
   * connector that is down, a proxy that lost it.
   */
  status?: number;
  /** Answer this body verbatim, whatever it is. */
  body?: string;
  /** Redirect to this location rather than answering. */
  redirectTo?: string;
}

/** A running fake station connector. */
export interface FakeStationConnector {
  /** Its self-description URL — what a purchase carries as `stationUrl`. */
  url: string;
  /**
   * Point the ladder at `apex`: what a broadcaster does when they write the
   * prefix their quote granted them into their own `connector.toml` and boot.
   */
  terminateAt(apex: string): void;
  /** How many times the document has been read. */
  reads(): number;
  /** Stop it. Idempotent. */
  stop(): Promise<void>;
}

/** Boot a fake station connector on an ephemeral port. */
export async function startFakeStationConnector(
  options: FakeStationConnectorOptions
): Promise<FakeStationConnector> {
  let apex = options.apex;
  let reads = 0;

  const connector = new Hono();

  connector.get('/ilp', (c) => {
    reads += 1;

    if (options.redirectTo !== undefined) {
      return c.redirect(options.redirectTo, 307);
    }
    if (options.body !== undefined) {
      return c.text(options.body, (options.status ?? 200) as 200);
    }
    if (options.status !== undefined && options.status !== 200) {
      return c.text('this is not a self-description', options.status as 500);
    }

    // The document a connector actually serves: this node's own facts, its
    // edge identity, what it settles in, and its route prices. Only the last
    // is the hub's business, and it is published here among everything else
    // precisely so that reading it is reading a real document.
    return c.json({
      ilpAddresses: [
        ...options.ladder.map((rung) => `${apex}.${rung.rung}`),
        ...(options.alsoPublishes ?? []).map((route) => route.prefix),
      ],
      httpEndpoint: 'https://station.example/ilp',
      btpEndpoint: 'wss://station.example/ilp/btp',
      peerCarriages: ['http'],
      edgeIdentity: {
        keyId: 'station-edge',
        publicKey: `0x${'ab'.repeat(64)}`,
      },
      settlements: [
        {
          chain: 'evm:84532',
          settlementAddress: '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf',
          tokenNetworkRegistry: '0xcc9079ade929b168b54145f6d25262b64fab9d5b',
          tokenNetwork: '0x1e95493fef46707e034b4a1945f25a8c76a1823d',
          tokenAddress: '0x49bee1bca5d15fb0963117923403f9498119a9ce',
          decimals: 6,
        },
      ],
      routes: [
        ...options.ladder.map((rung) => ({
          prefix: `${apex}.${rung.rung}`,
          price: rung.price,
          ...(rung.pricePerKib === undefined
            ? {}
            : { pricePerKib: rung.pricePerKib }),
        })),
        ...(options.alsoPublishes ?? []),
      ],
      supportedVersions: [1],
      defaultVersion: 1,
    });
  });

  const { server, port } = await listen(connector.fetch);

  return {
    url: `http://127.0.0.1:${String(port)}/ilp`,
    terminateAt(next) {
      apex = next;
    },
    reads: () => reads,
    stop() {
      return new Promise<void>((stopped, failed) => {
        server.close((err) => (err ? failed(err) : stopped()));
      });
    },
  };
}

function listen(
  fetch: Hono['fetch']
): Promise<{ server: ServerType; port: number }> {
  return new Promise((bound, failed) => {
    const server = serve({ fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      bound({ server, port: info.port });
    });
    server.once('error', failed);
  });
}
