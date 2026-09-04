/**
 * The roster: who holds a slot on this hub, and until when.
 *
 * A **slot** is the routing-table entry a broadcaster bought. It is not a
 * **peering** — the peering is what the hub's operator key creates in
 * response to the purchase, and it is named for that wherever it appears
 * (ADR 0003). Nothing in this module mentions a peering, a peer, a channel or
 * a route: the roster records what was *bought*, and the connector's own
 * tables record what was *done about it*.
 *
 * Four questions and one answer, which is the whole surface:
 *
 *   - how many slots are held, which is what the cap is measured against;
 *   - whether this caller holds one, and when it lapses;
 *   - whether a candidate label is already somebody's, which is what makes
 *     handle derivation lengthen rather than collide;
 *   - and, from the buy onward, `record` — one slot, written down.
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
    record(slot) {
      hold(slot);
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

  // What gets serialized, keyed the way a slot is identified. Kept here
  // rather than read back off the roster because enumerating is not one of
  // the questions the interface answers, and adding one so that persistence
  // could be implemented would put this file's needs into everybody's read
  // surface.
  const written = new Map(slots.map((slot) => [slot.payer, slot]));

  return {
    size: roster.size,
    find: roster.find,
    holderOf: roster.holderOf,
    async record(slot) {
      // Memory first, so what is written down is exactly what a reader would
      // be answered; then the file; then, and only then, the caller.
      await roster.record(slot);
      written.set(slot.payer, slot);
      write(path, [...written.values()]);
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
    const { payer, label, lapsesAt } = slot as Record<string, unknown>;
    if (
      typeof payer !== 'string' ||
      typeof label !== 'string' ||
      typeof lapsesAt !== 'number'
    ) {
      throw new SlotRosterError(
        `the roster at ${path} holds something that is not a slot at position ${String(index)}`
      );
    }
    return { payer, label, lapsesAt };
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
