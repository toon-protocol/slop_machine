/**
 * The encode report, exercised the way a broadcaster meets it.
 *
 * It boots the real app on fresh ports against a temporary directory, pushes a
 * real broadcast at the real ingest port **in real time** — `-re`, a generated
 * picture and a tone, which is what a broadcaster's software actually does —
 * and then asserts **entirely over plain HTTP**. Nothing here reaches inside
 * the segmenter, the ingest listener, the `ffmpeg` invocation or the on-disk
 * layout; all of them must stay rewritable without touching this file.
 *
 * Two claims are under test and they are different in kind.
 *
 * The first is the **pace**: a station given a ladder its box can manage, fed
 * vibes at the speed they were shot, reports every rung as keeping up — and
 * says so with numbers that are a measurement rather than a restatement, since
 * they come from a real `ffmpeg` racing a real clock. Pushing in real time is
 * the whole of why this is meaningful: a publish flushed as fast as the box can
 * encode arrives faster than real time and would call any box big enough.
 *
 * The second is the **byte budget**, and it is asserted against actual encoded
 * bytes. A rung is configured right at ADR 0001's ceiling — legal, and the
 * boot-time arithmetic lets it through — and then fed incompressible noise, so
 * the encoder saturates its cap and MPEG-TS framing carries the result over
 * 2 MiB. That is exactly the case the measurement exists for: the arithmetic is
 * the guarantee, and this is the alarm for an encoder that broke it anyway. The
 * origin must refuse to serve those spans, count them, and keep serving the
 * ones that fit.
 *
 * `ffmpeg` must be on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOrigin } from '../origin/origin.js';
import type { OriginConfig, OriginInstance } from '../origin/origin.js';

/**
 * The ladder the pace suite runs, as the one string an operator would put in a
 * compose file. Two rungs of different shapes, so "the cheap rung kept up and
 * the expensive one did not" is a distinction this station could actually
 * draw.
 */
const LADDER = 'audio:64k, small:360:500k:64k';
const AUDIO_RUNG = 'audio';
const VIDEO_RUNG = 'small';
const RUNGS = [AUDIO_RUNG, VIDEO_RUNG];

/** Fixed segment duration for the pace suite. */
const SEGMENT_SECONDS = 2;

/** How long a broadcast the suite pushes, in real time, in seconds. */
const BROADCAST_SECONDS = 16;

/** The budget of ADR 0001, written out rather than imported. */
const SEGMENT_BYTE_BUDGET = 2 * 1024 * 1024;

/**
 * A ladder sitting exactly on ADR 0001's ceiling: at one-second segments the
 * budget allows 16,777,216 bit/s in total, and this rung caps at precisely
 * that. The boot-time arithmetic permits it — `bitrate × duration` is the
 * budget, not over it — which is what makes what happens next a real
 * observation about a real encoder rather than a configuration error.
 */
const CEILING_LADDER = 'audio:64k, ceiling:720:16713216:64000';
const CEILING_RUNG = 'ceiling';
const CEILING_SEGMENT_SECONDS = 1;
const CEILING_BROADCAST_SECONDS = 8;

/**
 * The encode report, written out here rather than imported, so that a change
 * to the shape a broadcaster depends on fails this file instead of quietly
 * agreeing with itself.
 */
interface EncodeBody {
  live: boolean;
  segmentSeconds: number;
  segmentByteBudget: number;
  rungs: {
    rung: string;
    encoding: boolean;
    keepingUp: boolean | null;
    behindSeconds: number | null;
    encodedSeconds: number;
    elapsedSeconds: number;
    refusedOverBudget: number;
    lastOverBudget: { sequence: number; bytes: number } | null;
    largestSegmentBytes: number | null;
  }[];
}

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** The station every pace assertion shares, broadcast to once, in real time. */
let station: OriginInstance;
/** Its encode report, read while a broadcaster was publishing. */
let midBroadcast: EncodeBody;
/** The same, read later in the same broadcast. */
let later: EncodeBody;
/** The same, read once the broadcaster had gone. */
let afterwards: EncodeBody;

beforeAll(async () => {
  station = await boot();

  // Not awaited: the point of pushing in real time is that the box is racing
  // the clock *while* the suite reads how it is doing.
  const broadcast = publish({ origin: station, streamKey: keyOf(station) });

  midBroadcast = await until(
    station,
    (report) =>
      report.live && report.rungs.every((rung) => rung.encodedSeconds > 0),
    'the station never reported encoding anything while a broadcaster was publishing'
  );

  later = await until(
    station,
    (report) =>
      report.live &&
      report.rungs.every(
        (rung) =>
          rung.encodedSeconds >=
          encodedAt(midBroadcast, rung.rung) + 2 * SEGMENT_SECONDS
      ),
    'the encode never got further along while the broadcast ran'
  );

  await broadcast;

  afterwards = await until(
    station,
    (report) => !report.live && report.rungs.every((rung) => !rung.encoding),
    'the station kept reporting an encoder running after the broadcaster had gone'
  );
}, 180_000);

