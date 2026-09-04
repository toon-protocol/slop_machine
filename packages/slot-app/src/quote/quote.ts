/**
 * The quote: what a slot costs, and which prefix this hub would grant you.
 *
 * ```
 * GET /quote
 * ```
 *
 * A broadcaster asks this before they buy, and it is **cheap** — its own
 * connector route at a floor price, exactly as a station's own *now* is priced
 * apart from its segments. Two things follow from that, and both are the point
 * of the address existing at all.
 *
 * **It is where the broadcaster learns their address.** The handle is the
 * hub's to assign and is derived from the payer the connector verified, so a
 * broadcaster cannot know it until they ask. They need it *before* the buy:
 * their own station's `connector.toml` terminates routes beneath the prefix
 * the hub grants, so a broadcaster who bought first would have to buy twice —
 * once to learn the label, once after configuring for it.
 *
 * **It is where every foreseeable refusal is moved.** The connector fulfills
 * on any complete answer from an app whatever its HTTP status — a status is
 * envelope content, never a packet outcome
 * ([connector ADR 0020](https://github.com/toon-protocol/connector/blob/main/docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md))
 * — so a refusal at the buy address is a refusal the broadcaster paid the slot
 * price for. There is no refund path in this repo and none is wanted, so the
 * design does the only other thing available: it makes the refusals *cheap*.
 * A hub at its cap says so here, for the price of a quote, and the expensive
 * address is only ever reached once this one has already said yes. That
 * correction is recorded in ADR 0003's amendment, which this address is the
 * implementation of.
 *
 * **It has its own connector prefix, and it is not the buy's.** One handler,
 * one price: an address reachable at another address's price is a slot sold
 * for the cost of a quote, or a quote sold for the cost of a slot. `/quote`
 * sits beneath nothing and nothing sits beneath it
 * ([connector ADR 0025](https://github.com/toon-protocol/connector/blob/main/docs/adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md)).
 *
 * **No payment code lives here.** The one payment-adjacent thing this module
 * does is read `X-TOON-Payer` — a fact the connector *stated*, having verified
 * it — and it validates no claim, parses no header beyond that one, and prices
 * nothing. The price it reports is a number a hub operator configured.
 *
 * @module
 */

import { Hono } from 'hono';
import {
  PAYER_HEADER,
  deriveHandleLabel,
  grantedPrefix,
  readPayerKey,
} from '../slot/handle.js';
import type { SlotPolicy } from '../slot/policy.js';
import type { SlotRoster } from '../slot/roster.js';

/**
 * The prefix the quote sits beneath — and, being the whole address, is.
 *
 * A connector route in front is written against this, at its own floor price.
 * It is deliberately **not** the buy's prefix and never may be: one handler,
 * one price, and no address reachable at another address's price.
 */
export const QUOTE_ROUTE_PREFIX = '/quote';

/** What the quote is, on the wire. */
export const QUOTE_CONTENT_TYPE = 'application/json';

/**
 * The refusal a request that did not arrive through a paid termination gets.
 *
 * Named for the thing that is missing rather than for the caller: what is
 * absent is a paid termination this connector verified, not a field the caller
 * failed to send. A caller cannot fix it by sending anything, because their own
 * spelling of the header is stripped before the app ever sees the delivery.
 */
export const NO_PAID_TERMINATION = 'no_paid_termination';

/** The caller's own slot, if they hold one. */
export interface HeldSlot {
  /**
   * When it lapses if it is not renewed, in milliseconds since the epoch.
   *
   * This is what a broadcaster reads to decide whether to renew, which is why
   * the quote carries it: the decision has to be makeable without paying the
   * slot price to find out.
   */
  lapsesAt: number;
}

/**
 * What a broadcaster reads before they buy.
 *
 * Four questions in one answer, because they are asked as one: what would I be
 * called, what does it cost, can I get in, and where do I already stand.
 */
