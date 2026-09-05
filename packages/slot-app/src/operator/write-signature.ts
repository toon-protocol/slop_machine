/**
 * Signing an operator write: RFC 9421 HTTP Message Signatures, held to the
 * verifier they target.
 *
 * **No TypeScript RFC 9421 implementation exists anywhere in the fleet.** The
 * connector ships one signer — `docs/operators/sign-write.sh`, bash and
 * openssl — and one verifier,
 * `crates/connector-operator/src/rfc9421.rs`. This module is the third
 * implementation of the same three steps, and every one of them is named
 * after the function in that verifier that checks it rather than restated
 * from memory:
 *
 *   1. **`Content-Digest`** (RFC 9530): `sha-256=:<base64 of SHA-256(body)>:`,
 *      which is what binds the signature to the body rather than only to the
 *      method and the path.
 *   2. **The signature base**, exactly `build_signature_base`'s four lines —
 *      `"@method"`, `"@path"`, `"content-digest"`, then `"@signature-params"`
 *      naming the covered set and carrying `created`, `expires`, `keyid` and
 *      `alg="ed25519"`. The covered set is fixed and is exactly those three:
 *      the verifier refuses anything more and anything fewer.
 *   3. **The signature**, over that base as **one string, with PureEdDSA**.
 *      Ed25519 hashes its own input, so unlike the digest above there is no
 *      separate hashing step before signing — which is why `crypto.sign` is
 *      called here with a `null` algorithm.
 *
 * **The key file is a bare 32-byte seed**, the shape every other key in the
 * fleet uses and the shape `openssl rand -hex 32` writes: sixty-four hex
 * characters. It is wrapped at use time in the fourteen fixed, publicly-known
 * DER bytes that make an Ed25519 PKCS8 private key — there is no per-key
 * content in that prefix, so no conversion tool and no second key file in a
 * second format have to be kept in step with the one a hub operator already
 * generates. `keyid` is the public half of that seed, hex, which is exactly
 * the value the operator puts on their connector's `write_keys` allowlist.
 *
 * **An accepted signature is not replayable.** The verifier remembers every
 * signature it has accepted until that signature's own `expires` has passed,
 * and refuses a second write presenting one it has already spent. Ed25519 is
 * deterministic, so signing an identical signature base twice produces
 * identical signature bytes — which means a retry of a write that failed
 * *after* being authenticated would be refused as a replay rather than
 * retried. The `created` second is what makes each attempt's base different,
 * so this signer **waits for the clock** rather than emitting a signature it
 * has already emitted: see {@link createWriteSigner}. A retry inside a paid
 * request is what keeps a slow chain from costing a broadcaster a purchase,
 * and it would be worth nothing if the retry could not be authenticated.
 *
 * **And the verifier's memory outlives this process, so a fresh signer treats
 * the second it was born in as already spent.** The replay cache lives in the
 * connector, not here: it forgets a signature when that signature's own
 * `expires` passes, and cares nothing for which of the app's processes made
 * it. A map of what *this* process has signed therefore cannot see what its
 * predecessor signed a few hundred milliseconds ago — and boot reconciliation
 * repeats exactly the writes the previous process may just have made, so a
 * crash and a restart inside one second would walk straight into a `401`
 * nobody could act on. Every base the predecessor signed was signed at a
 * second at or before this signer's own boot second, so refusing to sign at
 * that second or earlier is enough to be certain of a base nobody has spent.
 * The cost is bounded and paid once: the first write of a process waits, at
 * most, for the top of the next second.
 *
 * Nothing here logs, returns or embeds the seed. What leaves this module is
 * three header values and a public key.
 *
 * @module
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { OperatorCredentialError } from './credentials.js';

/**
 * The fixed, ordered covered-component set a write's signature must cover —
 * exactly this, no more and no fewer. The verifier's own
 * `COVERED_COMPONENTS`.
 */
const COVERED_COMPONENTS = ['@method', '@path', 'content-digest'] as const;

/** The only signature algorithm the operator surface accepts. */
const SIGNATURE_ALG = 'ed25519';

/** The label a single signature is presented under. */
const SIGNATURE_LABEL = 'sig1';

/**
 * The fourteen fixed DER bytes that turn a bare 32-byte seed into an Ed25519
 * PKCS8 private key: `SEQUENCE{version=0, AlgorithmIdentifier{1.3.101.112},
 * OCTET STRING{OCTET STRING{seed}}}`. Publicly known and identical for every
 * key — there is no per-key content in it, which is why a seed can be wrapped
 * here rather than converted by a tool.
 */
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

