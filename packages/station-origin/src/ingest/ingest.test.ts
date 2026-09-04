/**
 * Integration tests for the station origin's ingest door.
 *
 * Every assertion here is over what a *publishing client* observes. The suite
 * boots the real origin on fresh ports against a temporary directory and then
 * points real `ffmpeg` at the real ingest port over real RTMP and RTMPS —
 * because "OBS says it worked" and "OBS says the key is wrong" are the only
 * two outcomes a broadcaster ever sees, and they are what the ticket promises.
 *
 * Nothing reaches inside the RTMP session, the chunk parser, or the stream-key
 * comparison. All three must be rewritable without touching this file.
 *
 * What is covered (issue #6):
 *   - a publish carrying the right stream key is accepted, over RTMP and over
 *     RTMPS, and the vibes that follow arrive as a playable span;
 *   - a publish carrying a wrong key, or no key at all, is refused at the
 *     publish command, the publisher is told why, and no vibes are handed over;
 *   - one station's key does not work on another station;
 *   - going live needs a stream key and nothing else — no payment, no header,
 *     no account.
 *
 * `ffmpeg` and `openssl` must be on PATH. Ingest is a wire protocol; a suite
 * that spoke it through a mock would be testing the mock.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOrigin } from '../origin/origin.js';
import type { OriginConfig, OriginInstance } from '../origin/origin.js';
import type { IngestSession } from './ingest.js';

/**
 * A throwaway key, fresh per run. No stream key literal belongs in this repo,
 * not even a test's: the rule is easier to hold when there is no exception to
 * point at.
 */
const STATION_KEY = `test-station-key-${randomUUID()}`;

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

/** A throwaway certificate for the RTMPS tests, generated per run and never committed. */
let tls: { certFile: string; keyFile: string };

beforeAll(() => {
  const dir = freshDir();
  const certFile = join(dir, 'ingest.cert.pem');
  const keyFile = join(dir, 'ingest.key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' }
  );
  tls = { certFile, keyFile };
});

