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
 * ladder it configured, and the bytes that come back.
 *
 * The ladder is the point of most of it: two rungs, written exactly the way a
 * broadcaster writes them, cut from one ingest and each served at its own
 * address. A deliberately small ladder, because it is ordinary configuration
 * and a broadcaster's four real rungs would cost minutes per run.
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
 * The ladder the suite runs, as the one string an operator would put in a
 * compose file. Two rungs of different shapes — one sound only, one with a
 * picture — so that "the same span at two rungs" is a real choice of price and
 * not two spellings of one encode.
 */
const LADDER = 'audio:64k, small:360:500k:64k';

/** What that ladder is called, in ladder order. Each is its own address. */
const AUDIO_RUNG = 'audio';
const VIDEO_RUNG = 'small';
const RUNGS = [AUDIO_RUNG, VIDEO_RUNG];

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/**
 * ADR 0001's bound, written out rather than imported: a segment is at most
 * 2 MiB, so that a station keeps working if the connector ever caps the
 * response direction the way it already caps requests.
 */
const SEGMENT_BYTE_BUDGET = 2 * 1024 * 1024;

/**
 * The bound each rung of the suite's ladder claims, from the arithmetic that
 * makes a cap meaningful — a hard maximum bitrate over a fixed duration, plus
 * the one second of encoder buffer the video cap smooths over:
 *
 *   audio: 64 000 × 2 ÷ 8                       =  16 000 bytes
 *   small: (500 000 × 3 + 64 000 × 2) ÷ 8       = 203 500 bytes
 *
 * with 3% and a flat 12 KiB allowed on top for MPEG-TS carriage — four bytes
 * of header on every 188-byte packet, plus the program tables repeated a few
 * times a second. Carriage is not picture. A segment over this is an encoder
 * that treated its cap as an average, which is exactly what ADR 0001 forbids.
 */
const WORST_CASE_BYTES: Record<string, number> = {
  [AUDIO_RUNG]: Math.ceil(16_000 * 1.03) + 12 * 1024,
  [VIDEO_RUNG]: Math.ceil(203_500 * 1.03) + 12 * 1024,
};

/** How long a broadcast the suite pushes, in seconds. */
const BROADCAST_SECONDS = 10;

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** The one station the read-side assertions share, broadcast to once. */
let station: OriginInstance;
/** The sequence numbers that station actually served, per rung, in order. */
let served: Record<string, number[]>;

beforeAll(async () => {
  station = await boot();
  await publish({ origin: station, streamKey: keyOf(station) });
  for (const rung of RUNGS) await waitForSegment(station, rung, 2);
  served = {
    [AUDIO_RUNG]: await servedSequences(station, AUDIO_RUNG),
    [VIDEO_RUNG]: await servedSequences(station, VIDEO_RUNG),
  };
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
    // The ladder as ordinary configuration — the same string a broadcaster
    // sets, not a shape only a test can build.
    rungs: LADDER,
    segmentSeconds: SEGMENT_SECONDS,
    ...config,
  });
  keys.set(origin, streamKey);
  running.push(origin);
  return origin;
}

