/**
 * Vocabulary, enforced in the code rather than only in prose.
 *
 * ADR 0003 turns on one distinction: a broadcaster buys a **slot**, and what
 * the hub's operator key creates in response is a **peering**. *"Collapsing
 * those two words in the code is what would turn this into a violation"* of
 * connector ADR 0043 — so this file is the check that they have not been
 * collapsed, and it reads the package's own source to make it.
 *
 * Three rules, each narrower than "don't say the wrong word", because both
 * words legitimately appear in prose that explains the distinction:
 *
 *   1. **The slot's own modules never name a peer in code.** `src/slot/` and
 *      `src/quote/` are about what was bought; the connector's tables are
 *      what was done about it, and they are somebody else's module. There is
 *      **one named identifier exempt from it and no other**, `channelId` —
 *      see {@link COLLATERAL_IN_THE_SLOTS_OWN_MODULES}.
 *   2. **The peering's own modules never name a slot in code.** `src/peering/`
 *      takes no roster, no price and no period — it establishes a peering and
 *      knows nothing about why.
 *   3. **Nothing anywhere fuses the two words into one identifier.** A
 *      `slotPeering`, a `peer_slot` or a `slot-peering` is the collapse ADR
 *      0003 names, whatever it is spelled in.
 *
 * Comments and strings are excluded from the first two rules and included in
 * the third: a module may *explain* the distinction at length, and does, but
 * a fused word is wrong wherever it is written.
 *
 * `src/buy/`, `src/lapse/`, `src/reconcile/` and `src/slot-app/` are exempt
 * from the first two rules and only they are — the four places where a slot
 * and a peering meet in one breath. The buy is where a slot is bought and a
 * peering created; the lapse is where a slot ends and the peering behind it is
 * released; the reconciliation is where the record of the first is made to
 * agree with the table of the second; the app is where all of it is wired up.
 * Being the join is exactly why all four are held to rule three like
 * everything else.
 *
 * And both exemptions are **named rather than inferred**. A directory nobody
 * listed would otherwise be a directory neither of the first two rules
 * reaches, so a new module could quietly become a fifth exemption by
 * existing — the last block pins the set of directories. And the one
 * identifier rule one allows through is pinned the same way, by its own
 * block, so a second one has to be argued for rather than acquired.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package's own `src`, found from this file rather than from a cwd. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts` file the package holds, tests included. */
function sources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A file's code with every comment and string literal blanked out.
 *
 * Scanned rather than regexed: a comment full of apostrophes and a string
 * full of slashes each break the other's pattern, and a guard that reports
 * the wrong thing is worse than no guard.
 */
function code(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const here = source[index];
    const next = source[index + 1];

    if (here === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (here === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      out += ' ';
      continue;
    }
    if (here === "'" || here === '"' || here === '`') {
      const quote = here;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      out += ' ';
      continue;
    }

    out += here;
    index += 1;
  }

  return out;
}

function read(path: string): { code: string; whole: string; name: string } {
  const whole = readFileSync(path, 'utf8');
  return { code: code(whole), whole, name: relative(SRC, path) };
}

/** The lines of `text` matching `pattern`, for a failure worth reading. */
/**
 * The same code with rule one's single allowed identifier struck out, so what
 * is left is what the rule actually applies to.
 */
function exempt(code: string): string {
  return COLLATERAL_IN_THE_SLOTS_OWN_MODULES.reduce(
    (text, allowed) => text.replaceAll(allowed, ''),
    code
  );
}

function offending(text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
}

/**
 * The **only** thing the slot's own modules may name a channel, and the only
 * spelling of it.
 *
 * A slot records the payment channel the hub funded for that broadcaster,
 * because the hub's own capital is in it and nothing else in the app
 * remembers which one: a lapse releases the peering and leaves the deposit
 * where it is (ADR 0003's third amendment), so this is what a reclaim, and a
 * hub operator reading their own roster, would have to act on.
 *
 * That is a real widening of rule one and it is written down here rather than
 * left as a hole in a regular expression. `peer` and `peering` stay banned in
 * `src/slot/` and `src/quote/` outright — the distinction ADR 0003 turns on is
 * untouched — and `channel` is admitted only in this identifier, so a
 * `channelStatus`, a `peerChannel` or a bare `channel` still fails.
 */
const COLLATERAL_IN_THE_SLOTS_OWN_MODULES = ['channelId'];

