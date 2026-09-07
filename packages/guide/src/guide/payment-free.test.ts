/**
 * The guide is payment-free, enforced in the suite rather than only in prose.
 *
 * The repo's oldest invariant — **no app in this repo contains payment
 * code** — reaches the guide with extra force: it is a browser SPA, and no
 * part of the paying client can be a web app, ever. A page that could pay is
 * a page any other page could trick into paying, so the guide must never
 * hold a payer dependency, key material, or payment vocabulary — not "not
 * yet", but *by test*, so review is not what stands between a convenient
 * import and a spending browser.
 *
 * Three rules, in the style of the slot app's vocabulary test — this file
 * reads the package's own source and manifest to make them:
 *
 *   1. **The manifest names no payer and no key tooling.** Every dependency
 *      of every kind is checked against a denylist pinned below, each entry
 *      with its reason beside it.
 *   2. **The source names no payment surface and handles no key material.**
 *      The attribution headers, settlement, ILP itself, and the identifiers
 *      key handling cannot be written without.
 *   3. **The word "channel" appears nowhere at all.** Here a channel is
 *      always a payment channel — the collision CONTEXT.md calls expensive —
 *      and a payment-free page has nothing to say about one, in code,
 *      comment or copy. The banned copy words ride along: a viber vibes,
 *      never watches or listens, and a clip is never a VOD.
 *
 * This file is the one exemption from rules two and three, because it has to
 * spell what it forbids in order to forbid it — and each pattern is asserted
 * to bite on a sample, so an exemption can never quietly become a hole.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package's own `src`, found from this file rather than from a cwd. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The package root, where the manifest and the page shell live. */
const ROOT = join(SRC, '..');

/**
 * Dependencies the guide may never hold, each with the reason it is here.
 * A `name` entry matches that dependency exactly; a `prefix` entry matches
 * every dependency under it. Pinned by its own assertion below, so widening
 * or narrowing this list is a change to this file with a reason beside it.
 */
const FORBIDDEN_DEPENDENCIES: {
  match: string;
  kind: 'name' | 'prefix';
  why: string;
}[] = [
  {
    match: 'toon-client',
    kind: 'name',
    why: 'the payer itself — the devnet-only dependency no package may hold',
  },
  {
    match: '@toon-protocol/client',
    kind: 'name',
    why: "the payer's published name",
  },
  {
    match: 'viem',
    kind: 'name',
    why: 'a chain client is settlement tooling, and settlement holds value',
  },
  {
    match: 'ethers',
    kind: 'name',
    why: 'a chain client is settlement tooling, and settlement holds value',
  },
  {
    match: 'web3',
    kind: 'name',
    why: 'a chain client is settlement tooling, and settlement holds value',
  },
  {
    match: '@noble/',
    kind: 'prefix',
    why: 'signing curves are how key material gets handled',
  },
  {
    match: '@scure/',
    kind: 'prefix',
    why: 'key derivation and mnemonics are key material outright',
  },
  {
    match: '@interledger/',
    kind: 'prefix',
    why: 'an ILP stack is payment code by definition',
  },
  {
    match: 'ilp-',
    kind: 'prefix',
    why: 'an ILP stack is payment code by definition',
  },
];

/**
 * Patterns no guide source may match, each with the reason. Applied to the
 * whole file — code, comments and copy alike — because a payment surface
 * explained is a payment surface planned, and banned copy is banned wherever
 * it would render.
 */
const FORBIDDEN_IN_SOURCE: { pattern: RegExp; why: string }[] = [
  {
    pattern: /channel/i,
    why: 'a channel is always a payment channel here, and a payment-free page has nothing to say about one',
  },
  {
    pattern: /x-toon-/i,
    why: 'the attribution headers are the paid termination talking, and nothing paid terminates in a browser',
  },
  {
    pattern: /settlement|interledger|\bilp\b/i,
    why: 'settlement and ILP are the connector business the guide must not know exists',
  },
  {
    pattern:
      /private[_\s-]?key|secret[_\s-]?key|mnemonic|keystore|key[_\s-]?pair/i,
    why: 'key material is never handled in a browser, and these are the identifiers handling it cannot be written without',
  },
  {
    pattern: /\bwatch(es|ed|ing)?\b|\blisten(s|ed|ing|er|ers)?\b/i,
    why: 'a viber vibes — the canonical verb, never watching or listening',
  },
  {
    pattern: /\bvod\b/i,
    why: 'a finished piece of vibes is a clip, never a VOD',
  },
];

