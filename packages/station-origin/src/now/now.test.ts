/**
 * The station's *now*, exercised the way a viber meets it.
 *
 * It boots the real app on fresh ports against a temporary directory, pushes a
 * real broadcast at the real ingest port **in real time** — `-re`, a generated
 * picture and a tone, which is what a broadcaster's software actually does —
 * and then asserts **entirely over plain HTTP**. Nothing here reaches inside
 * the segmenter, the ingest listener, the `ffmpeg` invocation or the on-disk
 * layout; all of them must stay rewritable without touching this file.
 *
 * The question the whole file is about is the one a viber has on joining: a
 * station is a continuous broadcast, and starting at sequence zero would be
 * starting somewhere that has already passed. So the assertions are what a
 * viber does with the answer — pull the edge it names, pull the same span one
 * rung along, tell a stalled edge apart from a station that ended — rather
 * than the shape of the JSON for its own sake.
 *
 * The broadcast is pushed in real time on purpose. A publish flushed as fast
 * as the box can encode is live for a moment and gone, and "does the edge
 * advance while a broadcaster is publishing" is then unobservable — which is
 * exactly the question this address exists to answer.
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
 * The ladder the suite runs, as the one string an operator would put in a
 * compose file. Two rungs of different shapes, so "the same span at a
 * different rung" is a real choice of price rather than two spellings of one
 * encode.
 */
const LADDER = 'audio:64k, small:360:500k:64k';
const AUDIO_RUNG = 'audio';
const VIDEO_RUNG = 'small';
const RUNGS = [AUDIO_RUNG, VIDEO_RUNG];

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/** How long a broadcast the suite pushes, in real time, in seconds. */
const BROADCAST_SECONDS = 16;

/**
 * The station's *now*, written out here rather than imported, so that a change
 * to the shape a viber depends on fails this file instead of quietly agreeing
 * with itself.
 */
interface NowBody {
  live: boolean;
  segmentSeconds: number;
  rungs: { rung: string; sequence: number | null }[];
}

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** The one station every read-side assertion shares, broadcast to once. */
let station: OriginInstance;
/** The station's *now*, read while a broadcaster was publishing. */
let edge: NowBody;
/** The same, read later in the same broadcast. */
let later: NowBody;
/** The same, read once the broadcaster had gone and the edge stopped moving. */
let ended: NowBody;

