/**
 * The roster: who holds a slot on this hub, and until when.
 *
 * A **slot** is the routing-table entry a broadcaster bought. It is not a
 * **peering** — the peering is what the hub's operator key creates in
 * response to the purchase, and it is named for that wherever it appears
 * (ADR 0003). Nothing in this module mentions a peering, a peer or a route:
 * the roster records what was *bought*, and the connector's own tables record
 * what was *done about it*.
 *
 * **The one exception is `channelId`, and it is an exception on purpose.**
 * The hub's own money is in that channel — the collateral the buy deposits
 * before it writes a route (ADR 0003's third amendment) — and a slot is the
 * only durable record this hub has of which channel it funded for whom, and
 * of how much. Without it nothing later can tell a channel this hub funded
 * from one it did not, which is what a reclaim would have to act on and what a
 * hub operator reading their own roster wants to know: the commitment
 * `TOON_SLOT_CAP` bounds is a number they can read rather than one they have
 * to compute. `packages/slot-app/src/slot-app/vocabulary.test.ts` names that
 * one identifier and no other, so a second one has to be argued for rather
 * than acquired.
 *
 * Five questions and two answers, which is the whole surface:
 *
 *   - how many slots are held, which is what the cap is measured against;
 *   - whether this caller holds one, and when it lapses;
 *   - whether a candidate label is already somebody's, which is what makes
 *     handle derivation lengthen rather than collide;
 *   - every slot held, which is what the lapse walks;
 *   - and, from the buy onward, `record` — one slot, written down — and its
 *     opposite, `remove`, which is how a slot nobody renewed stops being one.
 *
 * **`record` returns only once the slot is on disk.** That ordering is the
 * point of it and it is not an implementation detail: gas is spent inside a
 * paid request here, so a purchase whose answer arrived too late has to be
 * found *already done* when the broadcaster retries, rather than charging
 * them for the same peering twice. A roster that answered before it had
 * written would lose exactly the purchases that were slow enough to be
 * retried — which is every purchase this ordering exists for.
 *
 * The file lives in the app's data directory and is read back at boot,
 * exactly as the origin reads its segment window back rather than renumbering
 * from zero. **How a slot is stored is nobody else's business**: no caller
 * and no test knows the file's name, its shape or that there is a file at
 * all, and every reader goes on asking the four questions above.
 *
 * **A slot also records the addresses it was granted at, where they point, and
 * the channel the hub funded behind them — and that is not the connector's
 * table restated here.** The connector's
 * table is what the hub is carrying *now*; this is what the broadcaster
 * *bought*, which is the only thing that can say whether what is being carried
 * is right. A hub that came back to find a row missing and had nothing to
 * compare against could only re-read the broadcaster's own connector to find
 * out what it owed them — and a station that happened to be down while its hub
 * rebooted would lose the addresses it had already paid for. So the terms of
 * the purchase live with the purchase.
 *
 * @module
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * One address the hub granted a slot, and what it granted it at.
 *
 * Recorded rather than re-derived, because re-deriving it means reading the
 * broadcaster's own connector again — and a station that is down while the hub
 * boots would then lose the addresses it had already paid for. The prices are
 * decimal strings of base units for the same reason they are `bigint`
 * everywhere else: a `u64` rounded through a double is an address priced under
 * what the station itself terminates at.
 */
export interface GrantedRoute {
  /** The ILP prefix, beneath the granted one. */
  prefix: string;
  /** What the hub charges to carry it: the station's price plus carriage. */
  price: string;
  /** The station's own slope, carried across unchanged. Absent where flat. */
  pricePerKib?: string;
}

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
  /**
   * The station connector's self-description URL the purchase named.
   *
   * Kept because a hub that comes back to find its own connector missing a row
   * this slot paid for has to be able to write it again, and that write names
   * the URL. Absent on a slot recorded by a version of this app that did not
   * reconcile at boot; such a slot is left as it is until its next renewal.
   */
  stationUrl?: string;
  /**
   * The chain the connector stated the broadcaster paid on, where it stated
   * one — what the hub settles this admission over, and therefore what a
   * rewrite of it names rather than guessing between two shared chains.
   */
  chain?: string;
  /**
   * The addresses the hub granted this slot and what it granted them at: the
   * hub's own record of what its connector should be carrying for this
   * broadcaster until the slot lapses.
   */
  routes?: GrantedRoute[];
  /**
   * The payment channel the hub funded for this broadcaster.
   *
   * Recorded because the hub's own capital is in it and nothing else in this
   * app remembers which one. A lapse releases the peering and **leaves the
   * deposit where it is** (ADR 0003's third amendment), so the only record of
   * what a hub operator would have to close and settle to get that capital
   * back is this one. Absent on a slot recorded before the buy funded
   * anything; such a slot is left as it is until its next renewal.
   */
  channelId?: string;
  /**
   * What the hub's own side of that channel held when this slot was last
   * written, in the settlement token's smallest unit.
   *
   * A decimal string for the same reason a granted price is: an amount is a
   * `u128` of base units and a hub that round-tripped one through a double
   * would report a commitment it does not have. Absent on the same terms as
   * {@link Slot.channelId}, and written in the same act.
   */
  collateral?: string;
}

