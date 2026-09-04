/**
 * The quote, as a broadcaster meets it.
 *
 * Every assertion here is over what a real app does at its HTTP boundary. The
 * suite boots `startSlotApp` on a fresh port against a temporary directory
 * with real credential files mounted in it, speaks plain HTTP at it with the
 * three attribution headers a terminating connector states, and reads the
 * answer. **Nothing reaches into handle derivation**: the payer goes in as a
 * header and a prefix comes back, and how one becomes the other is free to
 * change without touching this file. Nor does anything reach into the roster,
 * the data directory, or the app's wiring.
 *
 * The response shape is written out below rather than imported, so that a
 * change to what a broadcaster depends on fails this file instead of quietly
 * agreeing with itself.
 *
 * What this covers (issue #34): the prefix a caller would be granted and its
 * stability, the price and the period, capacity against the operator's cap,
 * the refusal for a request that did not arrive through a paid termination,
 * and that the quote's address is its own and not the buy's. The buy, the
 * peering, the routes and the roster's writer are #35 onward.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSlotApp } from '../slot-app/slot-app.js';
import type { SlotAppConfig, SlotAppInstance } from '../slot-app/slot-app.js';

/**
 * The quote, written out here rather than imported. This is the contract a
 * broadcaster configures their own station against.
 */
interface QuoteBody {
  prefix: string;
  label: string;
  hubAddress: string;
  slotPrice: number;
  slotPeriodSeconds: number;
  hasCapacity: boolean;
  slotCap: number;
  slotsHeld: number;
  slot: { lapsesAt: number } | null;
}

/** The refusal, likewise written out. */
interface RefusalBody {
  error: string;
  message: string;
}

/** The suite's hub. A real operator sets their own; that is the point of it. */
const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

const running: SlotAppInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A throwaway credential per boot, mounted at a real file the way a hub's
 * compose file mounts the real thing. No credential literal belongs in this
 * repository, not even a test's.
 */
function mountCredentials(): {
  dir: string;
  writeKeyFile: string;
  bearerTokenFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'slot-quote-'));
  tempDirs.push(dir);
  const mount = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `test-operator-${name}-${randomUUID()}\n`, {
      mode: 0o600,
    });
    return path;
  };
  return {
    dir,
    writeKeyFile: mount('operator-write.key'),
    bearerTokenFile: mount('operator-bearer.token'),
  };
}

/** Boot a real slot app on an ephemeral port under a stated admission policy. */
async function boot(
  config: Partial<SlotAppConfig> = {}
): Promise<SlotAppInstance> {
  const mounted = mountCredentials();
  const app = await startSlotApp({
    slotPort: 0,
    host: '127.0.0.1',
    dataDir: mounted.dir,
    hubAddress: HUB_ADDRESS,
    operatorWriteKeyFile: mounted.writeKeyFile,
    operatorBearerTokenFile: mounted.bearerTokenFile,
    ...config,
  });
  running.push(app);
  return app;
}

/** A payer key shaped exactly as a terminating connector states one. */
function evmPayer(): string {
  return `evm:0x${randomUUID().replaceAll('-', '').repeat(2)}`;
}

function solanaPayer(): string {
  return `solana:${randomUUID().replaceAll('-', '')}`;
}

function appUrl(app: SlotAppInstance, path: string): string {
  return `http://127.0.0.1:${String(app.config.slotPort)}${path}`;
}

/**
 * Ask for a quote the way the connector in front of the app would deliver one:
 * the three attribution headers it states, and nothing a caller chose.
 */
function askForQuote(
  app: SlotAppInstance,
  payer: string | undefined,
  path = '/quote'
): Promise<Response> {
  const headers: Record<string, string> =
    payer === undefined
      ? {}
      : {
          'x-toon-payer': payer,
          'x-toon-amount': '50',
          'x-toon-chain': payer.split(':')[0] ?? 'evm',
        };
  return fetch(appUrl(app, path), { headers });
}

/** The quote a payer reads, or a failure that says what came back instead. */
async function quote(app: SlotAppInstance, payer: string): Promise<QuoteBody> {
  const res = await askForQuote(app, payer);
  const body: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `expected a quote, got ${String(res.status)}: ${JSON.stringify(body)}`
    );
  }
  return body as QuoteBody;
}

// ---------- The prefix the hub would grant ----------