afterEach(async () => {
  for (const origin of running.splice(0)) {
    await origin.stop();
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temporary directory removed when the suite finishes. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-ingest-'));
  tempDirs.push(dir);
  return dir;
}

/** Boot a real origin with a real ingest port, both ephemeral. */
async function boot(
  config: Partial<OriginConfig> = {}
): Promise<OriginInstance> {
  const origin = await startOrigin({
    segmentPort: 0,
    ingestPort: 0,
    host: '127.0.0.1',
    ingestHost: '127.0.0.1',
    dataDir: freshDir(),
    streamKey: STATION_KEY,
    ...config,
  });
  running.push(origin);
  return origin;
}

interface PublishResult {
  /** ffmpeg's exit code. `0` means the publish ran to completion. */
  code: number | null;
  /** Everything ffmpeg said. A refusal shows up here, as it does in OBS. */
  output: string;
}

/**
 * Publish a short generated broadcast at a station, exactly as a broadcaster's
 * software would: a URL, a stream key as the stream name, and nothing else.
 */
function publish(options: {
  origin: OriginInstance;
  streamKey?: string | undefined;
  app?: string;
  secure?: boolean;
  seconds?: number;
}): Promise<PublishResult> {
  const {
    origin,
    streamKey,
    app = 'live',
    secure = false,
    seconds = 2,
  } = options;
  const scheme = secure ? 'rtmps' : 'rtmp';
  const path = streamKey === undefined ? app : `${app}/${streamKey}`;
  const url = `${scheme}://127.0.0.1:${origin.config.ingestPort}/${path}`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=160x120:rate=15:duration=${String(seconds)}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '200k',
    '-c:a',
    'aac',
    '-b:a',
    '32k',
    '-t',
    String(seconds),
    ...(secure ? ['-tls_verify', '0'] : []),
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

/** Capture the vibes an accepted publish hands over, so they can be probed. */
function collector(): {
  onIngest: (session: IngestSession) => void;
  sessions: IngestSession[];
  vibes(): Promise<Buffer>;
} {
  const sessions: IngestSession[] = [];
  const chunks: Buffer[] = [];
  let done: (() => void) | undefined;
  const finished = new Promise<void>(
    (resolveFinished) => (done = resolveFinished)
  );

  return {
    sessions,
    onIngest(session) {
      sessions.push(session);
      session.vibes.on('data', (chunk: Buffer) => chunks.push(chunk));
      session.vibes.on('end', () => done?.());
    },
    async vibes() {
      await finished;
      return Buffer.concat(chunks);
    },
  };
}

describe('a broadcaster going live', () => {
  it('is accepted when the publish carries the station stream key', async () => {
    const origin = await boot();

    const result = await publish({ origin, streamKey: STATION_KEY });

    expect(result.output).not.toMatch(/Server error/i);
    expect(result.code).toBe(0);
  });

  it('needs a stream key and nothing else — ingest is never paid', async () => {
    // The publish below carries no credential of any kind beyond the stream
    // key: no payment, no token, no account. RTMP has nowhere to put one, and
    // the origin asks for nothing.
    const origin = await boot();

    const result = await publish({ origin, streamKey: STATION_KEY });

    expect(result.code).toBe(0);
    // Liveness stays unpaid and unchanged while a broadcast is in flight.
    const health = await fetch(
      `http://127.0.0.1:${origin.config.segmentPort}/health`
    );
    expect(health.status).toBe(200);
  });

  it('hands the accepted vibes over as a playable span', async () => {
    const captured = collector();
    const origin = await boot({ onIngest: captured.onIngest });

    const result = await publish({
      origin,
      streamKey: STATION_KEY,
      seconds: 3,
    });
    expect(result.code).toBe(0);

    const vibes = await captured.vibes();
    expect(captured.sessions).toHaveLength(1);
    expect(captured.sessions[0]?.app).toBe('live');
    expect(vibes.length).toBeGreaterThan(1024);

    // Probed as a whole file rather than inspected byte by byte: what matters
    // is that what arrived is decodable vibes, not how it was framed.
    const file = join(freshDir(), 'vibes.flv');
    writeFileSync(file, vibes);
    const probe = execFileSync(
      'ffprobe',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-show_entries',
        'stream=codec_type',
        '-show_entries',
        'format=format_name',
        '-of',
        'default=nw=1',
        file,
      ],
      { encoding: 'utf8' }
    );
    expect(probe).toMatch(/format_name=flv/);
    expect(probe).toMatch(/codec_type=video/);
    expect(probe).toMatch(/codec_type=audio/);
  });

  it('is accepted over RTMPS when a certificate is mounted', async () => {
    const origin = await boot({ ingestTls: tls });

    expect(origin.config.ingestTls).toBe(true);

    const result = await publish({
      origin,
      streamKey: STATION_KEY,
      secure: true,
    });

    expect(result.output).not.toMatch(/Server error/i);
    expect(result.code).toBe(0);
  });
});

describe('a publish the station will not take', () => {
  it('is refused at the publish, and the publisher is told why', async () => {
    const captured = collector();
    const origin = await boot({ onIngest: captured.onIngest });

    const result = await publish({
      origin,
      streamKey: `wrong-${randomUUID()}`,
    });

    // ffmpeg reports the RTMP error status the origin sent. This is the line a
    // broadcaster sees in OBS, and it arrives before any vibes are encoded.
    expect(result.output).toMatch(/Server error/i);
    expect(result.output).toMatch(/stream key/i);
    expect(result.code).not.toBe(0);
    expect(captured.sessions).toHaveLength(0);
  });

  it('is refused when it carries no stream key at all', async () => {
    const captured = collector();
    const origin = await boot({ onIngest: captured.onIngest });

    const result = await publish({ origin, streamKey: undefined });

    expect(result.output).toMatch(/Server error/i);
    expect(result.code).not.toBe(0);
    expect(captured.sessions).toHaveLength(0);
  });

  it('is refused over RTMPS too — TLS is not the gate, the key is', async () => {
    const captured = collector();
    const origin = await boot({ ingestTls: tls, onIngest: captured.onIngest });

    const result = await publish({
      origin,
      streamKey: `wrong-${randomUUID()}`,
      secure: true,
    });

    expect(result.output).toMatch(/Server error/i);
    expect(result.code).not.toBe(0);
    expect(captured.sessions).toHaveLength(0);
  });

  it('cannot broadcast as another station using its own key', async () => {
    const myKey = `mine-${randomUUID()}`;
    const mine = await boot({ streamKey: myKey });
    const theirs = await boot({ streamKey: `theirs-${randomUUID()}` });

    await expect(
      publish({ origin: mine, streamKey: myKey })
    ).resolves.toMatchObject({
      code: 0,
    });
    const crossed = await publish({ origin: theirs, streamKey: myKey });
    expect(crossed.code).not.toBe(0);
    expect(crossed.output).toMatch(/Server error/i);
  });

  it('stops being possible once the origin stops', async () => {
    const origin = await boot();
    await origin.stop();

    const result = await publish({ origin, streamKey: STATION_KEY });

    expect(result.code).not.toBe(0);
  });
});

describe('the stream key itself', () => {
  it('is read from a mounted file at startup', async () => {
    const keyFile = join(freshDir(), 'station.key');
    // Written the way an operator writes it: with a trailing newline.
    writeFileSync(keyFile, `${STATION_KEY}\n`);

    const origin = await boot({ streamKey: undefined, streamKeyFile: keyFile });

    const result = await publish({ origin, streamKey: STATION_KEY });
    expect(result.code).toBe(0);

    // The key is never reported back out of the origin.
    expect(JSON.stringify(origin.config)).not.toContain(STATION_KEY);
    expect(readFileSync(keyFile, 'utf8')).toContain(STATION_KEY);
  });

  it('refuses to start the origin when it is missing', async () => {
    await expect(
      startOrigin({
        segmentPort: 0,
        ingestPort: 0,
        host: '127.0.0.1',
        ingestHost: '127.0.0.1',
        dataDir: freshDir(),
      })
    ).rejects.toMatchObject({ name: 'StreamKeyError' });
  });

  it('refuses to start the origin when the mounted file is empty', async () => {
    const keyFile = join(freshDir(), 'empty.key');
    writeFileSync(keyFile, '\n');

    await expect(
      startOrigin({
        segmentPort: 0,
        ingestPort: 0,
        host: '127.0.0.1',
        ingestHost: '127.0.0.1',
        dataDir: freshDir(),
        streamKeyFile: keyFile,
      })
    ).rejects.toMatchObject({ name: 'StreamKeyError' });
  });

  it('refuses to start the origin when two sources disagree', async () => {
    await expect(
      startOrigin({
        segmentPort: 0,
        ingestPort: 0,
        host: '127.0.0.1',
        ingestHost: '127.0.0.1',
        dataDir: freshDir(),
        streamKey: STATION_KEY,
        streamKeyFile: join(freshDir(), 'also.key'),
      })
    ).rejects.toMatchObject({ name: 'StreamKeyError' });
  });

  it('refuses to start the origin when the certificate cannot be read', async () => {
    await expect(
      startOrigin({
        segmentPort: 0,
        ingestPort: 0,
        host: '127.0.0.1',
        ingestHost: '127.0.0.1',
        dataDir: freshDir(),
        streamKey: STATION_KEY,
        ingestTls: {
          certFile: join(freshDir(), 'absent.pem'),
          keyFile: join(freshDir(), 'absent.key'),
        },
      })
    ).rejects.toMatchObject({ name: 'IngestTlsError' });
  });
});
