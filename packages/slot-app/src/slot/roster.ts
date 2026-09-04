/**
 * The roster: who holds a slot on this hub, and until when.
 *
 * A **slot** is the routing-table entry a broadcaster bought. It is not a
 * **peering** — the peering is what the hub's operator key creates in response
 * to the purchase, and it is named for that wherever it appears (ADR 0003).
 * Nothing in this module mentions a peering, a peer, a channel or a route: the
 * roster records what was *bought*, and the connector's own tables record what
 * was *done about it*.
 *
 * **This is the read surface, and at this point in the chain it is all of it.**
 * Issue #34 is the quote, and the quote only ever asks the roster three
 * questions:
 *
 *   - how many slots are held, which is what the cap is measured against;
 *   - whether this caller holds one, and when it lapses;
 *   - whether a candidate label is already somebody's, which is what makes
 *     handle derivation lengthen rather than collide.
 *
 * There is deliberately **no write path here yet**. The buy is #35 and the
 * lapse is #37; both hang a writer off this interface — `record`, and the
 * teardown that removes — and neither needs the three reads above to change
 * shape to do it. What a roster is made of is likewise not decided here: #35
 * makes it durable in the app's data directory and reads it back at boot, and
 * every reader above goes on asking the same three questions of it. Nothing
 * outside this module knows how a slot is stored, and no test may.
 *
 * @module
 */

/** One slot, as the hub records it. */
export interface Slot {
  /**
   * The verified payer key the slot is bound to, exactly as the connector
   * stated it. This is the slot's identity: a purchase from this key is a
   * renewal of this slot, and a purchase from any other key is a different
   * slot at a different handle.
   */
  payer: string;
  /**
   * The label the hub granted this payer. The prefix a broadcaster is reachable
   * at is the hub's own address followed by this — derived rather than stored
   * whole, so a hub that moves its address does not have to rewrite its roster.
   */
  label: string;
  /**
   * When the slot lapses if it is not renewed, in milliseconds since the
   * epoch. Past this the hub takes the routes and then the peering back out on
   * its own initiative, which is what stops a dead station from holding a
   * hub's capital for ever.
   */
  lapsesAt: number;
}

/** What a reader may ask the roster. */
export interface SlotRoster {
  /**
   * How many slots are held right now — the number the hub's cap bounds.
   *
   * Counted rather than stored, so it cannot drift from the slots themselves.
   */
  size(): number;
  /** The slot this payer holds, or `undefined` if they hold none. */
  find(payer: string): Slot | undefined;
  /**
   * The slot holding this label, or `undefined` if the label is free.
   *
   * This is what handle derivation asks before granting a label, and it is
   * asked by label rather than by payer because the question is about the
   * address space, not about who is asking.
   */
  holderOf(label: string): Slot | undefined;
}

/**
 * A roster over a set of slots.
 *
 * `slots` is what the hub already holds. #34 always passes none — nothing
 * writes a slot yet — and #35 passes what it read back off disk at boot. The
 * argument exists so that reading an existing roster and starting an empty one
 * are the same call, rather than a boot path the empty case does not take.
 *
 * Two slots for one payer, or two slots at one label, are a corrupt roster;
 * the later one wins here and the writer that produced it is the thing to fix.
 */
export function createSlotRoster(slots: readonly Slot[] = []): SlotRoster {
  const byPayer = new Map<string, Slot>();
  const byLabel = new Map<string, Slot>();
  for (const slot of slots) {
    byPayer.set(slot.payer, slot);
    byLabel.set(slot.label, slot);
  }

  return {
    size() {
      return byPayer.size;
    },
    find(payer) {
      return byPayer.get(payer);
    },
    holderOf(label) {
      return byLabel.get(label);
    },
  };
}
