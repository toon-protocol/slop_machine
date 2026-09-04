/**
 * The origin integration suite — the one real seam.
 *
 * It boots the real app on fresh ports against a temporary directory, pushes a
 * few seconds of synthetic RTMP at the real ingest port — a generated test
 * picture and a tone, exactly what a broadcaster's software would send — and
 * then asserts **entirely over plain HTTP**, on what a viber could observe.
 *
 * Nothing here reaches inside the segmenter, the `ffmpeg` argument
 * construction, or the on-disk layout. All three must stay rewritable without
 * touching this file, so the only things it knows are the address shape, the
 * rung it configured, and the bytes that come back.
 *
 * The suite is deliberately slow, because real encoding is the point:
 * [ADR 0001](../../../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)
 * is a claim about bytes, and a mocked segmenter cannot falsify it. Every
 * expected value is written here as a literal rather than read back out of the
 * code under test, so a broken bound fails instead of quietly agreeing with
 * itself.
 *
 * `ffmpeg` and `ffprobe` must be on PATH.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOrigin } from '../origin/origin.js';
import type { OriginConfig, OriginInstance } from '../origin/origin.js';

/**
 * The rung the suite runs, which is ordinary configuration and nothing else. A
 * small one: the point of the suite is that the bytes are real, not that they
 * are pretty, and a broadcaster's four-rung ladder would cost minutes per run.
 */
const RUNG = {
  name: 'small',
  height: 360,
  videoBitrate: 500_000,
  audioBitrate: 64_000,
} as const;

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/**
 * ADR 0001's bound, written out rather than imported: a segment is at most
 * 2 MiB, so that a station keeps working if the connector ever caps the
 * response direction the way it already caps requests.
 */
const SEGMENT_BYTE_BUDGET = 2 * 1024 * 1024;

/**
 * The bound the suite's own rung claims, from the arithmetic that makes the
 * cap meaningful — a hard maximum bitrate over a fixed duration, plus the one
 * second of encoder buffer the cap smooths over, plus audio:
 *
 *   (500 000 × 2 + 500 000 + 64 000 × 2) ÷ 8 = 203 500 bytes
 *
 * with a fifth again allowed for MPEG-TS packetisation, which is carriage
 * rather than picture. A segment over this is an encoder that treated its cap
 * as an average, which is exactly what ADR 0001 forbids.
 */
const RUNG_WORST_CASE_BYTES = Math.ceil(203_500 * 1.2);

/** How long a broadcast the suite pushes, in seconds. */
const BROADCAST_SECONDS = 10;

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** The one station the read-side assertions share, broadcast to once. */
let station: OriginInstance;
/** The sequence numbers that station actually served, in order. */
let served: number[];

beforeAll(async () => {
  station = await boot();
  await publish({ origin: station, streamKey: keyOf(station) });
  await waitForSegment(station, RUNG.name, 2);
  served = await servedSequences(station, RUNG.name);
}, 180_000);

afterEach(async () => {
  for (const origin of running.splice(0)) {
    if (origin === station) continue;
    await origin.stop();
  }
});

afterAll(async () => {
  await station.stop();
  for (const origin of running.splice(0)) await origin.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Booting and broadcasting, the way production does ----------

const keys = new WeakMap<OriginInstance, string>();

function keyOf(origin: OriginInstance): string {
  const key = keys.get(origin);
  if (key === undefined) throw new Error('that station was not booted here');
  return key;
}

/** A temporary directory removed when the suite finishes. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-segments-'));
  tempDirs.push(dir);
  return dir;
}

/** Boot a real origin on fresh ports against a temporary directory. */
async function boot(
  config: Partial<OriginConfig> = {}
): Promise<OriginInstance> {
  // A throwaway key, fresh per station. No stream key literal belongs in this
  // repo, not even a test's.
  const streamKey = `test-station-key-${randomUUID()}`;
  const origin = await startOrigin({
    segmentPort: 0,
    ingestPort: 0,
    host: '127.0.0.1',
    ingestHost: '127.0.0.1',
    dataDir: freshDir(),
    streamKey,
    rung: { ...RUNG },
    segmentSeconds: SEGMENT_SECONDS,
    ...config,
  });
  keys.set(origin, streamKey);
  running.push(origin);
  return origin;
}

/**
 * Publish a short generated broadcast at a station, exactly as a broadcaster's
 * software would: a URL, a stream key as the stream name, and nothing else.
 */
function publish(options: {
  origin: OriginInstance;
  streamKey: string;
  seconds?: number;
}): Promise<{ code: number | null; output: string }> {
  const { origin, streamKey, seconds = BROADCAST_SECONDS } = options;
  const url = `rtmp://127.0.0.1:${String(origin.config.ingestPort)}/live/${streamKey}`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=640x480:rate=25:duration=${String(seconds)}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '1200k',
    '-g',
    '25',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-t',
    String(seconds),
    '-f',
    'flv',
    url,
  ];

  return new Promise((resolvePublish) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolvePublish({ code, output }));
  });
}

