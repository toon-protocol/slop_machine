/**
 * The slot app, exercised the way a hub operator meets it.
 *
 * Every assertion here is over what the app does at its boundary: the suite
 * boots the real app on a fresh port against a temporary directory, with real
 * credential files mounted in that directory, speaks plain HTTP at it, and
 * tears it down. Nothing reaches inside — how the app reads a credential file,
 * what it lays out in its data directory, and (from #34 onward) how it derives
 * a handle or signs an operator write must all stay rewritable without
 * touching this file.
 *
 * What is covered in THIS file is the boot, and only the boot — the quote a
 * broadcaster buys against lives in `../quote/quote.test.ts`:
 *   - the app boots on a *configured* port against a *configured* directory
 *     and answers liveness there;
 *   - the port is configuration, not a constant — two apps run side by side;
 *   - the two unpriced addresses — liveness, and the hub operator's roster —
 *     require no payment header, read none, and echo none, and stay that way
 *     now that a paid address exists beside them;
 *   - both operator credentials are named by path, both are required, and the
 *     refusal says which one is wrong;
 *   - neither credential value reaches a log line, an error message, or the
 *     app's own resolved configuration.
 *
 * The paid surface a broadcaster buys at — `GET /quote` (#34), and the buy
 * that establishes the peering (#35 onward) — is deliberately not asserted
 * here. The quote has its own suite beside the module that serves it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startSlotApp } from './slot-app.js';
import type { SlotAppConfig, SlotAppInstance } from './slot-app.js';
import { VERSION } from '../version.js';

/**
 * The liveness response, written out here rather than imported, so that a
 * change to the shape a hub operator's supervisor depends on fails this file
 * instead of quietly agreeing with itself.
 */
interface LivenessBody {
  status: 'healthy';
  service: 'slot-app';
  version: string;
  timestamp: number;
}

const running: SlotAppInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Booting a real app, the way a hub node does ----------

/** A fresh temporary directory for one app, removed after the test. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-app-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * One throwaway credential, mounted at a file the way a hub's compose file
 * mounts the real thing. Fresh per call and random: no credential literal
 * belongs in this repository, not even a test's.
 *
 * Both are what a hub operator's own `openssl rand -hex 32` writes — 64 hex
 * characters — because that is what the write key has to be: a 32-byte
 * ed25519 seed the app signs its operator writes with, whose public half goes
 * on the connector's allowlist.
 */
function mountCredential(
  dir: string,
  name: string
): { path: string; value: string } {
  const value = randomBytes(32).toString('hex');
  const path = join(dir, name);
  // A trailing newline, because that is what an operator's `openssl ... >` or
  // an editor leaves behind, and the app must read past it.
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return { path, value };
}

interface Mounted {
  dir: string;
  writeKey: { path: string; value: string };
  bearerToken: { path: string; value: string };
}

/** A data directory with both operator credentials mounted beside it. */
function mountCredentials(): Mounted {
  const dir = freshDir();
  return {
    dir,
    writeKey: mountCredential(dir, 'operator-signing.key'),
    bearerToken: mountCredential(dir, 'operator-bearer.token'),
  };
}

