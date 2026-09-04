/**
 * Integration tests for the station origin.
 *
 * Every assertion here is over what the app does at its boundary: the suite
 * boots the real origin on a fresh port against a temporary directory, speaks
 * plain HTTP at it, and tears it down. Nothing reaches inside the app — how
 * the origin lays out its data directory, and (from issue #7) how it segments
 * and encodes, must all be rewritable without touching this file.
 *
 * What is covered at this point in the chain (issues #5 and #6):
 *   - the origin boots on a *configured* port against a *configured*
 *     directory, and answers liveness there;
 *   - the port is configuration, not a constant — two origins run side by
 *     side on different ports against different directories;
 *   - liveness requires no payment header, reads none, and echoes none;
 *   - an address the origin does not serve fails cleanly;
 *   - stop() tears both listeners down.
 *
 * Ingest itself — the stream-key gate, and what a publishing client sees — is
 * `../ingest/ingest.test.ts`, which speaks real RTMP at the real ingest port.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startOrigin } from './origin.js';
import type { OriginConfig, OriginInstance } from './origin.js';
import { VERSION } from '../version.js';

const running: OriginInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const origin of running.splice(0)) {
    await origin.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temporary directory for one origin, removed after the test. */
function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-origin-'));
  tempDirs.push(dir);
  return dir;
}

/** Boot a real origin; the port defaults to an ephemeral one. */
async function boot(
  config: Partial<OriginConfig> = {}
): Promise<OriginInstance> {
  const origin = await startOrigin({
    segmentPort: 0,
    // The origin refuses to start without a stream key, so every boot supplies
    // one. What the key gates is ../ingest/ingest.test.ts's subject.
    streamKey: `test-station-key-${randomUUID()}`,
    ingestPort: 0,
    host: '127.0.0.1',
    ingestHost: '127.0.0.1',
    dataDir: freshDataDir(),
    ...config,
  });
  running.push(origin);
  return origin;
}

/** A port nothing is listening on, for the "the port is configured" test. */
function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('could not reserve a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

function originUrl(origin: OriginInstance, path: string): string {
  return `http://127.0.0.1:${origin.config.segmentPort}${path}`;
}

describe('the station origin', () => {
  it('boots on a configured port against a configured directory and answers liveness', async () => {
    const port = await reservePort();
    const dataDir = freshDataDir();

    const origin = await boot({ segmentPort: port, dataDir });

    expect(origin.isRunning()).toBe(true);
    expect(origin.config.segmentPort).toBe(port);
    expect(origin.config.dataDir).toBe(dataDir);

    const res = await fetch(`http://127.0.0.1:${port}/health`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'healthy',
      service: 'station-origin',
      version: VERSION,
    });
  });

  it('runs two stations side by side, each on its own port', async () => {
    const first = await boot();
    const second = await boot();

    expect(first.config.segmentPort).not.toBe(second.config.segmentPort);
    expect(first.config.ingestPort).not.toBe(second.config.ingestPort);
    expect(first.config.dataDir).not.toBe(second.config.dataDir);

    for (const origin of [first, second]) {
      const res = await fetch(originUrl(origin, '/health'));
      expect(res.status).toBe(200);
    }
  });

  it('answers liveness with no payment header, and echoes none back', async () => {
    const origin = await boot();

    // No headers at all: liveness is what a supervisor inside the node dials,
    // and it is never paid.
    const bare = await fetch(originUrl(origin, '/health'));
    expect(bare.status).toBe(200);

    // A payment-shaped header changes nothing and comes back nowhere: the
    // origin holds no payment code, so it neither requires nor reads one.
    const withHeaders = await fetch(originUrl(origin, '/health'), {
      headers: {
        'x-payment': 'not-read',
        authorization: 'Bearer not-read',
      },
    });
    expect(withHeaders.status).toBe(200);

    const body = (await withHeaders.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'service',
      'status',
      'timestamp',
      'version',
    ]);
    for (const header of [
      'x-payment',
      'x-payment-response',
      'authorization',
      'www-authenticate',
    ]) {
      expect(withHeaders.headers.get(header)).toBeNull();
    }
  });

  it('fails cleanly on an address it does not serve', async () => {
    const origin = await boot();

    const res = await fetch(originUrl(origin, '/not-an-address'));
    expect(res.status).toBe(404);
  });

  it('binds an ingest port alongside the segment port, and reports it', async () => {
    const origin = await boot();

    expect(origin.config.ingestPort).toBeGreaterThan(0);
    expect(origin.config.ingestPort).not.toBe(origin.config.segmentPort);
    // Plain RTMP until a certificate is mounted; the ingest suite covers RTMPS.
    expect(origin.config.ingestTls).toBe(false);
    // Nobody is publishing, so the station is not ingesting.
    expect(origin.isIngesting()).toBe(false);
  });

  it('never reports the stream key back out', async () => {
    const origin = await boot({ streamKey: 'a-very-distinctive-key' });

    expect(JSON.stringify(origin.config)).not.toContain(
      'a-very-distinctive-key'
    );
  });

  it('stops, and stops being reachable', async () => {
    const origin = await boot();
    const url = originUrl(origin, '/health');
    const ingestPort = origin.config.ingestPort;

    expect((await fetch(url)).status).toBe(200);

    await origin.stop();

    expect(origin.isRunning()).toBe(false);
    await expect(fetch(url)).rejects.toThrow();

    // Both listeners go, not just the served one: an origin that stopped
    // serving but kept ingesting would take a broadcaster live to nobody.
    await expect(connect(ingestPort)).rejects.toThrow();

    // stop() is idempotent — a supervisor may race a signal with a shutdown.
    await expect(origin.stop()).resolves.toBeUndefined();
  });
});

/** Open a bare TCP connection, to prove a port is or is not accepting. */
function connect(port: number): Promise<void> {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect();
    });
    socket.once('error', rejectConnect);
  });
}
