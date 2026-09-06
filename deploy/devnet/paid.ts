/**
 * The paid requests a run makes, and the two shapes they come in.
 *
 * These live here rather than in `devnet.test.ts` because the test is no
 * longer the only thing that walks this path: `demo.ts` walks the same one
 * with a broadcaster at the keyboard. A second copy of "how a slot is bought"
 * is a copy that drifts, and the drift would be silent — both callers would
 * still pass, against two different ideas of what a purchase is.
 *
 * NOTHING HERE HOLDS A VALUE OF ITS OWN. The hub's address, the station's URL
 * and every price stay with the caller: the test declares every expected value
 * as a literal and that rule is what makes it evidence, so these take what
 * they need as arguments rather than becoming a place a literal could hide.
 *
 * ## The two shapes
 *
 * A request the addressed node TERMINATES — a quote, a purchase — is paid at
 * that node's own price and sealed to nobody, because the node the packet is
 * addressed to is the node that opens it.
 *
 * A request it FORWARDS — anything at the station, reached across the hub — is
 * sealed to the connector that terminates it, and that key comes off the
 * station's own self-description. No hop may name another node's key on its
 * behalf, so a run that took `sealTo` from the hub would be proving the hub
 * honest by asking the hub.
 */

import type { Payer } from './payer.js';

/** What a hub answers at its cheap address, plus what the answer cost. */
export interface Quote {
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
export async function pullQuote(
  payer: Payer,
  hubAddress: string
): Promise<Quote> {
  const answer = await payer.client.send(`${hubAddress}.slot.quote`, {
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
export interface BuyAttempt {
  status: number;
  body: unknown;
  paid: bigint;
}

/** The slot a broadcaster reads back once they are peered. */
export interface BoughtSlot {
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
 * `stationUrl` is the station AS THE HUB REACHES IT, which is its compose
 * service and never the driver's loopback publish: the fetch is the hub's, and
 * a container reaching its own host's 127.0.0.1 reaches itself.
 *
 * It never throws on a refusal: a refusal IS the answer, it is paid for like
 * any other, and one of them is a thing a run is here to see.
 */
export async function attemptBuy(
  payer: Payer,
  hubAddress: string,
  stationUrl: string
): Promise<BuyAttempt> {
  const answer = await payer.client.send(`${hubAddress}.slot.buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { stationUrl },
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
export interface PaidPull {
  status: number;
  body: Uint8Array;
  text: string;
  /** What the connector charged — read off the claim, never asserted into it. */
  paid: bigint;
}

/**
 * Pay for one request that crosses the hub to the station.
 *
 * Two things make this different from paying the hub itself. The destination
 * is a prefix the hub FORWARDS rather than terminates, so the payload is
 * sealed to the connector that terminates it — `sealTo` is the station's own
 * edge identity, taken off its own self-description, because no hop may name
 * that key on another node's behalf. And the amount is whatever the hub prices
 * the forwarded route at, which the client reads from the hub itself: a caller
 * that supplied the figure would be asserting its own arithmetic rather than
 * the hub's.
 */
export async function pullThroughTheHub(
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
