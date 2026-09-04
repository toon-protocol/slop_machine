/**
 * Retention, exercised the way a viber and a broadcaster meet it.
 *
 * It boots the real app on fresh ports against a temporary directory with a
 * deliberately small window, pushes a real broadcast at the real ingest port
 * **in real time** — `-re`, a generated picture and a tone, which is what a
 * broadcaster's software actually does — lets the window roll past, and then
 * asserts **entirely over plain HTTP**.
 *
 * Nothing here reaches inside the segmenter, the `ffmpeg` invocation or the
 * on-disk layout — the acceptance criterion is that eviction is observed over
 * HTTP, so "the disk stays bounded" is asserted as *what a viber can buy*:
 * however long the broadcast ran, only the last few sequences at a rung come
 * back, and every older one is a clean miss. How those files are laid out, or
 * removed, must stay rewritable without touching this file.
 *
 * The broadcast is pushed in real time on purpose. Retention is a claim about
 * a broadcast that *keeps running* — a publish flushed as fast as the box can
 * encode is over before a window can roll past it, and "eviction happens on its
 * own during a running broadcast" is then unobservable.
 *
 * Every expected value is written out here as a literal rather than imported,
 * so a broken window fails this file instead of quietly agreeing with itself.
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
 * compose file. Two rungs of different shapes, so the window is shown to be
 * the same window at every price.
 */
const LADDER = 'audio:64k, small:360:500k:64k';
const AUDIO_RUNG = 'audio';
const VIDEO_RUNG = 'small';
const RUNGS = [AUDIO_RUNG, VIDEO_RUNG];

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/**
 * The window the suite runs: four segments, eight seconds of vibes. Small
 * enough that a broadcast rolls several segments out of it, large enough that
 * the sequence *now* names is still there a moment later.
 */
const RETAIN = 4;

/** The default window, written out rather than imported. */
const DEFAULT_RETAIN = 60;

/** How long a broadcast the suite pushes, in real time, in seconds. */
const BROADCAST_SECONDS = 20;

/**
 * The bound each rung claims per segment, from ADR 0001's arithmetic plus the
 * MPEG-TS carriage allowance the segment suite uses — so the disk bound below
 * is `window × worst case`, a number an operator can compute from the two
 * lines of configuration they wrote.
 *
 *   audio: 64 000 × 2 ÷ 8                       =  16 000 bytes
 *   small: (500 000 × 3 + 64 000 × 2) ÷ 8       = 203 500 bytes
 */
const WORST_CASE_BYTES: Record<string, number> = {
  [AUDIO_RUNG]: Math.ceil(16_000 * 1.03) + 12 * 1024,
  [VIDEO_RUNG]: Math.ceil(203_500 * 1.03) + 12 * 1024,
};

/**
 * The station's *now*, written out here rather than imported, so a change to
 * the shape a viber depends on fails this file.
 */
interface NowBody {
  live: boolean;
  segmentSeconds: number;
  rungs: { rung: string; sequence: number | null }[];
}

/** What a viber gets back when a span cannot be served. */
interface MissBody {
  error: string;
  message: string;
}

/** One sequence, as the station answered for it. */
interface Answer {
  sequence: number;
  status: number;
  bytes: number;
  contentType: string | null;
}

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** The one station every read-side assertion shares, broadcast to once. */
let station: OriginInstance;
/** The station's *now*, read mid-broadcast once the window had rolled past. */
let rolling: NowBody;
/** What sequence 0 came back as, mid-broadcast, at every rung. */
let evictedWhileLive: Record<string, Answer>;
/** What the sequence *now* named came back as, mid-broadcast, at every rung. */
let edgeWhileLive: Record<string, Answer>;
/** The station's *now* once the broadcaster had gone and the edge settled. */
let ended: NowBody;
/** Every sequence the settled station will still serve, per rung. */
let held: Record<string, Answer[]>;

beforeAll(async () => {
  station = await boot({ retainSegments: RETAIN });

  // Not awaited: retention is about a broadcast that keeps running, so the
  // window has to roll past *while* the suite is watching.
  const broadcast = publish({ origin: station, streamKey: keyOf(station) });

  // Two segments past the window at every rung, so sequences 0 and 1 are
  // certainly gone while the broadcaster is still publishing.
  rolling = await until(
    station,
    (now) =>
      now.live &&
      now.rungs.every((rung) => (rung.sequence ?? -1) >= RETAIN + 2),
    'the broadcast never ran far enough past the window to evict anything'
  );

  evictedWhileLive = {};
  edgeWhileLive = {};
  for (const rung of RUNGS) {
    evictedWhileLive[rung] = await pull(station, rung, 0);
    edgeWhileLive[rung] = await pull(station, rung, sequenceAt(rolling, rung));
  }

  await broadcast;
  await until(
    station,
    (now) => !now.live,
    'the station kept reporting ingest as live after the broadcaster had gone'
  );
  ended = await still(station);

  // Walked once the edge has stopped moving, so the answers are all about one
  // station at one moment rather than a race with the encoder.
  held = {};
  for (const rung of RUNGS) {
    held[rung] = await walk(station, rung, sequenceAt(ended, rung));
  }
}, 300_000);

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
  const dir = mkdtempSync(join(tmpdir(), 'station-retention-'));
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