describe('the prefix a broadcaster is quoted', () => {
  it('is the hub own address plus a label, and is the point of the address', async () => {
    const app = await boot();
    const payer = evmPayer();

    const res = await askForQuote(app, payer);
    const body = (await res.json()) as QuoteBody;

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // A quote is per-caller and perishable: a cache handing one broadcaster's
    // prefix to the next hands out the wrong address.
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(body.hubAddress).toBe(HUB_ADDRESS);
    expect(body.prefix).toBe(`${HUB_ADDRESS}.${body.label}`);
    // The broadcaster writes this into their own connector.toml, so it has to
    // be something an ILP address can carry.
    expect(body.label).toMatch(/^[a-zA-Z0-9_~-]+$/);
    expect(body.prefix.startsWith(`${HUB_ADDRESS}.`)).toBe(true);
  });

  it('is identical on every call by the same payer', async () => {
    const app = await boot();
    const payer = evmPayer();

    const prefixes = new Set<string>();
    for (let call = 0; call < 5; call += 1) {
      prefixes.add((await quote(app, payer)).prefix);
    }

    // "The same handle every time I come back" — a broadcaster prints this on
    // their page, and it has to keep working.
    expect([...prefixes]).toHaveLength(1);
  });

  it('is identical across a restart of the hub, on the same payer', async () => {
    const payer = evmPayer();

    const first = await boot();
    const before = (await quote(first, payer)).prefix;
    await first.stop();

    const second = await boot();
    const after = (await quote(second, payer)).prefix;

    // Derived from the payer, so it survives a process that remembers nothing.
    expect(after).toBe(before);
  });

  it('differs between two payers, on either chain', async () => {
    const app = await boot();

    const prefixes = new Set<string>();
    for (let payer = 0; payer < 10; payer += 1) {
      prefixes.add((await quote(app, evmPayer())).prefix);
      prefixes.add((await quote(app, solanaPayer())).prefix);
    }

    // Nobody else can take my handle, because nobody else can pay with my key.
    expect(prefixes.size).toBe(20);
  });

  it('follows the hub address the operator configured', async () => {
    const payer = evmPayer();

    const mine = await boot({ hubAddress: 'g.toon.slopmachine.hub-one' });
    const theirs = await boot({ hubAddress: 'g.toon.example.hub-two' });

    const here = await quote(mine, payer);
    const there = await quote(theirs, payer);

    // The hub's address is configuration; the label beneath it is the payer's.
    expect(here.prefix).toBe(`g.toon.slopmachine.hub-one.${here.label}`);
    expect(there.prefix).toBe(`g.toon.example.hub-two.${there.label}`);
    expect(there.label).toBe(here.label);
  });
});

// ---------- What a slot costs, and for how long ----------

describe('what the quote says a slot costs', () => {
  it('reports the price and the period the operator configured', async () => {
    const app = await boot({ slotPrice: 4242, slotPeriodSeconds: 900 });

    const body = await quote(app, evmPayer());

    expect(body.slotPrice).toBe(4242);
    expect(body.slotPeriodSeconds).toBe(900);
  });

  it('reports the defaults when the operator configured nothing', async () => {
    const app = await boot();

    const body = await quote(app, evmPayer());

    // The placeholder slot price and a 30-day period, both from
    // docs/placeholder-numbers.md and both written out here as literals.
    expect(body.slotPrice).toBe(1_000_000);
    expect(body.slotPeriodSeconds).toBe(2_592_000);
  });

  it('refuses to boot on a price or a period nobody could have meant', async () => {
    for (const config of [
      { slotPrice: 0 },
      { slotPrice: -1 },
      { slotPrice: 'free' },
      { slotPeriodSeconds: 0 },
      { slotPeriodSeconds: 1.5 },
      { slotCap: -1 },
      { hubAddress: 'g.toon slopmachine' },
    ]) {
      // A hub quoting a number nobody set is worse than a hub that did not
      // come up: the same fail-closed posture the origin takes on its ladder.
      await expect(boot(config)).rejects.toMatchObject({
        name: 'SlotPolicyError',
      });
    }
  });
});

// ---------- Capacity, at the cheap address ----------

describe('whether the hub has capacity', () => {
  it('says yes while the roster is under the cap', async () => {
    const app = await boot({ slotCap: 3 });

    const body = await quote(app, evmPayer());

    expect(body.slotCap).toBe(3);
    expect(body.slotsHeld).toBe(0);
    expect(body.hasCapacity).toBe(true);
  });

  it('says no once the roster is at the cap, and still answers', async () => {
    // A cap of zero is a hub admitting nobody — full, closed, or not yet
    // funded — and it is a policy an operator states rather than a mistake.
    const app = await boot({ slotCap: 0 });

    const res = await askForQuote(app, evmPayer());
    const body = (await res.json()) as QuoteBody;

    // The refusal a broadcaster must never pay the slot price for arrives
    // HERE, at the cheap address, as an answer rather than as an error. ADR
    // 0003's amendment is what this test is the implementation of.
    expect(res.status).toBe(200);
    expect(body.hasCapacity).toBe(false);
    expect(body.slotCap).toBe(0);
    expect(body.slotsHeld).toBe(0);
    // And it still tells them what they would have been granted, so a
    // broadcaster can configure their station and come back.
    expect(body.prefix).toBe(`${HUB_ADDRESS}.${body.label}`);
  });
});

// ---------- The caller's own slot ----------