afterAll(async () => {
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

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-encode-'));
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
    rungs: LADDER,
    segmentSeconds: SEGMENT_SECONDS,
    ...config,
  });
  keys.set(origin, streamKey);
  running.push(origin);
  return origin;
}

/**
 * Publish a generated broadcast at a station, exactly as a broadcaster's
 * software would — a URL, a stream key as the stream name, and `-re` so the
 * vibes arrive at the speed they were shot rather than as fast as the box can
 * encode them.
 *
 * `vibes` is the picture. The default is an ordinary test pattern; the byte
 * budget suite sends full-frame noise instead, which is incompressible and so
 * makes the origin's encoder spend every bit its cap allows.
 */
function publish(options: {
  origin: OriginInstance;
  streamKey: string;
  seconds?: number;
  vibes?: string;
  videoBitrate?: string;
}): Promise<{ code: number | null; output: string }> {
  const {
    origin,
    streamKey,
    seconds = BROADCAST_SECONDS,
    vibes = `testsrc=size=640x480:rate=25:duration=${String(seconds)}`,
    videoBitrate = '1200k',
  } = options;
  const url = `rtmp://127.0.0.1:${String(origin.config.ingestPort)}/live/${streamKey}`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-re',
    '-f',
    'lavfi',
    '-i',
    vibes,
    '-re',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    videoBitrate,
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

/** Read the encode report, as a broadcaster does: one GET, one address. */
async function readEncode(
  origin: OriginInstance,
  init?: RequestInit
): Promise<{ res: Response; body: EncodeBody; text: string }> {
  const res = await get(origin, '/encode', init);
  const text = await res.text();
  return { res, body: JSON.parse(text) as EncodeBody, text };
}

/** What that report says about one rung. */
function rungOf(report: EncodeBody, rung: string): EncodeBody['rungs'][number] {
  const found = report.rungs.find((reported) => reported.rung === rung);
  if (found === undefined) {
    throw new Error(`the encode report said nothing about rung "${rung}"`);
  }
  return found;
}

function encodedAt(report: EncodeBody, rung: string): number {
  return rungOf(report, rung).encodedSeconds;
}

/** Pull one segment, and measure what actually came back. */
async function pull(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<{ status: number; bytes: number; error?: string }> {
  const res = await get(origin, `/segments/${rung}/${String(sequence)}.ts`);
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status === 200) return { status: res.status, bytes: body.length };
  const failure = JSON.parse(body.toString()) as { error?: string };
  return { status: res.status, bytes: body.length, error: failure.error };
}

/** Read the report until it says something, or give up loudly. */
async function until(
  origin: OriginInstance,
  holds: (report: EncodeBody) => boolean,
  complaint: string,
  timeoutMs = 60_000
): Promise<EncodeBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await readEncode(origin);
    if (holds(body)) return body;
    if (Date.now() > deadline) {
      throw new Error(`${complaint} (last answer: ${JSON.stringify(body)})`);
    }
    await new Promise((tick) => setTimeout(tick, 200));
  }
}

// ---------- The tests ----------