beforeAll(async () => {
  station = await boot();

  // Not awaited: the point of pushing in real time is that the station is
  // live *while* the suite reads its now.
  const broadcast = publish({ origin: station, streamKey: keyOf(station) });

  // Deliberately past sequence 0: the whole claim is that a viber joining a
  // broadcast already in progress is sent to where it is *now*, not to where
  // it began.
  edge = await until(
    station,
    (now) => now.live && now.rungs.every((rung) => (rung.sequence ?? -1) >= 1),
    'the station never reported a live edge while a broadcaster was publishing'
  );

  later = await until(
    station,
    (now) =>
      now.live &&
      now.rungs.every(
        (rung) => (rung.sequence ?? -1) >= sequenceAt(edge, rung.rung) + 1
      ),
    'the edge never advanced while the broadcast ran'
  );

  await broadcast;

  await until(
    station,
    (now) => !now.live,
    'the station kept reporting ingest as live after the broadcaster had gone'
  );
  ended = await still(station);
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
  const dir = mkdtempSync(join(tmpdir(), 'station-now-'));
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
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=640x480:rate=25:duration=${String(seconds)}`,
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

/** Read the station's *now*, as a viber does: one GET, one address. */
async function readNow(
  origin: OriginInstance,
  init?: RequestInit
): Promise<{ res: Response; body: NowBody; text: string }> {
  const res = await get(origin, '/now', init);
  const text = await res.text();
  return { res, body: JSON.parse(text) as NowBody, text };
}

/** What that answer says the live edge is at one rung. */
function sequenceAt(now: NowBody, rung: string): number {
  const found = now.rungs.find((reported) => reported.rung === rung);
  if (found === undefined || found.sequence === null) {
    throw new Error(`now reported no sequence at rung "${rung}"`);
  }
  return found.sequence;
}

/** Pull one segment, the way a viber acts on what *now* told it. */
function pull(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<Response> {
  return get(origin, `/segments/${rung}/${String(sequence)}.ts`);
}

/** Read *now* until it says something, or give up loudly. */
async function until(
  origin: OriginInstance,
  holds: (now: NowBody) => boolean,
  complaint: string,
  timeoutMs = 60_000
): Promise<NowBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await readNow(origin);
    if (holds(body)) return body;
    if (Date.now() > deadline) {
      throw new Error(`${complaint} (last answer: ${JSON.stringify(body)})`);
    }
    await new Promise((tick) => setTimeout(tick, 200));
  }
}

/** Read *now* until it stops moving — a station whose broadcaster has gone. */
async function still(origin: OriginInstance): Promise<NowBody> {
  let previous = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { text } = await readNow(origin);
    if (text === previous) return JSON.parse(text) as NowBody;
    previous = text;
    if (Date.now() > deadline) {
      throw new Error(`the edge never settled (last answer: ${text})`);
    }
    await new Promise((tick) => setTimeout(tick, 500));
  }
}

// ---------- The tests ----------

describe("a viber reading the station's now", () => {
  it('learns every rung, its sequence number, the duration, and whether ingest is live', () => {
    expect(edge.live).toBe(true);
    expect(edge.segmentSeconds).toBe(SEGMENT_SECONDS);

    // Every rung the ladder has, in ladder order — cheapest first — because a
    // player choosing on a budget is choosing between prices for one span.
    expect(edge.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
    for (const rung of edge.rungs) {
      expect(typeof rung.sequence).toBe('number');
      expect(rung.sequence).toBeGreaterThanOrEqual(0);
    }
  });

  it('is answered at one address, as JSON no cache may hand on', async () => {
    const { res } = await readNow(station);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // The edge moves every segment, and this answer was paid for by whoever
    // asked for it.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('starts at the live edge rather than at the beginning', async () => {
    // The whole point: a viber pulls now, then pulls the sequence it named,
    // and is watching what everybody else is watching.
    for (const rung of RUNGS) {
      const res = await pull(station, rung, sequenceAt(edge, rung));
      await res.arrayBuffer();
      expect(res.status).toBe(200);
    }

    // And that edge is not the beginning of the broadcast — it moved on while
    // the broadcaster kept publishing.
    const highest = Math.max(...RUNGS.map((rung) => sequenceAt(edge, rung)));
    expect(highest).toBeGreaterThan(0);
  });

  it('advances as the broadcast runs', () => {
    for (const rung of RUNGS) {
      expect(sequenceAt(later, rung)).toBeGreaterThan(sequenceAt(edge, rung));
    }
    // Still the same station, still the same ladder and the same span length.
    expect(later.live).toBe(true);
    expect(later.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(later.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });

  it('names a span that can be pulled at a different rung, mid-broadcast', async () => {
    // A player climbing or dropping a rung takes the span it is on and asks
    // for it one rung along. The rung it can safely swap to is bounded by the
    // slowest rung's edge, which is why every rung is in one answer.
    const span = Math.min(...RUNGS.map((rung) => sequenceAt(later, rung)));

    for (const rung of RUNGS) {
      const res = await pull(station, rung, span);
      const body = Buffer.from(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('video/mp2t');
      expect(body.length).toBeGreaterThan(0);
    }
  });
});

describe('a station has one now', () => {
  it('shows two vibers reading at the same moment the same edge', async () => {
    // A broadcaster who has gone leaves an edge that does not move, so this is
    // the strong form: byte for byte the same answer to everybody.
    const answers = await Promise.all(
      Array.from({ length: 8 }, async () => (await readNow(station)).text)
    );

    expect(new Set(answers).size).toBe(1);
  });

  it('shows them the same edge mid-broadcast too', async () => {
    const live = await boot();
    const broadcast = publish({ origin: live, streamKey: keyOf(live) });
    await until(
      live,
      (now) => now.live && now.rungs.every((rung) => rung.sequence !== null),
      'that station never went live'
    );

    const answers = await Promise.all(
      Array.from({ length: 8 }, async () => (await readNow(live)).body)
    );

    for (const answer of answers) {
      expect(answer.live).toBe(true);
      expect(answer.segmentSeconds).toBe(SEGMENT_SECONDS);
      expect(answer.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
    }
    // Nothing is per-viber: whatever the edge was, everyone got it. The one
    // segment of slack is a real segment finishing mid-flight, not a station
    // telling two vibers different things.
    for (const rung of RUNGS) {
      const seen = answers.map((answer) => sequenceAt(answer, rung));
      expect(Math.max(...seen) - Math.min(...seen)).toBeLessThanOrEqual(1);
    }

    await live.stop();
    await broadcast;
  }, 120_000);
});

describe('a station with no broadcaster on it', () => {
  it('says so, at the same address, rather than going missing', async () => {
    const quiet = await boot();

    const { res, body } = await readNow(quiet);

    expect(res.status).toBe(200);
    // Not live, and holding nothing yet — which is a different thing from a
    // sequence of 0, because 0 is a real segment somebody could pay for.
    expect(body.live).toBe(false);
    expect(body.rungs).toEqual([
      { rung: AUDIO_RUNG, sequence: null },
      { rung: VIDEO_RUNG, sequence: null },
    ]);
    expect(body.segmentSeconds).toBe(SEGMENT_SECONDS);
  });

  it('reports every rung the ladder it was configured with actually has', async () => {
    const four = await boot({
      rungs: 'sound:64k, low:180:200k:64k, mid:360:500k:64k, high:720:900k:64k',
      segmentSeconds: 6,
    });

    const { body } = await readNow(four);

    expect(body.rungs).toEqual([
      { rung: 'sound', sequence: null },
      { rung: 'low', sequence: null },
      { rung: 'mid', sequence: null },
      { rung: 'high', sequence: null },
    ]);
    // The fixed duration is the station's, not a constant: it is what turns a
    // sequence number into a time.
    expect(body.segmentSeconds).toBe(6);
  });

  it('tells a broadcaster who dropped apart from an edge that stalled', async () => {
    // The broadcaster has gone: ingest is not live, and that is the only way a
    // viber can tell this apart from an encoder falling behind.
    expect(ended.live).toBe(false);

    // The window it already had is still servable — a blip does not drop every
    // viber at once — and the edge is where the broadcast left it.
    for (const rung of RUNGS) {
      expect(sequenceAt(ended, rung)).toBeGreaterThanOrEqual(
        sequenceAt(later, rung)
      );
      const res = await pull(station, rung, sequenceAt(ended, rung));
      await res.arrayBuffer();
      expect(res.status).toBe(200);
    }
  });
});

describe('the origin serves no playlist, anywhere', () => {
  it('answers nothing at any playlist-shaped address', async () => {
    for (const path of [
      '/index.m3u8',
      '/playlist.m3u8',
      '/master.m3u8',
      '/now.m3u8',
      '/now/index.m3u8',
      '/now/playlist.m3u8',
      '/segments/index.m3u8',
      '/segments/master.m3u8',
      `/segments/${VIDEO_RUNG}/index.m3u8`,
      `/segments/${VIDEO_RUNG}/playlist.m3u8`,
      `/segments/${AUDIO_RUNG}/index.m3u8`,
      '/hls/index.m3u8',
      '/live/index.m3u8',
    ]) {
      const res = await get(station, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('reports the edge as sequence numbers, not as a playlist', async () => {
    const { text, body } = await readNow(station);

    // Not HLS-shaped and not URI-carrying: the client daemon synthesizes
    // whatever playlist its player wants over loopback, and a station serves
    // nothing free.
    expect(text).not.toContain('#EXTM3U');
    expect(text).not.toContain('.m3u8');
    expect(text).not.toContain('http');
    expect(text).not.toContain('.ts');

    // Nor does it price anything: a station's rungs and their prices are
    // learned from the announcement a hub's relay carries.
    expect(text).not.toMatch(/price|amount|cost/i);
    expect(Object.keys(body).sort()).toEqual([
      'live',
      'rungs',
      'segmentSeconds',
    ]);
  });
});

describe('the now address is priced on its own, and holds no payment code', () => {
  it('sits outside /segments, and beneath no rung', async () => {
    // The connector in front terminates one route on `/now` at its own low
    // price. If the same report were reachable beneath a rung's prefix, a
    // viber could pay a segment's price for it — or, worse, a segment's price
    // could be dodged by dressing it as a now.
    for (const path of [
      '/segments/now',
      '/segments/now.ts',
      `/segments/${VIDEO_RUNG}/now`,
      `/segments/${VIDEO_RUNG}/now.ts`,
      `/segments/${AUDIO_RUNG}/now`,
      '/now/segments',
      `/now/${VIDEO_RUNG}`,
      `/now/${VIDEO_RUNG}/0.ts`,
    ]) {
      const res = await get(station, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('is not liveness, and liveness is not it', async () => {
    // `/health` is unpriced process liveness for a supervisor inside the node.
    // It answers the same whether or not anybody is broadcasting, so it cannot
    // stand in for the station's now — and the now cannot stand in for it.
    const health = await get(station, '/health');
    const body = (await health.json()) as Record<string, unknown>;

    expect(health.status).toBe(200);
    expect(body['status']).toBe('healthy');
    expect(body['live']).toBeUndefined();
    expect(body['rungs']).toBeUndefined();
    expect(body['segmentSeconds']).toBeUndefined();
  });

  it('requires no payment header, reads none, and echoes none', async () => {
    // No headers at all. By the time a request reaches the origin the
    // connector in front has already proven it paid.
    const bare = await readNow(station);
    expect(bare.res.status).toBe(200);

    // A payment-shaped header changes nothing and comes back nowhere.
    const noisy = await readNow(station, {
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