describe('the caller own slot', () => {
  it('is null for a broadcaster who holds none', async () => {
    const app = await boot();

    const body = await quote(app, evmPayer());

    // Nothing writes a slot yet — the buy is #35 — so every caller is a
    // broadcaster who holds none, and the quote says so rather than omitting
    // the field.
    expect(body.slot).toBeNull();
    expect(Object.keys(body).sort()).toEqual([
      'hasCapacity',
      'hubAddress',
      'label',
      'prefix',
      'slot',
      'slotCap',
      'slotPeriodSeconds',
      'slotPrice',
      'slotsHeld',
    ]);
  });
});

// ---------- The request that did not arrive through a paid termination ----------

describe('a request with no verified payer', () => {
  it('is refused, and the refusal names the missing paid termination', async () => {
    const app = await boot();

    const res = await askForQuote(app, undefined);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(403);
    expect(body.error).toBe('no_paid_termination');
    // The refusal is about how the hub is wired, not about what the caller
    // sent — a caller's own spelling of the header never survives the
    // connector's strip, so there is nothing in their request to fix.
    expect(body.message).toMatch(/paid termination/i);
    expect(body.message).toMatch(/X-TOON-Payer/);
    expect(body.message).toMatch(/Nothing here is about the request body/);
    expect(body.message).toMatch(/hub operator/i);
  });

  it('is refused on an empty or whitespace payer, the same way', async () => {
    const app = await boot();

    for (const stated of ['', '   ']) {
      const res = await fetch(appUrl(app, '/quote'), {
        headers: { 'x-toon-payer': stated },
      });
      const body = (await res.json()) as RefusalBody;

      expect(res.status).toBe(403);
      expect(body.error).toBe('no_paid_termination');
    }
  });

  it('grants nothing on the way out', async () => {
    const app = await boot();

    const body = await (await askForQuote(app, undefined)).text();

    // No prefix, no label, no price: a request that did not arrive paid learns
    // nothing about what it would have been granted.
    expect(body).not.toContain(HUB_ADDRESS);
    expect(body).not.toContain('prefix');
    expect(body).not.toContain('slotPrice');
  });
});

// ---------- The address is its own, and it is not the buy's ----------

describe('where the quote lives', () => {
  it('is reachable at its own prefix and nowhere else', async () => {
    const app = await boot();
    const payer = evmPayer();

    expect((await askForQuote(app, payer, '/quote')).status).toBe(200);

    // Nothing sits beneath /quote, and nothing else answers a quote. An
    // address reachable at another address's price is a slot sold for the
    // cost of a quote — or a quote sold for the cost of a slot.
    for (const path of ['/', '/quotes', '/quote/slot', '/buy', '/slots']) {
      const res = await askForQuote(app, payer, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('is a GET, and the buy does not exist here yet', async () => {
    const app = await boot();
    const payer = evmPayer();

    const posted = await fetch(appUrl(app, '/quote'), {
      method: 'POST',
      headers: { 'x-toon-payer': payer },
    });
    await posted.arrayBuffer();

    expect(posted.status).toBe(404);
  });

  it('leaves liveness unpriced and unquoted', async () => {
    const app = await boot();

    const health = await fetch(appUrl(app, '/health'));
    const body = await health.text();

    // /health has no route on the hub's connector and never may. It is not a
    // claim about the roster, the hub's capacity or anybody's slot, and it
    // still says nothing about money now that the quote does.
    expect(health.status).toBe(200);
    expect(body).not.toMatch(/price|prefix|capacity|slot(?!-app)/i);
  });
});

// ---------- Still no payment code ----------

describe('the quote holds no payment code', () => {
  it('reads the payer the connector stated and echoes no header back', async () => {
    const app = await boot();
    const payer = evmPayer();

    const res = await askForQuote(app, payer);
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const header of [
      'x-payment',
      'x-payment-response',
      'x-toon-payer',
      'x-toon-amount',
      'x-toon-chain',
      'www-authenticate',
    ]) {
      expect(res.headers.get(header)).toBeNull();
    }
    // The verified payer key is the hub's join key into its own records. It
    // is not the broadcaster's to see quoted back at them, and the handle is
    // derived from it rather than containing it.
    expect(body).not.toContain(payer);
  });

  it('validates no claim: the stated amount changes nothing it answers', async () => {
    const app = await boot({ slotPrice: 1000 });
    const payer = evmPayer();

    const answers = new Set<string>();
    for (const amount of ['1', '50', '999999999']) {
      const res = await fetch(appUrl(app, '/quote'), {
        headers: { 'x-toon-payer': payer, 'x-toon-amount': amount },
      });
      const body = (await res.json()) as QuoteBody;
      expect(res.status).toBe(200);
      answers.add(JSON.stringify(body));
    }

    // Charging is the connector's job. Nothing here checks what was paid, and
    // the quote a broadcaster reads is the same whatever the connector says
    // it charged for the packet that carried the question.
    expect(answers.size).toBe(1);
  });
});
