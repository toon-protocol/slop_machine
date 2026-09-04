/**
 * Proves an operator's key material cannot reach the origin's build context or
 * its published image — by planting dummy key material where `deploy/README.md`
 * tells a broadcaster to generate the real thing, and then building.
 *
 * WHY THIS IS NOT IN `pnpm test`. It needs a Docker daemon and it builds
 * images; the origin's own image installs ffmpeg and two dependency trees, so
 * a full run is minutes rather than seconds. It runs on its own:
 *
 *     pnpm test:image
 *
 * `deploy/bundle.test.ts` carries the fast half — that `.dockerignore` still
 * names the patterns — so the everyday suite keeps a guard that needs no
 * daemon. This file is what makes that list more than a list: it is the only
 * thing here that asks Docker itself what it excluded.
 *
 * TWO LINES OF DEFENCE, ONE TEST EACH, IN THIS ORDER:
 *
 *  1. THE BUILD CONTEXT. `docker-compose.local.yml` builds the origin with
 *     `context: ..`, so every key an operator generates in `deploy/` — the
 *     stream key, the RTMPS private key, the connector's signer and settlement
 *     keys — is inside the directory handed to the daemon. `.dockerignore` is
 *     what keeps them out of it, and this test removes the argument by
 *     building a probe image that copies the WHOLE context and looking at what
 *     arrived. Delete the key-material patterns from `.dockerignore` and this
 *     test fails.
 *
 *  2. THE IMAGE. The end of user story 30 of #3: the key is in no published
 *     image. Today the origin's Dockerfile COPYs an explicit path list naming
 *     neither `deploy/` nor the context root, so this holds by that list AND by
 *     `.dockerignore` — which is the point of defence in depth, and also why
 *     breaking one of the two alone leaves this test passing. Break both — a
 *     `COPY . .` with the ignore rules gone, which is exactly how a Dockerfile
 *     gets shortened — and it fails.
 *
 * The planted files are dummies containing a canary string and nothing else,
 * every one of them matches a `.gitignore` rule (the first test asserts that,
 * so a crashed run cannot leave something committable behind), and they are
 * removed again in `afterAll`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The origin's Dockerfile, built from the repo root — as the bundle builds it. */
const ORIGIN_DOCKERFILE_PATH = 'packages/station-origin/Dockerfile';

/**
 * The string every planted dummy carries. Distinctive enough that a match
 * anywhere is a planted file and never a coincidence in a dependency.
 */
const CANARY_PREFIX = 'TOON-SLOP-MACHINE-KEY-CANARY';

/**
 * The whole canary, prefix and all, as an expression `grep -E` understands.
 * It must match the SUFFIX too: `grep -o` prints the matched text and nothing
 * else, so a pattern of only the shared prefix would report every planted file
 * as the same unidentifiable match.
 */
const CANARY_PATTERN = `${CANARY_PREFIX}-[0-9a-f]+`;

/**
 * Unique per run, so a leftover image from a previous run cannot answer for
 * this one.
 */
const RUN_ID = randomBytes(6).toString('hex');
const PROBE_TAG = `slop-machine-build-context-probe:${RUN_ID}`;
const ORIGIN_TAG = `slop-machine-origin-image-secrets:${RUN_ID}`;

/**
 * A probe image whose whole job is to hold the build context as the daemon
 * assembled it. `COPY . /ctx` is the thing `.dockerignore` filters, so what
 * lands in /ctx IS the context, with no Dockerfile path list standing in front
 * of it. Written to a scratch directory outside the context and never into
 * the repository — a Dockerfile with a `COPY . .` in it is not a file this
 * repo should carry, and one inside the context would be part of what it
 * measures.
 */
const PROBE_DOCKERFILE = ['FROM node:22-alpine', 'COPY . /ctx', ''].join('\n');

/** Scratch outside the build context: the probe Dockerfile and the exported image. */
let scratch = '';

/**
 * The key material an operator following `deploy/README.md` has beside the
 * bundle, one file per ignore pattern it is meant to be caught by. `deploy/`
 * is where the README's own `openssl` lines write them; the context root is
 * checked too because a `.dockerignore` pattern with no slash in it matches
 * THERE ONLY, which is the mistake the leading globstars exist to avoid.
 */