const files = sources().map(read);

describe('a slot is never a peering, in the code and not only in prose', () => {
  it('finds the package source to check', () => {
    // A guard that silently checked nothing would pass for ever.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((file) => file.name)).toContain('slot/roster.ts');
    expect(files.map((file) => file.name)).toContain('peering/peering.ts');
  });

  it('names no peer in the modules that own the slot', () => {
    const slotSide = files.filter(
      (file) => file.name.startsWith('slot/') || file.name.startsWith('quote/')
    );
    expect(slotSide.length).toBeGreaterThan(3);

    for (const file of slotSide) {
      // The roster records what was BOUGHT. What the hub did about it — a
      // peering, a peer, the payment channel behind it — belongs to the
      // connector's own tables and to the modules that write them. (`route`
      // is not on this list: an HTTP route is Hono's word and means something
      // else entirely.)
      //
      // The one exception is struck out of the text before the rule is
      // applied, rather than punched out of the pattern: what remains of a
      // line is still checked, so `const channelIdentifier = peering.channel`
      // fails on both halves.
      expect({
        file: file.name,
        lines: offending(exempt(file.code), /peer|channel/i),
      }).toEqual({ file: file.name, lines: [] });
    }
  });

  it('lets the slot name exactly one channel, and only where it records one', () => {
    // The allowance is a list of one, asserted here so that adding a second
    // is a change to this file with a reason beside it. Without this, rule one
    // would quietly weaken every time somebody needed a word.
    expect(COLLATERAL_IN_THE_SLOTS_OWN_MODULES).toEqual(['channelId']);

    // And it really is doing something: the rule still bites in those
    // modules on anything else, which is what keeps the exemption an
    // exemption rather than a hole.
    expect(
      offending(exempt('const channelId = read();'), /peer|channel/i)
    ).toEqual([]);
    for (const collapsed of [
      'const channel = read();',
      'const channelStatus = read();',
      'const peerId = read();',
    ]) {
      expect(offending(exempt(collapsed), /peer|channel/i)).toEqual([
        collapsed,
      ]);
    }
  });

  it('names no slot in the module that owns the peering', () => {
    const peeringSide = files.filter((file) =>
      file.name.startsWith('peering/')
    );
    expect(peeringSide.length).toBeGreaterThan(1);

    for (const file of peeringSide) {
      // Establishing a peering takes no roster, no price and no period: it
      // does not know why it is being asked, and must not learn.
      expect({
        file: file.name,
        lines: offending(file.code, /slot|roster/i),
      }).toEqual({ file: file.name, lines: [] });
    }
  });

  it('fuses the two words nowhere at all, in code, comment or log line', () => {
    // Every file but this one, which has to spell what it forbids in order to
    // forbid it.
    for (const file of files.filter(
      (candidate) => candidate.name !== 'slot-app/vocabulary.test.ts'
    )) {
      expect({
        file: file.name,
        lines: offending(
          file.whole,
          /slot[_\- ]?peer|peer(?:ing)?[_\- ]?slot/i
        ),
      }).toEqual({ file: file.name, lines: [] });
    }
  });

  it('gives neither word a file or a directory of the other name', () => {
    for (const file of files) {
      expect(file.name).not.toMatch(/slot[^/]*peer|peer[^/]*slot/i);
    }
  });

  it('holds no module these rules do not reach', () => {
    // Rules one and two are keyed on a directory, so a directory nobody
    // listed is a directory neither of them applies to. The exemption a join
    // module gets is therefore written down here, and a new one has to be
    // added on purpose rather than acquired by being new.
    const listed = new Set([
      // The slot's own side: no peer, no channel.
      'slot',
      'quote',
      // The peering's own side: no slot, no roster.
      'peering',
      // The joins, exempt from both and held to rule three like everything
      // else: where a slot is bought and a peering created, where a slot ends
      // and its peering is released, where the record of the one is made to
      // agree with the table of the other, and where all of it is wired up.
      'buy',
      'lapse',
      'reconcile',
      'slot-app',
      // Neither side: signing a write, and reading a mounted credential.
      'operator',
    ]);

    const directories = new Set(
      files
        .map((file) => file.name)
        .filter((name) => name.includes('/'))
        .map((name) => name.slice(0, name.indexOf('/')))
    );

    expect([...directories].sort()).toEqual([...listed].sort());
  });
});