/** How many seconds a write's signature stays valid once it is made. */
export const SIGNATURE_TTL_SECONDS = 30;

/** The three headers a signed write carries. */
export interface WriteSignature {
  /** `sig1=("@method" "@path" "content-digest");created=…;…` */
  'signature-input': string;
  /** `sig1=:<base64>:` */
  signature: string;
  /** `sha-256=:<base64 of SHA-256(body)>:` (RFC 9530). */
  'content-digest': string;
}

/**
 * Signs operator writes with the hub's mounted write key.
 *
 * One signer is built at boot and reused: it holds the key as a
 * {@link KeyObject} rather than as bytes, and it is what remembers which
 * signature bases it has already spent.
 */
export interface WriteSigner {
  /**
   * The public half of the mounted write key, hex — the value a hub operator
   * puts on their connector's `write_keys` allowlist, and the `keyid` every
   * signature this signer makes names.
   *
   * A public key, so it is safe to log; the seed it came from never is.
   */
  keyid: string;
  /**
   * Sign one write, resolving with the three headers it must carry.
   *
   * **Never resolves with a signature it has already produced, and never with
   * one a previous process could have produced.** Where a retry would
   * otherwise sign an identical parameter set — same method, same path, same
   * body, same `created` second — this waits for the clock to advance rather
   * than emitting bytes the verifier has already spent; and a signer's very
   * first write waits past the second the signer was built in, because a
   * restarted app repeating a write its predecessor just made is the same
   * collision seen from outside the process. Either wait is bounded by one
   * second.
   *
   * @param method - the HTTP method, upper-cased into the base as the
   * verifier upper-cases it.
   * @param path - the request path. No query string: the covered component
   * is `@path`, not `@target-uri`.
   * @param body - the exact bytes that will be sent, which the digest binds
   * the signature to.
   */
  sign(method: string, path: string, body: string): Promise<WriteSignature>;
}

/**
 * Build the signer for a mounted operator write key.
 *
 * The seed is decoded **here**, not where the file was read: `credentials.ts`
 * deliberately reads a mounted credential as trimmed text and leaves what a
 * seed becomes to the code that signs. That code is this one, so this is
 * where a key that is not a key is refused — at boot, before anything binds,
 * because a hub holding a write key it cannot sign with can admit nobody and
 * must look broken rather than look fine.
 *
 * @param writeKey - the operator write key exactly as it was mounted:
 * sixty-four hex characters, which is what `openssl rand -hex 32` writes.
 * @throws OperatorCredentialError if that is not what the file held. The
 * message says what shape was expected and how many characters were found —
 * never the contents.
 */
export function createWriteSigner(writeKey: string): WriteSigner {
  const seed = decodeSeed(writeKey);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const keyid = publicKeyHex(privateKey);

  // The last `created` second each signature base was signed at. A base is
  // its method, path and body digest — everything in the signature that is
  // not the clock — so two different writes in the same second never wait on
  // each other, and only a byte-identical retry does.
  const spent = new Map<string, number>();

  // The second this signer was built in, which stands in for every base the
  // PREVIOUS process may have signed. Nothing it signed can have been signed
  // later than this, so a base with no entry of its own is treated as having
  // been spent here — see this module's header.
  const bornAt = nowSeconds();

  return {
    keyid,
    async sign(method, path, body) {
      const contentDigest = contentDigestOf(body);
      const upperMethod = method.toUpperCase();
      const base = `${upperMethod} ${path} ${contentDigest}`;

      const created = await freshCreated(spent, base, bornAt);
      const expires = created + SIGNATURE_TTL_SECONDS;

      const params = signatureParams({ created, expires, keyid });
      const signature = sign(
        // PureEdDSA: Ed25519 hashes its own input, so there is no digest
        // step here. A named hash would be Ed25519ph and would not verify.
        null,
        Buffer.from(
          signatureBase(upperMethod, path, contentDigest, params),
          'utf8'
        ),
        privateKey
      );

      return {
        'signature-input': `${SIGNATURE_LABEL}=${params}`,
        signature: `${SIGNATURE_LABEL}=:${signature.toString('base64')}:`,
        'content-digest': contentDigest,
      };
    },
  };
}