const PLANTED_KEY_MATERIAL: { path: string; what: string }[] = [
  {
    path: 'deploy/stream.key',
    what: "the broadcaster's stream key — README.md writes it exactly here",
  },
  {
    path: 'deploy/ingest-tls.key',
    what: 'the private half of the RTMPS certificate',
  },
  {
    path: 'stream.key',
    what: 'a stream key at the context root, where a bare `*.key` would catch it',
  },
  {
    path: 'deploy/settlement.pem',
    what: 'a settlement key in PEM form — this one holds value',
  },
  { path: 'deploy/peering.secret', what: 'a peering secret' },
  {
    path: 'deploy/operator-bearer.token',
    what: "the operator surface's bearer token",
  },
  {
    path: 'deploy/operator-write.keys',
    what: 'the operator write-key allowlist — public halves, but per box',
  },
  {
    path: 'deploy/operator.allow',
    what: 'an allowlist under the other name it is written by',
  },
  {
    path: 'deploy/ingest-tls.crt',
    what: 'the public half of the RTMPS certificate — per box, per hostname',
  },
  { path: 'deploy/solana-keypair.json', what: 'a chain keypair' },
  { path: 'deploy/settlement-wallet.json', what: 'a wallet file' },
  {
    path: 'deploy/.env',
    what: "the operator's environment file, which names every path above",
  },
  {
    path: 'deploy/.env.bak-20260718',
    what: 'the point-in-time copy of it that a live-box edit leaves behind',
  },
];

/** `path` → the canary its dummy contents carry. Filled in by `beforeAll`. */
const canaryOf = new Map<string, string>();

/** The planted path a canary belongs to. */
function plantedPathOf(canary: string): string {
  for (const [path, planted] of canaryOf) if (planted === canary) return path;
  return `an unrecognised canary (${canary})`;
}

/** Every planted path whose canary appears in `haystack`, named as a path. */
function leaksIn(haystack: string): string[] {
  return [...canaryOf]
    .filter(([, canary]) => haystack.includes(canary))
    .map(([path]) => path)
    .concat(
      // A canary this run did not plant would mean the matcher and the
      // planting have drifted apart; say so rather than pass.
      (haystack.match(new RegExp(CANARY_PATTERN, 'g')) ?? [])
        .filter((found) => ![...canaryOf.values()].includes(found))
        .map(plantedPathOf)
    );
}

const execFileAsync = promisify(execFile);

/**
 * Awaited rather than synchronous: an image build holds this process for
 * minutes, and a `*Sync` call that long starves vitest's own reporting.
 */
