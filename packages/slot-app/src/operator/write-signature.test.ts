/**
 * A signature this hub has already spent is never emitted twice — not by one
 * process, and not by the process that replaces it.
 *
 * The verifier keys its replay cache on the signature bytes and ed25519 is
 * deterministic, so "produce a fresh signature" means "sign a base nobody has
 * signed before", and the only honest part of the base a repeat of the same
 * write can change is the `created` second. Two things follow, and this file
 * is both of them:
 *
 *   - a **retry** inside one process waits for the clock rather than
 *     re-emitting what it already emitted;
 *   - a **restarted** process does the same across the restart, because the
 *     cache that would refuse it lives in the connector and outlives the app.
 *     Boot reconciliation repeats exactly the writes the previous process may
 *     just have made, so this is the ordinary case rather than a corner of it.
 *
 * The assertions are over the three header values a signer hands out and
 * nothing else: the `created` a signature claims, and the bytes it carries.
 * How the signer remembers what it has spent is its own business.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createWriteSigner } from './write-signature.js';

/** One write, repeated verbatim — the shape boot reconciliation makes. */
const WRITE = {
  method: 'POST',
  path: '/routes/peers',
  body: '{"prefix":"g.toon.slopmachine.abcdef012345.now","peer_id":"abcdef012345","price":60}',
} as const;

/** How many times a restart is repeated, so a second boundary cannot flatter it. */
const RESTARTS = 3;

/** The `created` second a `signature-input` claims. */
function createdOf(signatureInput: string): number {
  const match = /;created=(\d+)/.exec(signatureInput);
  if (match?.[1] === undefined) {
    throw new Error(`no created in ${signatureInput}`);
  }
  return Number(match[1]);
}

describe('an accepted signature is never re-emitted', () => {
  it('gives a repeat of the same write inside one process a later created second', async () => {
    const signer = createWriteSigner(randomBytes(32).toString('hex'));

    const first = await signer.sign(WRITE.method, WRITE.path, WRITE.body);
    const second = await signer.sign(WRITE.method, WRITE.path, WRITE.body);

    expect(createdOf(second['signature-input'])).toBeGreaterThan(
      createdOf(first['signature-input'])
    );
    expect(second.signature).not.toBe(first.signature);
  });

  it('signs two different writes in the same second without either waiting on the other', async () => {
    const signer = createWriteSigner(randomBytes(32).toString('hex'));

    // Two bases, so nothing collides and nothing has to wait. Asserted
    // because the wait above must be the narrow one it claims to be: a signer
    // that serialised every write onto its own second would make a purchase
    // with a ladder of rungs take a second per rung.
    const peering = await signer.sign(
      'POST',
      '/peers',
      '{"id":"abcdef012345"}'
    );
    const route = await signer.sign(WRITE.method, WRITE.path, WRITE.body);

    expect(route.signature).not.toBe(peering.signature);
    expect(createdOf(route['signature-input'])).toBe(
      createdOf(peering['signature-input'])
    );
  });

  it('never lets a restarted process repeat a signature its predecessor made', async () => {
    // The same mounted key across every restart, because that is the case: a
    // hub's write key is a file on the box and the process that comes back
    // reads the same one.
    const seed = randomBytes(32).toString('hex');

    const emitted: { created: number; signature: string }[] = [];
    for (let restart = 0; restart <= RESTARTS; restart += 1) {
      // A brand new signer, exactly as a restarted app builds one. It has no
      // memory of what came before — and must still not repeat it.
      const signed = await createWriteSigner(seed).sign(
        WRITE.method,
        WRITE.path,
        WRITE.body
      );
      emitted.push({
        created: createdOf(signed['signature-input']),
        signature: signed.signature,
      });
    }

    // Strictly increasing, which is the whole guarantee: a signature made in a
    // second later than every second its predecessors could have signed in is
    // a signature nothing has spent.
    for (let index = 1; index < emitted.length; index += 1) {
      const previous = emitted[index - 1];
      const current = emitted[index];
      expect({
        index,
        later: (current?.created ?? 0) > (previous?.created ?? 0),
      }).toEqual({ index, later: true });
    }

    // And the bytes themselves are all different, which is what the connector
    // actually compares.
    expect(new Set(emitted.map((one) => one.signature)).size).toBe(
      emitted.length
    );
  });
});