export interface SlotQuote {
  /**
   * The ILP prefix this hub would grant **this caller** — its own address plus
   * the caller's derived label.
   *
   * This is the field the address exists for. A broadcaster writes it into
   * their own station's `connector.toml`, brings the station up, and is ready
   * to be pointed at before they have paid the slot price. It is stable: the
   * same payer reads the same prefix on every call, for ever.
   */
  prefix: string;
  /** The label beneath the hub's address that makes that prefix up. */
  label: string;
  /** The hub's own ILP address, which the prefix sits directly beneath. */
  hubAddress: string;
  /**
   * What buying a slot costs, in the settlement token's smallest unit.
   *
   * A number the hub operator configured and this app reports. It is not a
   * price this app charges — pricing a route is connector configuration — and
   * reporting it is what lets a broadcaster find out what a slot costs without
   * buying one.
   */
  slotPrice: number;
  /** How long one purchase lasts, in seconds. Buying again extends it. */
  slotPeriodSeconds: number;
  /**
   * Whether the hub can admit another slot right now.
   *
   * `false` is the refusal this whole address exists to move: a broadcaster
   * who cannot be admitted learns it here, for the price of a quote, instead of
   * paying the slot price to be turned away.
   */
  hasCapacity: boolean;
  /** How many slots the hub may hold at once — the operator's own cap. */
  slotCap: number;
  /** How many are held right now. */
  slotsHeld: number;
  /**
   * The caller's own slot, or `null` when they hold none.
   *
   * `null` is a broadcaster who has never bought, or whose slot has already
   * lapsed and been taken back out. It is the answer every caller gets until
   * #35 writes the first slot.
   */
  slot: HeldSlot | null;
}

/** A refusal, as the caller reads it. */
export interface QuoteRefusal {
  /** A stable code a client can branch on. */
  error: string;
  /** What is actually wrong, in the terms of whoever can fix it. */
  message: string;
}

/** What the quote route needs to answer. */
export interface QuoteDependencies {
  /** The hub's admission policy: price, period, cap, and its own address. */
  policy: SlotPolicy;
  /** The hub's roster, read to answer capacity and the caller's own slot. */
  roster: SlotRoster;
}

/**
 * The route that quotes a slot, to be mounted at {@link QUOTE_ROUTE_PREFIX}.
 *
 * Answers `200` with a {@link SlotQuote} to anything that arrived through a
 * paid termination the connector verified, and `403` with a
 * {@link QuoteRefusal} to anything that did not. A hub at its cap is a `200`
 * saying so, not a refusal: "you cannot get in right now" is an answer a
 * broadcaster paid a floor price for and is entitled to read.
 */
export function quoteRoutes(deps: QuoteDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const payerKey = readPayerKey(c.req.header(PAYER_HEADER));

    if (payerKey === undefined) {
      // Refused before anything else happens, and refused in terms of the
      // hub's own wiring. The caller sent nothing wrong — their own spelling
      // of the header was stripped by the connector before this delivery
      // existed — so blaming their request would send them to fix something
      // that is not broken.
      const refusal: QuoteRefusal = {
        error: NO_PAID_TERMINATION,
        message:
          "this request did not arrive through a paid termination the hub's connector verified, so it states no payer. A terminating connector states X-TOON-Payer only where it admitted a covering client claim itself and the route it arrived on carries a non-zero price; a caller's own spelling of that header never survives its strip. Nothing here is about the request body. The hub operator's route for this address is what to look at.",
      };
      return c.json(refusal, 403, noStore());
    }

    const { policy, roster } = deps;

    // A payer already on the roster is read off it rather than derived for: a
    // slot's label is the label it was granted, and a renewal must return the
    // same handle even if the derivation's starting length has since changed.
    const held = roster.find(payerKey);
    const label =
      held?.label ??
      deriveHandleLabel(
        payerKey,
        (candidate) => roster.holderOf(candidate) !== undefined
      );

    const quote: SlotQuote = {
      prefix: grantedPrefix(policy.hubAddress, label),
      label,
      hubAddress: policy.hubAddress,
      slotPrice: policy.slotPrice,
      slotPeriodSeconds: policy.slotPeriodSeconds,
      // A slot the caller already holds is renewable whether or not the hub
      // has room for a new one — but capacity is reported as the plain fact it
      // is, and #35 decides what a renewal does with it.
      hasCapacity: roster.size() < policy.slotCap,
      slotCap: policy.slotCap,
      slotsHeld: roster.size(),
      slot: held === undefined ? null : { lapsesAt: held.lapsesAt },
    };

    return c.json(quote, 200, noStore());
  });

  return routes;
}

/**
 * A quote is per-caller and perishable: the prefix is derived from *this*
 * payer, and the capacity is true only for as long as the roster is unchanged.
 * A cache handing one broadcaster's quote to the next would hand out the wrong
 * address and hand away the payment for asking.
 */
function noStore(): Record<string, string> {
  return { 'cache-control': 'no-store' };
}