/**
 * The RFC 9530 `Content-Digest` field value for a body.
 *
 * SHA-256 here, unlike the signature below, because a digest is what binds
 * the body into a base that otherwise names only the method and the path.
 */
function contentDigestOf(body: string): string {
  const digest = createHash('sha256').update(body, 'utf8').digest('base64');
  return `sha-256=:${digest}:`;
}

/** The RFC 9421 §2.3 `@signature-params` inner-list value. */
function signatureParams(params: {
  created: number;
  expires: number;
  keyid: string;
}): string {
  const covered = COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ');
  return (
    `(${covered})` +
    `;created=${String(params.created)}` +
    // Required by this verifier, unlike the client-edge subset: a write's
    // validity window is what makes replay detection boundable.
    `;expires=${String(params.expires)}` +
    `;keyid="${params.keyid}"` +
    `;alg="${SIGNATURE_ALG}"`
  );
}

/** The canonical signature base: `build_signature_base`'s four lines. */
function signatureBase(
  method: string,
  path: string,
  contentDigest: string,
  params: string
): string {
  return [
    `"@method": ${method}`,
    `"@path": ${path}`,
    `"content-digest": ${contentDigest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
}

/**
 * A `created` second this signer has not already signed `base` at.
 *
 * This is the whole of the not-replayable guarantee. The verifier keys its
 * replay cache on the signature bytes, and Ed25519 is deterministic, so
 * "produce a fresh signature" means "sign a base nobody has signed before" —
 * and the only part of the base a retry of the same write can honestly change
 * is the second it was created in. So a retry inside the same second waits
 * for the next one rather than being refused, which is the difference between
 * a retry that rescues a purchase and a retry that cannot be authenticated.
 *
 * `created` is never pushed into the future to avoid the wait: a signature
 * that claims to have been made in a second that has not happened is a lie
 * about when a hub wrote to its own routing table, and the audit record the
 * connector retains is exactly that claim.
 *
 * **A base this signer has never signed counts as spent at `bornAt`.** The
 * cache that would refuse a repeat is the connector's and outlives this
 * process; a restarted app repeating a write its predecessor made moments
 * earlier is the same collision, seen from outside. Nothing the predecessor
 * signed can carry a `created` later than the second this signer was built
 * in, so starting every base there is exactly the guarantee, and no more of
 * one than that.
 */
async function freshCreated(
  spent: Map<string, number>,
  base: string,
  bornAt: number
): Promise<number> {
  for (;;) {
    const now = nowSeconds();
    forget(spent, now);

    const last = spent.get(base) ?? bornAt;
    if (last < now) {
      spent.set(base, now);
      return now;
    }

    // Sleep to the top of the second after the one already spent, plus a
    // millisecond so a coarse clock cannot land back on it.
    await sleep((last + 1) * 1000 - Date.now() + 1);
  }
}

/**
 * Drop what can no longer collide. A base last signed longer ago than a
 * signature stays valid can be signed again at the current second without
 * repeating any signature the verifier still remembers.
 */
function forget(spent: Map<string, number>, now: number): void {
  for (const [base, created] of spent) {
    if (created + SIGNATURE_TTL_SECONDS < now) spent.delete(base);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, Math.max(ms, 1)));
}

/**
 * The 32-byte seed a mounted write key holds.
 *
 * Sixty-four hex characters, which is what `openssl rand -hex 32` writes and
 * what every operator document in this fleet tells a hub operator to
 * generate. Not silently coerced from anything else: a key read wrong is a
 * key whose public half is not the one on the connector's allowlist, and the
 * symptom of that is a `401` on the first broadcaster's purchase rather than
 * anything a boot log would show.
 */
function decodeSeed(writeKey: string): Buffer {
  const seed = writeKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    throw new OperatorCredentialError(
      `the operator write key must be a 32-byte ed25519 seed written as 64 hex characters — what "openssl rand -hex 32" produces — but the mounted file holds ${String(seed.length)} character(s) that are not that. Its contents are not shown, and are not the thing to paste anywhere: the value that goes on the connector's write_keys allowlist is the PUBLIC half`
    );
  }
  return Buffer.from(seed, 'hex');
}

/**
 * The public half of a private key, hex — the last 32 bytes of its DER
 * `SubjectPublicKeyInfo`, which carries a fixed 12-byte wrapper in front of
 * the raw key. Exactly what `connector send --print-keyid` prints for the
 * same seed.
 */
function publicKeyHex(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}