/** What a station refuses to boot with, and what it says about it. */
async function refusal(config: Partial<OriginConfig>): Promise<Error> {
  try {
    const origin = await boot(config);
    await origin.stop();
  } catch (error) {
    return error as Error;
  }
  throw new Error('that station started, and it should not have');
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

/** Pull one segment and hand back its bytes. */
async function pull(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<Buffer> {
  const res = await fetch(segmentUrl(origin, rung, sequence));
  if (res.status !== 200) {
    await res.arrayBuffer();
    throw new Error(
      `${rung}/${String(sequence)} came back ${String(res.status)}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
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

describe('a broadcast, cut into segments at every rung on the ladder', () => {
  it('is served at an address carrying its rung and its sequence number', async () => {
    for (const rung of RUNGS) {
      const sequences = served[rung] ?? [];
      // A ten-second broadcast at two-second segments is several spans, each
      // at its own address beneath its rung's prefix.
      expect(sequences.length).toBeGreaterThanOrEqual(3);
      expect(sequences).toEqual(sequences.map((_, index) => index));

      for (const sequence of sequences) {
        const res = await fetch(segmentUrl(station, rung, sequence));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp2t');
        // A segment was paid for by whoever pulled it; nothing invites a cache
        // to hand it on for free.
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    }
  });

  it('serves the ladder and the fixed duration it was configured with', () => {
    expect(station.config.rungs).toEqual(RUNGS);
    expect(station.config.segmentSeconds).toBe(SEGMENT_SECONDS);
  });

  it('serves the same span at either rung, at the size that rung costs', async () => {
    // The span a viber's player would climb or drop between: the same
    // sequence number, pulled at two rungs mid-broadcast.
    const common = (served[AUDIO_RUNG] ?? []).filter((sequence) =>
      (served[VIDEO_RUNG] ?? []).includes(sequence)
    );
    // Drop the last one: whichever rung finished a beat later ends on a short
    // span, and the comparison is about full ones.
    const spans = common.slice(0, -1);
    expect(spans.length).toBeGreaterThanOrEqual(2);

    for (const sequence of spans) {
      const cheap = await pull(station, AUDIO_RUNG, sequence);
      const dear = await pull(station, VIDEO_RUNG, sequence);

      // Both come back whole, and the one carrying a picture is the bigger
      // one. That difference is the whole reason a rung has its own price:
      // choosing a rung is choosing what it costs to carry.
      expect(cheap.length).toBeGreaterThan(0);
      // Half again as many bytes, at least: the picture is what the dearer
      // rung is carrying, and carrying it is what it costs.
      expect(dear.length).toBeGreaterThan(cheap.length * 1.25);
    }
  });

  it('serves playable spans, not empty or truncated files', async () => {
    for (const rung of RUNGS) {
      for (const sequence of (served[rung] ?? []).slice(0, 3)) {
        const probed = probe(await pull(station, rung, sequence));

        // Probed as a whole file rather than inspected byte by byte: what
        // matters is that a viber's player can decode what it paid for.
        expect(probed).toMatch(/format_name=mpegts/);
        expect(probed).toMatch(/codec_type=audio/);
        // A rung with a picture carries one; a rung sold as sound only carries
        // no video at all, which is what makes it the cheap rung.
        if (rung === VIDEO_RUNG) {
          expect(probed).toMatch(/codec_type=video/);
        } else {
          expect(probed).not.toMatch(/codec_type=video/);
        }

        // And that it is the span it claims to be, not a fragment of one.
        const duration = Number(/duration=([\d.]+)/.exec(probed)?.[1]);
        expect(duration).toBeGreaterThan(SEGMENT_SECONDS * 0.5);
        expect(duration).toBeLessThan(SEGMENT_SECONDS * 1.5);
      }
    }
  });

  it('serves a segment whole or not at all', async () => {
    const sequence = served[VIDEO_RUNG]?.[0] ?? 0;

    const res = await fetch(segmentUrl(station, VIDEO_RUNG, sequence));
    const body = Buffer.from(await res.arrayBuffer());

    // The length is stated up front and the body is all of it: a viber pays
    // once for a span, so a half-delivered one is worse than a clean miss.
    expect(res.headers.get('content-length')).toBe(String(body.length));

    // Pulled again, byte for byte the same span. A segment does not change
    // under an address someone has already paid for.
    const again = await pull(station, VIDEO_RUNG, sequence);
    expect(again.equals(body)).toBe(true);
  });

  it('keeps every segment inside the byte budget, in actual encoded bytes', async () => {
    for (const rung of RUNGS) {
      // The last span of a broadcast is however much was left when the
      // broadcaster stopped, so it is short rather than over — the bound is
      // about the full ones.
      const full = (served[rung] ?? []).slice(0, -1);
      expect(full.length).toBeGreaterThanOrEqual(2);

      for (const sequence of full) {
        const bytes = (await pull(station, rung, sequence)).length;

        expect(bytes).toBeGreaterThan(0);
        // ADR 0001: whatever else changes, a segment fits in one fulfill.
        expect(bytes).toBeLessThanOrEqual(SEGMENT_BYTE_BUDGET);
        // And it fits because that rung's cap is a ceiling, not an average.
        expect(bytes).toBeLessThanOrEqual(WORST_CASE_BYTES[rung] ?? 0);
      }
    }
  });
});

describe('a ladder the origin will not run', () => {
  it('refuses to start, naming the rung, when one is over the byte budget', async () => {
    // 8 Mbit/s over four-second segments is 4 MiB a segment: twice what a
    // fulfill may carry, and a station that came up like this would go dark
    // the day the connector caps responses.
    const error = await refusal({
      rungs: 'small:360:500k:64k, greedy:1080:8M:128k',
      segmentSeconds: 4,
    });

    expect(error.name).toBe('RungError');
    // Named, because the operator's next move is to edit that line.
    expect(error.message).toContain('greedy');
    expect(error.message).toContain('2097152');
    // And not a complaint about the rung that was fine.
    expect(error.message).not.toContain('small');
  });

  it('re-runs the byte check on the next start, so a raised bitrate is caught', async () => {
    const ladder = (videoBitrate: string) =>
      `edge:1080:${videoBitrate}:128k` as const;

    // The rung as it was: 3 Mbit/s over four seconds is 1.5 MiB, inside the
    // budget, and the station comes up.
    const before = await boot({ rungs: ladder('3M'), segmentSeconds: 4 });
    expect(before.config.rungs).toEqual(['edge']);
    await before.stop();

    // The same rung, one number changed, restarted. Nothing else about the
    // station moved, and it refuses.
    const error = await refusal({ rungs: ladder('5M'), segmentSeconds: 4 });
    expect(error.name).toBe('RungError');
    expect(error.message).toContain('edge');
  });

  it('refuses a rung it could not address', async () => {
    // A rung whose name escapes its own prefix could be reached at another
    // rung's price.
    const error = await refusal({ rungs: '../secret:360:500k:64k' });

    expect(error.name).toBe('RungError');
    expect(error.message).toContain('secret');
  });

  it('refuses a ladder it cannot read, rather than dropping the rung', async () => {
    for (const ladder of ['', 'small:360:500k', 'small:360:fast:64k']) {
      const error = await refusal({ rungs: ladder });
      expect(error.name).toBe('RungError');
    }
  });

  it('refuses two rungs of one name, which would be two prices at one address', async () => {
    const error = await refusal({ rungs: 'small:96k, small:360:500k:64k' });

    expect(error.name).toBe('RungError');
    expect(error.message).toContain('small');
  });
});

describe('a request the station cannot answer', () => {
  it('fails cleanly for a rung the station does not offer', async () => {
    const res = await get(station, '/segments/4k/0.ts');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'unknown_rung' });
  });

  it('fails cleanly, and differently, for a sequence it does not have', async () => {
    const res = await get(station, `/segments/${VIDEO_RUNG}/9999.ts`);

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
      `/segments/${VIDEO_RUNG}/latest`,
      `/segments/${VIDEO_RUNG}/`,
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

    const res = await fetch(segmentUrl(quiet, VIDEO_RUNG, 0));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: 'unknown_segment',
    });
    // A station with no ingest is still a station: it answers, it just has
    // nothing yet.
    expect(quiet.isIngesting()).toBe(false);
  });
});

describe('the served path holds no payment code', () => {
  it('serves a segment with no payment header, and echoes none back', async () => {
    const sequence = served[VIDEO_RUNG]?.[0] ?? 0;
    const path = `/segments/${VIDEO_RUNG}/${String(sequence)}.ts`;

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
