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
 *      what was done about it, and they are somebody else's module.
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
 * `src/buy/`, `src/lapse/` and `src/slot-app/` are exempt from the first two
 * rules and only they are — the three places where a slot and a peering meet
 * in one breath. The buy is where a slot is bought and a peering created; the
 * lapse is where a slot ends and the peering behind it is released; the app is
 * where both are wired up. Being the join is exactly why all three are held to
 * rule three like everything else.
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
function offending(text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
}

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
      expect({
        file: file.name,
        lines: offending(file.code, /peer|channel/i),
      }).toEqual({ file: file.name, lines: [] });
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
});