/** What a reader — and, from the buy onward, a writer — may ask the roster. */
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
  /**
   * Every slot held right now, in no promised order.
   *
   * This is what a lapse walks: the question "which of these is past its
   * lapse time" cannot be asked of a roster that only answers about one payer
   * at a time. It is a snapshot — a caller that records or removes while
   * reading it is reading what was there when it asked, which is the right
   * reading for a sweep that then acts on each row one at a time.
   */
  held(): Slot[];
  /**
   * Write one slot down, replacing whatever this payer held before.
   *
   * **Resolves only once the slot is durable.** A caller that awaits this
   * before answering has made the purchase findable by the retry that a late
   * answer produces; a caller that answered first would not have.
   *
   * @throws SlotRosterError if the slot could not be written. A purchase
   * whose peering was established but whose slot could not be recorded is a
   * failure, not a success with a note — the whole point of recording is that
   * the retry finds it.
   */
  record(slot: Slot): Promise<void>;
  /**
   * Take this payer's slot back off the roster, if they held one.
   *
   * **Resolves only once the removal is durable**, on exactly the terms
   * `record` resolves on. A hub that answered before it had written would
   * come back from a restart still holding a slot it had already taken the
   * routes and the peering out for, and would spend the rest of that slot's
   * life trying to tear down a station it had already released.
   *
   * Removing a payer who holds nothing is a success and writes nothing: the
   * state asked for is the state that already obtains, and a sweep that
   * crossed a purchase must not be a sweep that failed.
   *
   * @throws SlotRosterError if the roster could not be written.
   */
  remove(payer: string): Promise<void>;
}

/** A roster that could not be read or written. */
export class SlotRosterError extends Error {
  override readonly name = 'SlotRosterError';
}

/** What the roster is called inside the app's data directory. */
const ROSTER_FILE = 'roster.json';

/** The shape on disk, so a later version can tell what it is reading. */
const ROSTER_VERSION = 1;

/**
 * A roster over a set of slots, held in memory only.
 *
 * `record` here writes nothing down, so this is the roster of a hub with no
 * data directory rather than the one a hub runs: {@link openSlotRoster} is
 * what a hub boots. Kept because reading an existing roster and starting an
 * empty one have to be the same call rather than a boot path the empty case
 * does not take.
 *
 * Two slots for one payer, or two slots at one label, are a corrupt roster;
 * the later one wins here and the writer that produced it is the thing to fix.
 */
export function createSlotRoster(slots: readonly Slot[] = []): SlotRoster {
  const byPayer = new Map<string, Slot>();
  const byLabel = new Map<string, Slot>();

  const hold = (slot: Slot): void => {
    // A payer whose label changed leaves no ghost behind at the old one.
    const held = byPayer.get(slot.payer);
    if (held !== undefined && held.label !== slot.label) {
      byLabel.delete(held.label);
    }
    byPayer.set(slot.payer, slot);
    byLabel.set(slot.label, slot);
  };

  for (const slot of slots) hold(slot);

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
    held() {
      return [...byPayer.values()];
    },
    record(slot) {
      hold(slot);
      return Promise.resolve();
    },
    remove(payer) {
      const slot = byPayer.get(payer);
      if (slot !== undefined) {
        byPayer.delete(payer);
        // Only where the label is still this payer's. A slot rewritten at a
        // new label leaves the old one to whoever holds it now, and a removal
        // that took it out would free an address somebody else was granted.
        if (byLabel.get(slot.label) === slot) byLabel.delete(slot.label);
      }
      return Promise.resolve();
    },
  };
}

/**
 * Open the hub's roster in its data directory, reading back whatever it
 * already holds.
 *
 * A hub that restarts still knows who it admitted and when each slot lapses,
 * which is what keeps a reboot from re-admitting broadcasters it is already
 * funding a channel toward.
 *
 * @throws SlotRosterError if the directory or the file cannot be read, or
 * holds something this app cannot recognise as a roster. Fail-closed on
 * purpose: a hub that silently started from an empty roster would re-admit
 * everybody it already holds, front the collateral twice, and lapse nothing
 * it had promised — a state far worse than a hub that did not come up.
 */
export function openSlotRoster(dataDir: string): SlotRoster {
  const path = join(dataDir, ROSTER_FILE);
  const slots = readSlots(path);
  const roster = createSlotRoster(slots);

  return {
    size: roster.size,
    find: roster.find,
    holderOf: roster.holderOf,
    held: roster.held,
    async record(slot) {
      // Memory first, so what is written down is exactly what a reader would
      // be answered; then the file; then, and only then, the caller.
      await roster.record(slot);
      write(path, roster.held());
    },
    async remove(payer) {
      // Nothing held is nothing to write. A sweep that crossed a purchase, or
      // ran twice over the same slot, must not rewrite the file to say what
      // it already says.
      if (roster.find(payer) === undefined) return;
      await roster.remove(payer);
      write(path, roster.held());
    },
  };
}