// ---------- Speaking to the station over plain HTTP ----------

function segmentUrl(
  origin: OriginInstance,
  rung: string,
  sequence: number
): string {
  return `http://127.0.0.1:${String(origin.config.segmentPort)}/segments/${rung}/${String(sequence)}.ts`;
}

function get(
  origin: OriginInstance,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${String(origin.config.segmentPort)}${path}`,
    init
  );
}

/** Wait until a station is holding a sequence number, or give up loudly. */
async function waitForSegment(
  origin: OriginInstance,
  rung: string,
  sequence: number,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(segmentUrl(origin, rung, sequence));
    await res.arrayBuffer();
    if (res.status === 200) return;
    if (Date.now() > deadline) {
      throw new Error(
        `the station never served ${rung}/${String(sequence)} (last status ${String(res.status)})`
      );
    }
    await new Promise((tick) => setTimeout(tick, 200));
  }
}

/** Every sequence number a station will serve, walked from the beginning. */
async function servedSequences(
  origin: OriginInstance,
  rung: string
): Promise<number[]> {
  const found: number[] = [];
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const res = await fetch(segmentUrl(origin, rung, sequence));
    await res.arrayBuffer();
    if (res.status !== 200) break;
    found.push(sequence);
  }
  return found;
}

/** What `ffprobe` makes of a served segment, treated as a whole file. */
function probe(body: Buffer): string {
  const file = join(freshDir(), 'segment.ts');
  writeFileSync(file, body);
  return execFileSync(
    'ffprobe',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_entries',
      'format=format_name,duration',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'default=nw=1',
      file,
    ],
    { encoding: 'utf8' }
  );
}

// ---------- The tests ----------

describe('a broadcast, cut into segments', () => {
  it('is served at an address carrying its rung and its sequence number', async () => {
    // A ten-second broadcast at two-second segments is several spans, each at
    // its own address beneath its rung's prefix.
    expect(served.length).toBeGreaterThanOrEqual(3);
    expect(served).toEqual(served.map((_, index) => index));

    for (const sequence of served) {
      const res = await fetch(segmentUrl(station, RUNG.name, sequence));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('video/mp2t');
      // A segment was paid for by whoever pulled it; nothing invites a cache
      // to hand it on for free.
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  it('serves the rung and the fixed duration it was configured with', () => {
    expect(station.config.rungs).toEqual([RUNG.name]);
    expect(station.config.segmentSeconds).toBe(SEGMENT_SECONDS);
  });

  it('serves playable spans, not empty or truncated files', async () => {
    for (const sequence of served.slice(0, 3)) {
      const res = await fetch(segmentUrl(station, RUNG.name, sequence));
      const body = Buffer.from(await res.arrayBuffer());

      // Probed as a whole file rather than inspected byte by byte: what
      // matters is that a viber's player can decode what it paid for.
      const probed = probe(body);
      expect(probed).toMatch(/format_name=mpegts/);
      expect(probed).toMatch(/codec_type=video/);
      expect(probed).toMatch(/codec_type=audio/);

      // And that it is the span it claims to be, not a fragment of one.
      const duration = Number(/duration=([\d.]+)/.exec(probed)?.[1]);
      expect(duration).toBeGreaterThan(SEGMENT_SECONDS * 0.5);
      expect(duration).toBeLessThan(SEGMENT_SECONDS * 1.5);
    }
  });

  it('serves a segment whole or not at all', async () => {
    const sequence = served[0] ?? 0;

    const res = await fetch(segmentUrl(station, RUNG.name, sequence));
    const body = Buffer.from(await res.arrayBuffer());

    // The length is stated up front and the body is all of it: a viber pays
    // once for a span, so a half-delivered one is worse than a clean miss.
    expect(res.headers.get('content-length')).toBe(String(body.length));

    // Pulled again, byte for byte the same span. A segment does not change
    // under an address someone has already paid for.
    const again = await fetch(segmentUrl(station, RUNG.name, sequence));
    expect(Buffer.from(await again.arrayBuffer()).equals(body)).toBe(true);
  });

  it('keeps every segment inside the byte budget, in actual encoded bytes', async () => {
    // The last span of a broadcast is however much was left when the
    // broadcaster stopped, so it is short rather than over — the bound is
    // about the full ones.
    const full = served.slice(0, -1);
    expect(full.length).toBeGreaterThanOrEqual(2);

    for (const sequence of full) {
      const res = await fetch(segmentUrl(station, RUNG.name, sequence));
      const bytes = (await res.arrayBuffer()).byteLength;

      expect(bytes).toBeGreaterThan(0);
      // ADR 0001: whatever else changes, a segment fits in one fulfill.
      expect(bytes).toBeLessThanOrEqual(SEGMENT_BYTE_BUDGET);
      // And it fits because the cap is a ceiling, not an average.
      expect(bytes).toBeLessThanOrEqual(RUNG_WORST_CASE_BYTES);
    }
  });
});

describe('a request the station cannot answer', () => {
  it('fails cleanly for a rung the station does not offer', async () => {
    const res = await get(station, '/segments/4k/0.ts');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'unknown_rung' });
  });

  it('fails cleanly, and differently, for a sequence it does not have', async () => {
    const res = await get(station, `/segments/${RUNG.name}/9999.ts`);

    expect(res.status).toBe(404);
    // Distinguishable from the rung miss above: a player whose rung is gone
    // falls back to one that exists, and a player whose sequence is gone
    // re-syncs to the live edge. One shrug for both would make each look like
    // the other.
    await expect(res.json()).resolves.toMatchObject({
      error: 'unknown_segment',
    });
  });

  it('fails cleanly for an address that is not a segment at all', async () => {
    for (const path of [
      `/segments/${RUNG.name}/latest`,
      `/segments/${RUNG.name}/`,
      '/segments',
      '/segments/',
    ]) {
      const res = await get(station, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('holds no segments before a broadcaster has ever gone live', async () => {
    const quiet = await boot();

    const res = await fetch(segmentUrl(quiet, RUNG.name, 0));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: 'unknown_segment',
    });
    // A station with no ingest is still a station: it answers, it just has
    // nothing yet.
    expect(quiet.isIngesting()).toBe(false);
  });

  it('refuses to start on a rung it could not address', async () => {
    await expect(
      startOrigin({
        segmentPort: 0,
        ingestPort: 0,
        host: '127.0.0.1',
        ingestHost: '127.0.0.1',
        dataDir: freshDir(),
        streamKey: `test-station-key-${randomUUID()}`,
        // A rung whose name escapes its own prefix could be reached at another
        // rung's price.
        rung: { ...RUNG, name: '../secret' },
      })
    ).rejects.toMatchObject({ name: 'RungError' });
  });
});

describe('the served path holds no payment code', () => {
  it('serves a segment with no payment header, and echoes none back', async () => {
    const sequence = served[0] ?? 0;
    const path = `/segments/${RUNG.name}/${String(sequence)}.ts`;

    // No headers at all. By the time a request reaches the origin the
    // connector in front has already proven it paid; the origin asks for
    // nothing and knows nothing about ILP.
    const bare = await get(station, path);
    await bare.arrayBuffer();
    expect(bare.status).toBe(200);

    // A payment-shaped header changes nothing and comes back nowhere.
    const noisy = await get(station, path, {
      headers: {
        'x-payment': 'not-read',
        authorization: 'Bearer not-read',
      },
    });
    await noisy.arrayBuffer();
    expect(noisy.status).toBe(200);

    for (const header of [
      'x-payment',
      'x-payment-response',
      'authorization',
      'www-authenticate',
    ]) {
      expect(noisy.headers.get(header)).toBeNull();
    }
  });

  it('keeps liveness unpaid and outside the priced prefix', async () => {
    const res = await get(station, '/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'healthy' });
  });
});