describe('a broadcaster asking whether their box is big enough', () => {
  it('is told, per rung, that the encode is keeping up with the ladder', () => {
    // The real claim of the whole file: a real `ffmpeg` on this box, fed real
    // vibes at the speed they were shot, kept pace at every rung on the ladder.
    expect(midBroadcast.live).toBe(true);
    expect(midBroadcast.rungs.map((rung) => rung.rung)).toEqual(RUNGS);

    for (const rung of midBroadcast.rungs) {
      expect(rung.keepingUp).toBe(true);
      expect(rung.encoding).toBe(true);
      // Keeping up is a bounded number, not a mood: at most the one segment of
      // slack the report allows for an encoder's start-up and flush.
      expect(rung.behindSeconds).toBeGreaterThanOrEqual(0);
      expect(rung.behindSeconds).toBeLessThanOrEqual(SEGMENT_SECONDS);
    }
  });

  it('is told in measured seconds, not in an opinion', () => {
    for (const rung of later.rungs) {
      // Seconds of vibes finished, against seconds of real time spent
      // finishing them. Both come off a real encoder racing a real clock.
      expect(rung.encodedSeconds).toBeGreaterThan(0);
      expect(rung.encodedSeconds % SEGMENT_SECONDS).toBe(0);
      expect(rung.elapsedSeconds).toBeGreaterThan(0);

      // Keeping up is exactly "the finished vibes account for the time that
      // passed", give or take the span in flight and one segment of slack.
      expect(rung.elapsedSeconds - rung.encodedSeconds).toBeLessThanOrEqual(
        2 * SEGMENT_SECONDS
      );
    }
  });

  it('gets further along as the broadcast runs', () => {
    for (const rung of RUNGS) {
      expect(encodedAt(later, rung)).toBeGreaterThan(
        encodedAt(midBroadcast, rung)
      );
    }
    expect(later.live).toBe(true);
    expect(later.segmentSeconds).toBe(SEGMENT_SECONDS);
  });

  it('keeps the verdict after the broadcaster has gone, and stops it moving', async () => {
    // A broadcaster who has finished still wants to know whether their box
    // coped, so the answer is frozen rather than erased with the broadcast.
    expect(afterwards.live).toBe(false);
    for (const rung of afterwards.rungs) {
      expect(rung.encoding).toBe(false);
      expect(rung.keepingUp).toBe(true);
      expect(rung.encodedSeconds).toBeGreaterThanOrEqual(
        encodedAt(later, rung.rung)
      );
    }

    // Frozen: two reads a moment apart are the same answer.
    const first = await readEncode(station);
    await new Promise((tick) => setTimeout(tick, 600));
    const second = await readEncode(station);
    expect(second.text).toBe(first.text);
  });

  it('is answered at one address, as JSON no cache may hand on', async () => {
    const { res } = await readEncode(station);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a station nobody has broadcast to', () => {
  it('says it has judged nothing, rather than that it is coping', async () => {
    const quiet = await boot();

    const { res, body } = await readEncode(quiet);

    expect(res.status).toBe(200);
    expect(body.live).toBe(false);
    expect(body.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(body.segmentByteBudget).toBe(SEGMENT_BYTE_BUDGET);
    expect(body.rungs).toEqual([
      {
        rung: AUDIO_RUNG,
        encoding: false,
        keepingUp: null,
        behindSeconds: null,
        encodedSeconds: 0,
        elapsedSeconds: 0,
        refusedOverBudget: 0,
        lastOverBudget: null,
        largestSegmentBytes: null,
      },
      {
        rung: VIDEO_RUNG,
        encoding: false,
        keepingUp: null,
        behindSeconds: null,
        encodedSeconds: 0,
        elapsedSeconds: 0,
        refusedOverBudget: 0,
        lastOverBudget: null,
        largestSegmentBytes: null,
      },
    ]);
  });

  it('reports every rung the ladder it was configured with actually has', async () => {
    const four = await boot({
      rungs: 'sound:64k, low:180:200k:64k, mid:360:500k:64k, high:720:900k:64k',
      segmentSeconds: 6,
    });

    const { body } = await readEncode(four);

    expect(body.rungs.map((rung) => rung.rung)).toEqual([
      'sound',
      'low',
      'mid',
      'high',
    ]);
    expect(body.segmentSeconds).toBe(6);
  });
});

describe('the encode report is the broadcaster-operator’s, not a viber’s', () => {
  it('is unpriced and in-node, on the same footing as liveness', async () => {
    // It sits outside `/segments` and beneath no rung, so no connector route
    // reaches it and nothing can be bought at its price — and it is not
    // beneath `/now` either, which is a paid address.
    for (const path of [
      '/segments/encode',
      '/segments/encode.ts',
      `/segments/${VIDEO_RUNG}/encode`,
      `/segments/${VIDEO_RUNG}/encode.ts`,
      '/now/encode',
      '/encode/segments',
      `/encode/${VIDEO_RUNG}`,
      '/encode/now',
    ]) {
      const res = await get(station, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('is not the station’s now, and carries no sequence number', async () => {
    const { text, body } = await readEncode(station);

    // The now is paid, viber-facing, and about which sequence to pull next.
    // This is unpriced, operator-facing, and about the box. Nothing here tells
    // a viber where the live edge is.
    expect(Object.keys(body).sort()).toEqual([
      'live',
      'rungs',
      'segmentByteBudget',
      'segmentSeconds',
    ]);
    for (const rung of body.rungs) {
      expect(Object.keys(rung)).not.toContain('sequence');
    }
    expect(text).not.toContain('#EXTM3U');
    expect(text).not.toContain('.m3u8');
    expect(text).not.toMatch(/price|amount|cost/i);
  });

  it('leaves liveness alone', async () => {
    // `/health` is process liveness for a supervisor and answers the same
    // whether or not anybody is broadcasting. The encode report is a separate
    // address precisely so it stays that way.
    const health = await get(station, '/health');
    const body = (await health.json()) as Record<string, unknown>;

    expect(health.status).toBe(200);
    expect(body['status']).toBe('healthy');
    expect(body['live']).toBeUndefined();
    expect(body['rungs']).toBeUndefined();
    expect(body['segmentSeconds']).toBeUndefined();
  });

  it('requires no payment header, reads none, and echoes none', async () => {
    const bare = await readEncode(station);
    expect(bare.res.status).toBe(200);

    // The broadcast has ended, so the report is frozen: a payment-shaped
    // header changes nothing, byte for byte, and comes back nowhere.
    const noisy = await readEncode(station, {
      headers: {
        'x-payment': 'not-read',
        authorization: 'Bearer not-read',
      },
    });
    expect(noisy.res.status).toBe(200);
    expect(noisy.text).toBe(bare.text);

    for (const header of [
      'x-payment',
      'x-payment-response',
      'authorization',
      'www-authenticate',
    ]) {
      expect(noisy.res.headers.get(header)).toBeNull();
    }
  });
});

describe('a segment over the byte budget', () => {
  /** The station run right at ADR 0001's ceiling, fed incompressible noise. */
  let strained: OriginInstance;
  let report: EncodeBody;

  beforeAll(async () => {
    strained = await boot({
      rungs: CEILING_LADDER,
      segmentSeconds: CEILING_SEGMENT_SECONDS,
    });

    await publish({
      origin: strained,
      streamKey: keyOf(strained),
      seconds: CEILING_BROADCAST_SECONDS,
      // Full-frame noise: nothing in it compresses, so the origin's encoder
      // spends every bit its cap allows and the cap is what the budget was
      // computed from.
      vibes: `color=black:s=1280x720:r=30:d=${String(CEILING_BROADCAST_SECONDS)},noise=alls=100:allf=t+u`,
      videoBitrate: '24000k',
    });

    report = await until(
      strained,
      (body) => !body.live && body.rungs.every((rung) => !rung.encoding),
      'the strained station never finished its broadcast',
      120_000
    );
  }, 180_000);

  it('is refused rather than served, and counted where a broadcaster looks', () => {
    const ceiling = rungOf(report, CEILING_RUNG);

    // The rung is legal — its capped bitrate times the fixed duration is
    // exactly the budget, and the origin started — and the real encoder went
    // over it anyway. That is the case this measurement exists for.
    expect(report.segmentByteBudget).toBe(SEGMENT_BYTE_BUDGET);
    expect(ceiling.refusedOverBudget).toBeGreaterThan(0);
    expect(ceiling.lastOverBudget).not.toBeNull();
    expect(ceiling.lastOverBudget?.bytes).toBeGreaterThan(SEGMENT_BYTE_BUDGET);

    // And the cheap rung on the same ladder, encoding the same ingest, is fine
    // — so the alarm names a rung rather than condemning the station.
    const audio = rungOf(report, AUDIO_RUNG);
    expect(audio.refusedOverBudget).toBe(0);
    expect(audio.lastOverBudget).toBeNull();
    expect(audio.largestSegmentBytes).toBeLessThanOrEqual(SEGMENT_BYTE_BUDGET);
  });

  it('cannot be pulled at its address, cleanly, by actual bytes', async () => {
    const refused = rungOf(report, CEILING_RUNG).lastOverBudget;
    if (refused === null) throw new Error('nothing was refused to check');

    // The one the origin measured over budget is simply not there: a clean
    // miss a viber can re-sync from, never a body their connector may not be
    // able to carry.
    const miss = await pull(strained, CEILING_RUNG, refused.sequence);
    expect(miss.status).toBe(404);
    expect(miss.error).toBe('unknown_segment');
  });

  it('never appears in what the station does serve, measured on the wire', async () => {
    // Every sequence the encoder could have produced, pulled for real. What
    // comes back is weighed rather than trusted: this is ADR 0001 asserted
    // against actual encoded bytes.
    const produced =
      rungOf(report, CEILING_RUNG).encodedSeconds / CEILING_SEGMENT_SECONDS;
    expect(produced).toBeGreaterThan(0);

    let served = 0;
    for (let sequence = 0; sequence < produced; sequence += 1) {
      const got = await pull(strained, CEILING_RUNG, sequence);
      if (got.status === 404) {
        expect(got.error).toBe('unknown_segment');
        continue;
      }
      expect(got.status).toBe(200);
      expect(got.bytes).toBeGreaterThan(0);
      expect(got.bytes).toBeLessThanOrEqual(SEGMENT_BYTE_BUDGET);
      served += 1;
    }

    // Some of what the encoder produced was refused and the rest was served,
    // and nothing that came back was over the budget.
    expect(served).toBeGreaterThan(0);
    expect(
      served + rungOf(report, CEILING_RUNG).refusedOverBudget
    ).toBeLessThanOrEqual(produced);
  });
});