/** Read a roster off disk, or start an empty one where there is none. */
function readSlots(path: string): Slot[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SlotRosterError(
      `could not read the roster at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SlotRosterError(
      `the roster at ${path} is not readable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const record = parsed as { version?: unknown; slots?: unknown };
  if (record.version !== ROSTER_VERSION || !Array.isArray(record.slots)) {
    throw new SlotRosterError(
      `the roster at ${path} is not a roster this app can read (version ${JSON.stringify(record.version)})`
    );
  }

  return record.slots.map((slot: unknown, index: number) => {
    const {
      payer,
      label,
      lapsesAt,
      stationUrl,
      chain,
      routes,
      channelId,
      collateral,
    } = slot as Record<string, unknown>;
    if (
      typeof payer !== 'string' ||
      typeof label !== 'string' ||
      typeof lapsesAt !== 'number'
    ) {
      throw new SlotRosterError(
        `the roster at ${path} holds something that is not a slot at position ${String(index)}`
      );
    }
    return {
      payer,
      label,
      lapsesAt,
      // The three the hub needs to make good on the slot at boot. Optional,
      // because a slot recorded before they existed is still a slot somebody
      // paid for — but validated where present, on the same fail-closed terms
      // as the rest: half a record is worse than none, since it would be acted
      // on rather than skipped.
      ...(stationUrl === undefined
        ? {}
        : { stationUrl: text(path, index, 'stationUrl', stationUrl) }),
      ...(chain === undefined
        ? {}
        : { chain: text(path, index, 'chain', chain) }),
      ...(routes === undefined
        ? {}
        : { routes: grantedRoutes(path, index, routes) }),
      // And the two that say what the hub funded, on exactly the same terms:
      // optional, because a slot recorded before the buy funded anything is
      // still a slot somebody paid for, and validated where present, because
      // half a record would be acted on rather than skipped.
      ...(channelId === undefined
        ? {}
        : { channelId: text(path, index, 'channelId', channelId) }),
      ...(collateral === undefined
        ? {}
        : { collateral: text(path, index, 'collateral', collateral) }),
    };
  });
}

function text(
  path: string,
  index: number,
  field: string,
  value: unknown
): string {
  if (typeof value !== 'string') {
    throw new SlotRosterError(
      `the roster at ${path} holds a slot at position ${String(index)} whose ${field} is not text`
    );
  }
  return value;
}

/** The granted addresses off one slot, or a refusal to read the roster. */
function grantedRoutes(
  path: string,
  index: number,
  value: unknown
): GrantedRoute[] {
  if (!Array.isArray(value)) {
    throw new SlotRosterError(
      `the roster at ${path} holds a slot at position ${String(index)} whose granted addresses are not a list`
    );
  }
  return value.map((entry: unknown) => {
    const { prefix, price, pricePerKib } = entry as Record<string, unknown>;
    if (typeof prefix !== 'string' || typeof price !== 'string') {
      throw new SlotRosterError(
        `the roster at ${path} holds a slot at position ${String(index)} with an address that names no prefix and price`
      );
    }
    return {
      prefix,
      price,
      ...(pricePerKib === undefined
        ? {}
        : { pricePerKib: text(path, index, 'pricePerKib', pricePerKib) }),
    };
  });
}

/**
 * Write the whole roster down and return only once it is on the disk.
 *
 * Whole rather than appended because a roster is bounded by the hub's own cap
 * — a hundred rows by default — so the simplest thing that cannot leave a
 * half-written row is also fast enough. Written to a temporary name, flushed,
 * and renamed over: a rename is atomic, so a hub that loses power mid-write
 * comes back to the roster it had rather than to half of the one it was
 * writing.
 */
function write(path: string, slots: readonly Slot[]): void {
  const body = JSON.stringify({ version: ROSTER_VERSION, slots }, null, 2);
  const temp = `${path}.writing`;

  try {
    const file = openSync(temp, 'w', 0o600);
    try {
      writeSync(file, body);
      // The flush is the durability. Without it the rename can land while the
      // contents are still only in the page cache, which is exactly the
      // crash a retry is supposed to survive.
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);

    // And the directory, so the rename itself survives. Best-effort: not
    // every platform lets a directory be opened for this, and where it
    // cannot be the file's own flush is still the important half.
    try {
      const dir = openSync(dirOf(path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // A platform that will not flush a directory handle. The roster is
      // already written and flushed; nothing further to do here.
    }
  } catch (error) {
    throw new SlotRosterError(
      `could not write the roster at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}