async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${failure.stderr ?? ''}${failure.stdout ?? ''}`
    );
  }
}

describe('operator key material and the origin image', () => {
  beforeAll(async () => {
    try {
      await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    } catch (error) {
      throw new Error(
        `this suite builds real images and needs a reachable Docker daemon — it is deliberately not part of \`pnpm test\` for that reason. ${String(error)}`
      );
    }

    // A file that is already there is an operator's real key, not this
    // suite's dummy, and `afterAll` would delete it.
    for (const { path } of PLANTED_KEY_MATERIAL) {
      if (existsSync(resolve(REPO_ROOT, path))) {
        throw new Error(
          `${path} already exists — this suite plants a dummy there and removes it afterwards, and it will not overwrite a real key. Move it aside and re-run.`
        );
      }
    }

    for (const { path } of PLANTED_KEY_MATERIAL) {
      const canary = `${CANARY_PREFIX}-${randomBytes(16).toString('hex')}`;
      canaryOf.set(path, canary);
      writeFileSync(resolve(REPO_ROOT, path), `${canary}\n`, { mode: 0o600 });
    }

    scratch = mkdtempSync(join(tmpdir(), 'slop-machine-image-'));
    writeFileSync(join(scratch, 'Dockerfile'), PROBE_DOCKERFILE);
  });

  afterAll(async () => {
    for (const { path } of PLANTED_KEY_MATERIAL) {
      rmSync(resolve(REPO_ROOT, path), { force: true });
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    for (const tag of [PROBE_TAG, ORIGIN_TAG]) {
      try {
        await run('docker', ['image', 'rm', '-f', tag]);
      } catch {
        // An image that was never built is not a cleanup failure.
      }
    }
  });

  it('plants only key material this repository already refuses to commit', async () => {
    // This suite writes key-shaped files into a working tree, so the first
    // thing it proves is that a crash between planting and cleanup cannot put
    // one in a commit. `git check-ignore` answers from the real rules, so a
    // weakened `.gitignore` fails here too.
    for (const { path, what } of PLANTED_KEY_MATERIAL) {
      let ignored: boolean;
      try {
        await run('git', ['check-ignore', '--quiet', '--no-index', path]);
        ignored = true;
      } catch {
        ignored = false;
      }

      expect(
        ignored,
        `${path} (${what}) is not gitignored — either a .gitignore rule was weakened, or this suite is about to plant a file an operator's \`git add -A\` could commit to a public repository. Fix the rule; do not stop planting the file.`
      ).toBe(true);
    }
  });

  it('keeps key material out of the build context Docker assembles', async () => {
    // The context is what `.dockerignore` governs, and it governs it for every
    // Dockerfile at once — including one written later that copies more than
    // today's does.
    await run('docker', [
      'build',
      // `--load` because a buildx builder on the container driver — what CI
      // sets up — otherwise discards the image instead of handing it to the
      // daemon this test then runs. It is accepted and ignored by the
      // ordinary builder.
      '--load',
      '--no-cache',
      '-f',
      join(scratch, 'Dockerfile'),
      '-t',
      PROBE_TAG,
      '.',
    ]);

    const inContext = await run('docker', [
      'run',
      '--rm',
      PROBE_TAG,
      'sh',
      '-c',
      `grep -r -a -o -h -E -e '${CANARY_PATTERN}' /ctx || true`,
    ]);
    const leaked = leaksIn(inContext);

    expect(
      leaked,
      `the build context carries ${JSON.stringify(leaked)}. \`docker-compose.local.yml\` builds with \`context: ..\`, so anything the daemon receives is one \`COPY . .\` away from a published image. Restore the key-material patterns in .dockerignore — and note that a bare \`*.key\` there matches the context root only, which is why each is written \`**/*.key\`.`
    ).toEqual([]);

    // The context has to still contain what the image is built FROM, or this
    // test would pass just as well on an empty one.
    const present = await run('docker', [
      'run',
      '--rm',
      PROBE_TAG,
      'sh',
      '-c',
      'ls /ctx/pnpm-lock.yaml /ctx/packages/station-origin/src/origin/origin.ts',
    ]);
    expect(
      present,
      '.dockerignore now excludes the origin source or the lockfile — the build context has to hold what the image is built from'
    ).toContain('origin.ts');
  });

  it('publishes no image containing key material', async () => {
    // Built the way CLAUDE.md and the Dockerfile's own header say to build it:
    // from the repo root, with an operator's keys sitting beside the bundle.
    await run('docker', [
      'build',
      '--load',
      '-f',
      ORIGIN_DOCKERFILE_PATH,
      '-t',
      ORIGIN_TAG,
      '.',
    ]);

    // `docker export` flattens the image to the filesystem a container of it
    // starts with — every byte the image actually ships, whichever layer put
    // it there and whatever it ended up named. Grepping that asks the question
    // user story 30 asks: is the operator's key in the image?
    const filesystemTar = join(scratch, 'origin-filesystem.tar');
    const container = (await run('docker', ['create', ORIGIN_TAG])).trim();
    let inFilesystem: string[];
    try {
      await run('docker', ['export', '--output', filesystemTar, container]);
      inFilesystem = leaksIn(
        await run('sh', [
          '-c',
          `grep -a -o -h -E -e '${CANARY_PATTERN}' ${filesystemTar} || true`,
        ])
      );
    } finally {
      await run('docker', ['rm', '-f', container]);
      rmSync(filesystemTar, { force: true });
    }

    expect(
      inFilesystem,
      `the origin image ships ${JSON.stringify(inFilesystem)}. A published station-origin image is public: a stream key in one is a station anybody can broadcast on, and a settlement key in one moves money. The Dockerfile COPYs an explicit path list for this reason — do not replace it with a whole-directory copy.`
    ).toEqual([]);

    // A key does not have to be in the filesystem to be in the image: a build
    // argument or an ENV is carried in the image's own metadata, which anyone
    // who pulls it can read back without ever running it.
    const inMetadata = leaksIn(
      (await run('docker', ['history', '--no-trunc', ORIGIN_TAG])) +
        (await run('docker', ['image', 'inspect', ORIGIN_TAG]))
    );

    expect(
      inMetadata,
      `the origin image's metadata names ${JSON.stringify(inMetadata)} — an ARG or ENV is readable from a pulled image without running it`
    ).toEqual([]);
  });
});