/** Boot a real slot app on an ephemeral port; every field is overridable. */
async function boot(
  config: Partial<SlotAppConfig> = {},
  mounted: Mounted = mountCredentials()
): Promise<SlotAppInstance> {
  const app = await startSlotApp({
    slotPort: 0,
    host: '127.0.0.1',
    dataDir: mounted.dir,
    // Configuration, never an injected port. Nothing in this file makes an
    // operator write, so this one is never dialled; the buy's own suite
    // points it at a fake operator surface that verifies for real.
    operatorUrl: 'http://127.0.0.1:1',
    operatorWriteKeyFile: mounted.writeKey.path,
    operatorBearerTokenFile: mounted.bearerToken.path,
    ...config,
  });
  running.push(app);
  return app;
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

function appUrl(app: SlotAppInstance, path: string): string {
  return `http://127.0.0.1:${String(app.config.slotPort)}${path}`;
}

/**
 * Everything the app wrote to its own log while `run` was in flight — which is
 * what a hub operator reads in `docker logs`, and therefore where a leaked
 * credential would actually surface.
 */
async function logsDuring(run: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const record = (...args: unknown[]): void => {
    written.push(args.map((arg) => String(arg)).join(' '));
  };
  const log = console.log;
  const error = console.error;
  console.log = record;
  console.error = record;
  try {
    await run().catch(() => undefined);
  } finally {
    console.log = log;
    console.error = error;
  }
  return written.join('\n');
}

/** The refusal a boot produced, as the operator would read it. */
async function refusal(config: Partial<SlotAppConfig>): Promise<Error> {
  try {
    running.push(await boot(config));
  } catch (error) {
    return error as Error;
  }
  throw new Error('the slot app started when it should have refused');
}

// ---------- The tests ----------

describe('the slot app', () => {
  it('boots on a configured port against a configured directory and answers liveness', async () => {
    const port = await reservePort();
    const mounted = mountCredentials();

    const app = await boot({ slotPort: port }, mounted);

    expect(app.isRunning()).toBe(true);
    expect(app.config.slotPort).toBe(port);
    expect(app.config.dataDir).toBe(mounted.dir);

    const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
    const body = (await res.json()) as LivenessBody;

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(body).toMatchObject({
      status: 'healthy',
      service: 'slot-app',
      version: VERSION,
    });
    // A supervisor deciding whether to restart wants to know the answer is
    // this process's, now — not a cached one from before it died.
    expect(typeof body.timestamp).toBe('number');
  });

  it('runs two hubs side by side, each on its own port', async () => {
    // The port is configuration, which is what lets the suite boot on fresh
    // ports and a hub operator move the app without a code change.
    const first = await boot();
    const second = await boot();

    expect(first.config.slotPort).not.toBe(second.config.slotPort);
    expect(first.config.dataDir).not.toBe(second.config.dataDir);

    for (const app of [first, second]) {
      const res = await fetch(appUrl(app, '/health'));
      expect(res.status).toBe(200);
    }
  });

  it('stops, and stopping twice is not an error', async () => {
    const app = await boot();
    const { slotPort } = app.config;

    await app.stop();
    await app.stop();

    expect(app.isRunning()).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${String(slotPort)}/health`)
    ).rejects.toBeDefined();
  });

  it('answers nothing at an address it does not serve', async () => {
    const app = await boot();

    for (const path of ['/', '/slots', '/peers', '/healthz', '/rosters']) {
      const res = await fetch(appUrl(app, path));
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });
});

describe('the hub operator surface', () => {
  it('refuses to start with none configured', async () => {
    const error = await refusal({ operatorUrl: undefined });

    // An app that cannot reach an operator surface can admit nobody, and a
    // hub that can admit nobody must look broken rather than look fine.
    expect(error.name).toBe('PeeringPolicyError');
    expect(error.message).toContain('TOON_OPERATOR_URL');
  });

  it('refuses to start on one that is not an http URL', async () => {
    for (const operatorUrl of [
      'connector:3000',
      'ftp://connector',
      'nonsense',
    ]) {
      const error = await refusal({ operatorUrl });
      expect(error.name).toBe('PeeringPolicyError');
      expect(error.message).toContain('TOON_OPERATOR_URL');
    }
  });

  it('reports where it is and the terms the hub peers on', async () => {
    const app = await boot({
      operatorUrl: 'http://connector:3000/',
      peeringFee: 25,
      peeringMaxPacketAmount: 12_345,
    });

    // Ordinary configuration, all of it readable back and none of it secret —
    // and a broadcaster never chooses any of it.
    expect(app.config.peering).toEqual({
      operatorUrl: 'http://connector:3000',
      fee: 25,
      maxPacketAmount: 12_345,
      // Unset above, so this is the DEFAULT, written out here rather than
      // read back off the app: a hub reads a station connector over https
      // only unless its operator said otherwise, and a default that flipped
      // would fail here instead of on a live box.
      allowPlaintextStationUrls: false,
    });
  });
});

describe('the unpriced addresses are unpriced, and the app holds no payment code', () => {
  it('requires no payment header, reads none, and echoes none', async () => {
    const app = await boot();

    // BOTH of them, on the same terms. Liveness is what a supervisor inside
    // the node dials and the roster is what the hub operator reads; neither is
    // ever paid, because the app port is published on no interface and neither
    // address has a route on the hub's connector.
    for (const path of ['/health', '/roster']) {
      // No headers at all.
      const bare = await fetch(appUrl(app, path));
      const bareBody = await bare.text();
      expect({ path, status: bare.status }).toEqual({ path, status: 200 });

      // Payment-shaped headers change nothing and come back nowhere. The app
      // holds no payment code, so these addresses neither require nor read
      // one — the three attribution headers a terminating connector states
      // are read by the paid surface and by nothing else.
      const noisy = await fetch(appUrl(app, path), {
        headers: {
          'x-payment': 'not-read',
          'x-toon-payer': 'evm:0xnot-read',
          'x-toon-amount': '999999',
          'x-toon-chain': 'not-read',
          authorization: 'Bearer not-read',
        },
      });
      const noisyBody = await noisy.text();

      expect({ path, status: noisy.status }).toEqual({ path, status: 200 });
      for (const header of [
        'x-payment',
        'x-payment-response',
        'x-toon-payer',
        'x-toon-amount',
        'x-toon-chain',
        'authorization',
        'www-authenticate',
      ]) {
        expect({ path, header, got: noisy.headers.get(header) }).toEqual({
          path,
          header,
          got: null,
        });
      }
      for (const sent of ['not-read', '999999', 'evm:0xnot-read']) {
        expect(noisyBody).not.toContain(sent);
        expect(bareBody).not.toContain(sent);
      }
    }
  });

  it('prices nothing and says nothing about money', async () => {
    const app = await boot();

    const body = await (await fetch(appUrl(app, '/health'))).text();

    // Pricing a route is connector configuration. Nothing this app answers
    // carries a price, an amount, or a settlement fact.
    expect(body).not.toMatch(/price|amount|cost|settle|claim/i);
    expect(Object.keys(JSON.parse(body) as LivenessBody).sort()).toEqual([
      'service',
      'status',
      'timestamp',
      'version',
    ]);
  });
});

describe('the two operator credentials', () => {
  it('refuses to start with no operator write key, and says which one', async () => {
    const error = await refusal({ operatorWriteKeyFile: undefined });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('operator write key');
    expect(error.message).toContain('TOON_OPERATOR_WRITE_KEY_FILE');
    // Not the other one: a hub operator with two mounts to check is told which
    // of them is wrong.
    expect(error.message).not.toContain('bearer');
  });

  it('refuses to start with no operator bearer token, and says which one', async () => {
    const error = await refusal({ operatorBearerTokenFile: undefined });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('operator bearer token');
    expect(error.message).toContain('TOON_OPERATOR_BEARER_TOKEN_FILE');
    expect(error.message).not.toContain('write key');
  });

  it('refuses to start when a credential file is missing, naming that file', async () => {
    const missing = join(freshDir(), 'operator-signing.key');

    const error = await refusal({ operatorWriteKeyFile: missing });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('operator write key');
    expect(error.message).toContain(missing);
  });

  it('refuses to start when a credential file is unreadable, naming that file', async () => {
    // The ordinary form of this on a real box: a bind mount whose source did
    // not exist, so the daemon created a DIRECTORY at the path the app was
    // told to read a token from. The mount looks fine in `docker inspect`.
    const dir = freshDir();
    const notAFile = join(dir, 'operator-bearer.token');
    mkdirSync(notAFile);

    const error = await refusal({ operatorBearerTokenFile: notAFile });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('operator bearer token');
    expect(error.message).toContain(notAFile);
  });

  it('refuses to start on an empty credential file', async () => {
    const dir = freshDir();
    const empty = join(dir, 'operator-signing.key');
    writeFileSync(empty, '\n', { mode: 0o600 });

    const error = await refusal({ operatorWriteKeyFile: empty });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('operator write key');
    expect(error.message).toContain(empty);
  });

  it('reports the paths it read and never the values', async () => {
    const mounted = mountCredentials();

    const app = await boot({}, mounted);

    // A path is not a secret, and an operator fixing a bad mount needs to see
    // which file the app took.
    expect(app.config.operatorWriteKeyFile).toBe(mounted.writeKey.path);
    expect(app.config.operatorBearerTokenFile).toBe(mounted.bearerToken.path);

    // The values are not on the config, at any depth and under any name.
    const serialized = JSON.stringify(app.config);
    expect(serialized).not.toContain(mounted.writeKey.value);
    expect(serialized).not.toContain(mounted.bearerToken.value);
  });

  it('keeps both values out of the log, on a boot and on a refusal', async () => {
    const mounted = mountCredentials();

    const booted = await logsDuring(async () => {
      running.push(await boot({}, mounted));
    });

    // The app announces itself and names its mounts — that is what an
    // operator needs — and carries neither value while doing it.
    expect(booted).toContain('[slot-app]');
    expect(booted).toContain(mounted.writeKey.path);
    expect(booted).not.toContain(mounted.writeKey.value);
    expect(booted).not.toContain(mounted.bearerToken.value);

    // A refusal is the other place a secret escapes: the message an operator
    // is shown when the mount is wrong.
    const refused = await logsDuring(async () => {
      const error = await refusal({ operatorWriteKeyFile: undefined });
      console.error(`[slot-app] ${error.name}: ${error.message}`);
    });

    expect(refused).toContain('OperatorCredentialError');
    expect(refused).not.toContain(mounted.writeKey.value);
    expect(refused).not.toContain(mounted.bearerToken.value);
  });

  it('refuses to start on a write key it could never sign with', async () => {
    const dir = freshDir();
    const notASeed = join(dir, 'operator-signing.key');
    // What an operator gets by generating the wrong thing, or by mounting the
    // PUBLIC half. Refused at boot rather than at the first purchase: the
    // symptom otherwise is a 401 on a broadcaster who already paid.
    writeFileSync(notASeed, 'not-an-ed25519-seed\n', { mode: 0o600 });

    const error = await refusal({ operatorWriteKeyFile: notASeed });

    expect(error.name).toBe('OperatorCredentialError');
    expect(error.message).toContain('64 hex characters');
    expect(error.message).not.toContain('not-an-ed25519-seed');
  });

  it('answers liveness while holding them, without mentioning them', async () => {
    const mounted = mountCredentials();

    const app = await boot({}, mounted);
    const res = await fetch(appUrl(app, '/health'));
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const value of [mounted.writeKey.value, mounted.bearerToken.value]) {
      expect(body).not.toContain(value);
      expect([...res.headers.values()].join('\n')).not.toContain(value);
    }
  });
});