/** The error a station refused to start with. */
async function refusal(config: Partial<OriginConfig>): Promise<Error> {
  try {
    await boot(config);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the origin started when it should have refused');
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

function get(origin: OriginInstance, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(origin.config.segmentPort)}${path}`);
}

/** Pull one segment and keep only what a viber could see of the answer. */
async function pull(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<Answer> {
  const res = await get(origin, `/segments/${rung}/${String(sequence)}.ts`);
  const body = await res.arrayBuffer();
  return {
    sequence,
    status: res.status,
    bytes: body.byteLength,
    contentType: res.headers.get('content-type'),
  };
}

/** Why a station refused a span, as a player reads it. */
async function miss(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<{ status: number; body: MissBody }> {
  const res = await get(origin, `/segments/${rung}/${String(sequence)}.ts`);
  return { status: res.status, body: (await res.json()) as MissBody };
}

/** Every sequence from the beginning of the broadcast to the edge, answered. */
async function walk(
  origin: OriginInstance,
  rung: string,
  edge: number
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (let sequence = 0; sequence <= edge; sequence += 1) {
    answers.push(await pull(origin, rung, sequence));
  }
  return answers;
}

/** Read the station's *now*, as a viber does: one GET, one address. */
async function readNow(
  origin: OriginInstance
): Promise<{ body: NowBody; text: string }> {
  const res = await get(origin, '/now');
  const text = await res.text();
  return { body: JSON.parse(text) as NowBody, text };
}

/** What that answer says the live edge is at one rung. */
function sequenceAt(now: NowBody, rung: string): number {
  const found = now.rungs.find((reported) => reported.rung === rung);
  if (found === undefined || found.sequence === null) {
    throw new Error(`now reported no sequence at rung "${rung}"`);
  }
  return found.sequence;
}

/** Read *now* until it says something, or give up loudly. */
async function until(
  origin: OriginInstance,
  holds: (now: NowBody) => boolean,
  complaint: string,
  timeoutMs = 90_000
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

/** The sequences a walk found the station still willing to serve. */
function servable(answers: Answer[]): Answer[] {
  return answers.filter((answer) => answer.status === 200);
}

function answerAt(answers: Record<string, Answer>, rung: string): Answer {
  const answer = answers[rung];
  if (answer === undefined) throw new Error(`nothing recorded for "${rung}"`);
  return answer;
}

function heldAt(rung: string): Answer[] {
  const answers = held[rung];
  if (answers === undefined) throw new Error(`nothing walked for "${rung}"`);
  return answers;
}

// ---------- The tests ----------

describe('a station on a long broadcast', () => {
  it('evicts stale segments on its own, while the broadcaster is still publishing', () => {
    // Nobody asked it to. The broadcast ran past the window and the oldest
    // spans went, with ingest still open — which is the whole claim: a
    // broadcast that runs for days does not fill the broadcaster's disk.
    expect(rolling.live).toBe(true);

    for (const rung of RUNGS) {
      expect(sequenceAt(rolling, rung)).toBeGreaterThanOrEqual(RETAIN + 2);
      expect(answerAt(evictedWhileLive, rung).status).toBe(404);
    }
  });

  it('keeps only the window, however long the broadcast ran', () => {
    for (const rung of RUNGS) {
      const answers = heldAt(rung);
      const kept = servable(answers);

      // The broadcast produced more spans than the window holds — otherwise
      // this file would be asserting nothing at all.
      expect(answers.length).toBeGreaterThan(RETAIN);
      // And the station is holding at most the window, not the broadcast.
      expect(kept.length).toBeLessThanOrEqual(RETAIN);
      expect(kept.length).toBeGreaterThan(0);
    }
  });

  it('keeps the newest spans, contiguously, ending at the live edge', () => {
    for (const rung of RUNGS) {
      const kept = servable(heldAt(rung)).map((answer) => answer.sequence);
      const oldest = kept[0] ?? 0;

      // The window slides: what is kept is the run of sequences ending at the
      // edge, so a viber walking forward from *now* never falls into a hole.
      expect(kept[kept.length - 1]).toBe(sequenceAt(ended, rung));
      expect(kept).toEqual(kept.map((_, index) => oldest + index));
    }
  });

  it('bounds what is on disk to the window times the ladder, in bytes a viber can pull', () => {
    // The disk bound is arithmetic an operator can do from their own
    // configuration — window × worst-case segment — and this is that same
    // number, measured as the only bytes the station will hand out.
    for (const rung of RUNGS) {
      const kept = servable(heldAt(rung));
      const bytes = kept.reduce((total, answer) => total + answer.bytes, 0);
      const bound = RETAIN * (WORST_CASE_BYTES[rung] ?? 0);

      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(bound);
    }
  });
});

describe('a viber asking for a span that has gone', () => {
  it('is refused cleanly, with no stale body', async () => {
    const gone = servable(heldAt(VIDEO_RUNG))[0]?.sequence ?? 0;
    const stale = await pull(station, VIDEO_RUNG, gone - 1);

    expect(stale.status).toBe(404);
    // Not vibes. A viber who paid for this address must not be handed
    // something that looks playable.
    expect(stale.contentType).not.toBe('video/mp2t');
    expect(stale.contentType).toMatch(/application\/json/);
  });

  it('is told to re-sync rather than to fall back to another rung', async () => {
    // The two misses call for different moves from a player, so they are told
    // apart: a sequence that has gone means re-sync to the live edge, a rung
    // that does not exist means fall back to one that does. One shrug for both
    // would make each look like the other.
    const evicted = await miss(station, VIDEO_RUNG, 0);
    const absent = await miss(station, '4k', 0);

    expect(evicted.status).toBe(404);
    expect(evicted.body.error).toBe('unknown_segment');

    expect(absent.status).toBe(404);
    expect(absent.body.error).toBe('unknown_rung');

    expect(evicted.body.error).not.toBe(absent.body.error);
  });

  it('cannot tell an evicted span from one that never existed, and need not', async () => {
    // Both are "the station is not holding that": a viber's move is the same
    // either way, and a station that distinguished them would be reporting
    // what it used to have, which is what a *now* is for.
    const evicted = await miss(station, VIDEO_RUNG, 0);
    const never = await miss(station, VIDEO_RUNG, 999_999);

    expect(evicted.body.error).toBe('unknown_segment');
    expect(never.body.error).toBe('unknown_segment');
  });

  it('is refused the same way at every rung on the ladder', async () => {
    for (const rung of RUNGS) {
      const gone = await miss(station, rung, 0);
      expect(gone.status).toBe(404);
      expect(gone.body.error).toBe('unknown_segment');
    }
  });
});

describe("the station's now stays honest as segments fall out of the window", () => {
  it('names a span that is still there, mid-broadcast', () => {
    // The edge is never evicted, so the one paid request a viber makes to find
    // the live edge sends them somewhere they can actually buy — while the
    // window behind it is rolling.
    for (const rung of RUNGS) {
      const edge = answerAt(edgeWhileLive, rung);
      expect(edge.sequence).toBe(sequenceAt(rolling, rung));
      expect(edge.status).toBe(200);
      expect(edge.contentType).toBe('video/mp2t');
      expect(edge.bytes).toBeGreaterThan(0);
    }
  });

  it('names a span that is still there once the broadcaster has gone', async () => {
    expect(ended.live).toBe(false);

    for (const rung of RUNGS) {
      const edge = await pull(station, rung, sequenceAt(ended, rung));
      expect(edge.status).toBe(200);
      expect(edge.bytes).toBeGreaterThan(0);
    }
  });

  it('reports the same duration and the same rungs it always did', () => {
    // Retention takes spans away; it does not change what the station is.
    expect(ended.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(ended.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });
});

describe('a station restarted on the window it already had', () => {
  it('keeps serving that window, and numbers the next span after it', async () => {
    // The hazard eviction introduces: a window that has been evicting no
    // longer starts at sequence 0, and a station that walked forward from zero
    // to find its place would find nothing, restart the numbering, and serve
    // different vibes at an address a viber has already paid for.
    const again = await boot({ dataDir: station.config.dataDir });
    const { body } = await readNow(again);

    for (const rung of RUNGS) {
      expect(sequenceAt(body, rung)).toBe(sequenceAt(ended, rung));

      // The window it had is still servable — a restart is not a reason to
      // drop every viber at once.
      const edge = await pull(again, rung, sequenceAt(body, rung));
      expect(edge.status).toBe(200);
      expect(edge.bytes).toBeGreaterThan(0);

      // And what was evicted is still gone, rather than re-appearing because
      // somebody counted from the beginning.
      const gone = await miss(again, rung, 0);
      expect(gone.status).toBe(404);
      expect(gone.body.error).toBe('unknown_segment');
    }
  });
});

describe('the window is configuration', () => {
  it('is what the station was told, and is reported back', () => {
    expect(station.config.retainSegments).toBe(RETAIN);
  });

  it('defaults to the placeholder window when nothing is configured', async () => {
    const ordinary = await boot();

    expect(ordinary.config.retainSegments).toBe(DEFAULT_RETAIN);
  });

  it('refuses to start on a window that would keep nothing', async () => {
    for (const retainSegments of [0, -1]) {
      const error = await refusal({ retainSegments });
      // Fail-closed and named, the same posture as a ladder over the byte
      // budget: a station that kept nothing would look live and sell nothing.
      expect(error.name).toBe('RetentionError');
      expect(error.message).toContain(String(retainSegments));
    }
  });

  it('refuses a window that is not a whole number of segments', async () => {
    const error = await refusal({ retainSegments: 2.5 });

    expect(error.name).toBe('RetentionError');
  });
});