/** Every source file the package holds: `src/**` plus the page shell. */
function sources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

function read(path: string): { whole: string; name: string } {
  return { whole: readFileSync(path, 'utf8'), name: relative(ROOT, path) };
}

/** The lines of `text` matching `pattern`, for a failure worth reading. */
function offending(text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
}

const files = [...sources().map(read), read(join(ROOT, 'index.html'))].filter(
  (file) => file.name !== 'src/guide/payment-free.test.ts'
);

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
) as {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const dependencyNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
];

function forbidding(name: string): string | null {
  for (const rule of FORBIDDEN_DEPENDENCIES) {
    if (rule.kind === 'name' && name === rule.match) return rule.why;
    if (rule.kind === 'prefix' && name.startsWith(rule.match)) return rule.why;
  }
  return null;
}

describe('the guide is payment-free, by test and not only by review', () => {
  it('finds the package source to check', () => {
    // A guard that silently checked nothing would pass for ever.
    expect(files.length).toBeGreaterThan(8);
    expect(files.map((file) => file.name)).toContain('src/shell/shell.tsx');
    expect(files.map((file) => file.name)).toContain(
      'src/routes/broadcaster-page.tsx'
    );
    expect(files.map((file) => file.name)).toContain('index.html');
    // And it really is reading the manifest it claims to.
    expect(manifest.name).toBe('@toon-protocol/guide');
    expect(dependencyNames).toContain('react');
  });

  it('holds no payer dependency and no key tooling, of any dependency kind', () => {
    const violations = dependencyNames
      .map((name) => ({ name, why: forbidding(name) }))
      .filter((entry) => entry.why !== null);
    expect(violations).toEqual([]);
  });

  it('pins the denylist, so widening or narrowing it is a change made on purpose', () => {
    expect(
      FORBIDDEN_DEPENDENCIES.map((rule) => `${rule.kind}:${rule.match}`)
    ).toEqual([
      'name:toon-client',
      'name:@toon-protocol/client',
      'name:viem',
      'name:ethers',
      'name:web3',
      'prefix:@noble/',
      'prefix:@scure/',
      'prefix:@interledger/',
      'prefix:ilp-',
    ]);

    // And every rule really bites: a manifest naming any of these fails.
    expect(forbidding('toon-client')).not.toBeNull();
    expect(forbidding('@toon-protocol/client')).not.toBeNull();
    expect(forbidding('viem')).not.toBeNull();
    expect(forbidding('@noble/curves')).not.toBeNull();
    expect(forbidding('@scure/bip39')).not.toBeNull();
    expect(forbidding('@interledger/pay')).not.toBeNull();
    expect(forbidding('ilp-packet')).not.toBeNull();
    // While the ordinary UI toolchain passes.
    expect(forbidding('react')).toBeNull();
    expect(forbidding('tailwindcss')).toBeNull();
  });

  it('names no payment surface, no key material and no banned word in any source', () => {
    for (const file of files) {
      for (const rule of FORBIDDEN_IN_SOURCE) {
        expect({
          file: file.name,
          why: rule.why,
          lines: offending(file.whole, rule.pattern),
        }).toEqual({ file: file.name, why: rule.why, lines: [] });
      }
    }
  });

  it('bites on what it forbids, so an exemption is never a hole', () => {
    // One offending sample per pattern, checked through the same matcher the
    // rule uses — a pattern that matched nothing would guard nothing.
    const samples = [
      'const channelId = open();',
      "headers.get('X-TOON-Amount')",
      'import { settle } from "settlement";',
      'the ilp address of the station',
      'const privateKey = load();',
      'a viber watching a station',
      'listeners tune in nightly',
      'play the VOD later',
    ];
    const caught = samples.filter((sample) =>
      FORBIDDEN_IN_SOURCE.some((rule) => rule.pattern.test(sample))
    );
    expect(caught).toEqual(samples);
  });

  it('is never published: the payment-free claim ships as static output only', () => {
    // The guide is a page a hub hosts, not a library anybody imports — and a
    // private package cannot end up on a registry by a stray publish.
    expect(manifest.private).toBe(true);
  });
});
