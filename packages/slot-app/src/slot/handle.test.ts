/**
 * The collision that must never turn a broadcaster away.
 *
 * **Why this one file is not a boundary test, when every other suite in this
 * repo is.** The rule this repository holds itself to is that assertions are
 * made over HTTP against a real app, and `../quote/quote.test.ts` is where
 * handles are asserted that way: two payers, two prefixes, the same payer
 * twice, the same prefix. It never learns how a handle is derived.
 *
 * What it cannot reach is the collision. A label is taken only when a slot
 * holds it, a slot is written only by the buy (#35), and until that exists no
 * sequence of paid requests can put two payers on one label. Past that, the
 * event needs two twelve-hex-character digests to agree — a coin flip somewhere
 * past a million admitted stations, which is not a thing a suite arranges by
 * asking nicely either.
 *
 * So the choice is between testing the lengthening directly and not testing
 * it, and not testing it is the wrong answer for this particular path. It is
 * the path that decides whether the design's central claim — **there is no
 * "that handle is taken" refusal** — is true or merely intended, and it is the
 * one path in the app that will run for the first time in production, on a
 * real hub, on a broadcaster who paid. ADR 0003's amendment says why a refusal
 * there would be a refusal somebody was charged for.
 *
 * The seam taken is the narrowest available: `deriveHandleLabel` is a pure
 * function of a payer key and a predicate, so the roster's shape, the app's
 * wiring and the quote's response are all still free to change without
 * touching this file. Nothing here asserts what a specific key hashes to —
 * a digest is not a promise to anybody — only the properties a broadcaster
 * actually depends on.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  HANDLE_LABEL_HEX_LENGTH,
  HandleDerivationError,
  deriveHandleLabel,
  grantedPrefix,
  readPayerKey,
} from './handle.js';

/** A payer key shaped the way a terminating connector states one. */
function evmPayer(): string {
  const hex = randomUUID().replaceAll('-', '').repeat(2);
  return `evm:0x${hex}`;
}

/** Nothing is taken — the ordinary case, on a hub with room. */
const nothingTaken = () => false;

describe('the handle a hub derives from the payer it verified', () => {
  it('gives the same payer the same label, every time', () => {
    const payer = evmPayer();

    const labels = new Set(
      Array.from({ length: 25 }, () => deriveHandleLabel(payer, nothingTaken))
    );

    // "The address I printed on my broadcaster page keeps working" is this
    // property and nothing else.
    expect(labels.size).toBe(1);
  });

  it('gives different payers different labels', () => {
    const labels = new Set(
      Array.from({ length: 500 }, () =>
        deriveHandleLabel(evmPayer(), nothingTaken)
      )
    );

    expect(labels.size).toBe(500);
  });

  it('grants a label that can be written into an ILP address', () => {
    const label = deriveHandleLabel(evmPayer(), nothingTaken);

    // A broadcaster types this into their own connector.toml. A character an
    // ILP address cannot carry would be discovered at their first packet.
    expect(label).toMatch(/^[a-zA-Z0-9_~-]+$/);
    expect(label).toHaveLength(HANDLE_LABEL_HEX_LENGTH);
    expect(grantedPrefix('g.toon.slopmachine', label)).toBe(
      `g.toon.slopmachine.${label}`
    );
  });
});

describe('a label collision lengthens, and refuses nobody', () => {
  it('lengthens past a label somebody else holds', () => {
    const payer = evmPayer();
    const first = deriveHandleLabel(payer, nothingTaken);

    // Now somebody holds it. The design's whole claim is that this is not a
    // refusal — the second broadcaster is admitted at a longer label.
    const second = deriveHandleLabel(payer, (label) => label === first);

    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(first.length);
    // Lengthened along the same derivation rather than re-rolled, so the
    // handle a broadcaster ends up with is still visibly theirs.
    expect(second.startsWith(first)).toBe(true);
  });

  it('keeps lengthening while each candidate in turn is held', () => {
    const payer = evmPayer();
    const held = new Set<string>();

    // Four collisions in a row — an event that has never happened and never
    // will, and which still has to end in a granted handle rather than a
    // paid refusal.
    for (let round = 0; round < 5; round += 1) {
      const label = deriveHandleLabel(payer, (candidate) =>
        held.has(candidate)
      );
      expect(held.has(label)).toBe(false);
      held.add(label);
    }

    expect(held.size).toBe(5);
    // Deterministic: the same roster state always produces the same answer,
    // so a broadcaster who lengthened once does not drift further on a retry.
    const takenSoFar = new Set(held);
    takenSoFar.delete([...held].at(-1) as string);
    expect(deriveHandleLabel(payer, (c) => takenSoFar.has(c))).toBe(
      [...held].at(-1)
    );
  });

  it('still admits a caller when the whole digest is held', () => {
    // Past the full 64-character digest there is nothing left to lengthen
    // with, which takes a SHA-256 collision to reach. Even there the answer is
    // a handle, because a refusal at a paid address is what this must never
    // become.
    const label = deriveHandleLabel(
      evmPayer(),
      (candidate) => candidate.length <= 64
    );

    expect(label.length).toBeGreaterThan(64);
    expect(label).toMatch(/^[a-f0-9]{64}-\d+$/);
  });

  it('gives up only when literally every candidate is held', () => {
    // The bound exists so the loop is finite, not because anything reaches it.
    expect(() => deriveHandleLabel(evmPayer(), () => true)).toThrow(
      HandleDerivationError
    );
  });
});

describe('the payer a terminating connector stated', () => {
  it('reads the stated key exactly, past the whitespace a header may carry', () => {
    const payer = evmPayer();

    expect(readPayerKey(payer)).toBe(payer);
    expect(readPayerKey(`  ${payer}  `)).toBe(payer);
    // Not re-canonicalised: the connector states one canonical form already,
    // and a second opinion here is how one broadcaster ends up with two
    // handles the day the two spellings disagree.
    expect(readPayerKey(payer.toUpperCase())).toBe(payer.toUpperCase());
  });

  it('reads nothing where nothing was stated', () => {
    // Absent means the request did not arrive through a paid termination this
    // connector verified — never that a caller left a field out.
    for (const stated of [undefined, null, '', '   ']) {
      expect(readPayerKey(stated)).toBeUndefined();
    }
  });
});
