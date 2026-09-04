/**
 * The refusals both paid addresses share, and what a refusal looks like.
 *
 * One vocabulary rather than one per address: a broadcaster whose request did
 * not arrive through a paid termination reads the same `error` at the quote
 * and at the buy, and a client that learned to branch on it at the cheap
 * address does not have to learn it twice.
 *
 * **A refusal at a paid address is paid for** (ADR 0003's amendment), so the
 * set of them is deliberately small and every member of it is either
 * unforeseeable at the quote or about the hub's own wiring. Adding one is
 * adding a new way to charge a broadcaster for nothing; read the amendment
 * before you do.
 *
 * @module
 */

/**
 * The refusal a request that did not arrive through a paid termination gets.
 *
 * Named for the thing that is missing rather than for the caller: what is
 * absent is a paid termination this connector verified, not a field the caller
 * failed to send. A caller cannot fix it by sending anything, because their own
 * spelling of the header is stripped before the app ever sees the delivery.
 */
export const NO_PAID_TERMINATION = 'no_paid_termination';

/** A refusal, as the caller reads it. */
export interface SlotAppRefusal {
  /** A stable code a client can branch on. */
  error: string;
  /** What is actually wrong, in the terms of whoever can fix it. */
  message: string;
}

/**
 * What a request with no verified payer is told, at either paid address.
 *
 * The refusal is about how the hub is wired, not about what the caller sent —
 * a caller's own spelling of the header never survives the connector's strip,
 * so there is nothing in their request to fix.
 */
export const NO_PAID_TERMINATION_MESSAGE =
  "this request did not arrive through a paid termination the hub's connector verified, so it states no payer. A terminating connector states X-TOON-Payer only where it admitted a covering client claim itself and the route it arrived on carries a non-zero price; a caller's own spelling of that header never survives its strip. Nothing here is about the request body. The hub operator's route for this address is what to look at.";
