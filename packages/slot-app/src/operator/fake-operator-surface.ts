/**
 * A fake of the hub connector's operator surface — a **fake, not a mock**.
 *
 * The slot app reaches its hub's operator surface through configuration
 * (`--operator-url` / `TOON_OPERATOR_URL`) and through nothing else: there is
 * no injected port on the app's own API, because a seam the suite needs is
 * not a reason to put one in the thing a hub operator runs. So the suite
 * points that configuration at this, booted in-process on an ephemeral port.
 *
 * **What makes it a fake is that it actually checks.** Connector ADR 0007's
 * distinction: a mock records that a function was called, a fake behaves like
 * the real thing well enough that a request which satisfies it is a request
 * the real thing would accept. This one:
 *
 *   - **verifies the RFC 9421 signature for real**, rebuilding the signature
 *     base from the request it actually received and checking ed25519 against
 *     an allowlisted public key — so a signer that builds the base wrongly
 *     fails here rather than on a hub;
 *   - **verifies the `Content-Digest` for real** against the body it received,
 *     so a signature that is not bound to the body is not accepted;
 *   - **refuses an unsigned write**, and refuses one whose key is not on the
 *     allowlist;
 *   - **refuses a replayed signature**, remembering every signature it has
 *     accepted exactly as the connector's own write auth does — which is what
 *     makes "a retry produces a fresh signature" a thing a test can find out
 *     rather than assume;
 *   - **records what was written**, so assertions are about what the hub's
 *     routing table ends up holding rather than about which function was
 *     called.
 *
 * Everything it checks is named after the connector's own verifier,
 * `crates/connector-operator/src/rfc9421.rs`, and its answers are shaped like
 * that surface's: `POST /peers` answers the peering with
 * `channel: { id, status: "found" | "created", chain }`, and repeating a write
 * against an established peering finds the same channel rather than opening a
 * second one. `POST /routes/peers` is the other half of the same surface — it
 * takes `{ prefix, peer_id, price }`, keys the row on `prefix` so a repeat
 * updates rather than duplicates, refuses a route toward a peering it does not
 * hold, and refuses a prefix the **config file** owns with the `409` the real
 * table answers (`PeerRouteTableError::OwnedByConfig`, connector ADR 0034: a
 * runtime row never shadows a config one).
 *
 * The other two verbs on that same address are what a renewal needs, and this
 * fake splits their gates exactly as the connector does:
 *
 *   - **`GET /routes/peers`** answers every row it holds as
 *     `{ prefix, peer_id, price, source }` (`connector_runtime::PeerRouteView`,
 *     with `RouteSource` spelled lower-case), gated by the **bearer token and
 *     nothing else**. A read presenting the wrong token is a `401` however
 *     well it is signed, which is what makes "the app's bearer token is for
 *     reads only" something a suite can find out.
 *   - **`DELETE /routes/peers/:prefix`** removes one row, gated by the
 *     **signature and nothing else** — no body, and the digest of no body is
 *     still covered, exactly as `remove_peer_route` verifies it. It answers
 *     `204` on a row it held, `404` on one it never had, so a repeat is not a
 *     failure, and `409` on a prefix the config file owns.
 *
 * **This module is test scaffolding and ships in no bundle** — nothing the
 * app's entrypoints import reaches it. It is a `.ts` file beside the code it
 * fakes rather than inside a test file because more than one suite will want
 * it, and because a fake that is held to a real verifier is worth reading on
 * its own.
 *
 * @module
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  verify,
} from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

/** The covered-component set the connector's verifier accepts. Exactly this. */
const COVERED_COMPONENTS = ['@method', '@path', 'content-digest'];

/** The only signature algorithm it accepts. */
const SIGNATURE_ALG = 'ed25519';

/**
 * The fixed twelve DER bytes in front of a raw ed25519 public key in a
 * `SubjectPublicKeyInfo` — the inverse of the wrapper a signer puts around a
 * seed, and how an allowlisted hex key becomes something that can verify.
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** One write the surface accepted, exactly as it arrived. */
export interface RecordedWrite {
  method: string;
  path: string;
  /** The `keyid` whose signature authenticated it. */
  keyid: string;
  /** The body as it arrived, before anything parsed it. */
  body: string;
  /**
   * Every header the request carried, lower-cased.
   *
   * Kept so a caller can replay one byte-for-byte without signing anything
   * itself — which is how a suite finds out whether a replay is refused
   * without reimplementing the signer it is testing.
   */
  headers: Record<string, string>;
  /** The `created` second the accepted signature named. */
  created: number;
}

/** One write the surface refused, and why. */
export interface RefusedWrite {
  method: string;
  path: string;
  /** The verifier's own word for it: `unsigned`, `replayed`, and so on. */
  reason: string;
}

/** A peering this surface holds, as it would answer it. */
export interface FakePeering {
  id: string;
  url: string;
  fee: number;
  max_packet_amount: number;
  channel: { id: string; status: string; chain: string };
}

/** One forwarded route this surface holds, as it would answer it. */
export interface FakeForwardedRoute {
  prefix: string;
  peer_id: string;
  /**
   * Exactly as the write spelled it: a bare integer for a flat price, a
   * `{ base, per_kib }` object for one with a slope (connector ADR 0065).
   * Kept unparsed so a suite asserts what the hub actually asked for.
   */
  price: number | { base: number; per_kib: number };
}

/** How the fake behaves. */
export interface FakeOperatorSurfaceOptions {
  /**
   * The ed25519 public keys allowed to write, hex — a hub operator's
   * `[operator] write_keys`. Use {@link publicKeyOf} to derive one from a
   * seed, exactly as `connector send --print-keyid` does.
   */
  writeKeys: readonly string[];
  /**
   * The bearer token that gates every **read** — a hub operator's
   * `[operator] bearer_token`.
   *
   * Required rather than optional: a fake whose reads were open by default
   * would let an app that never sent the token pass, and the suite would
   * never find out that the app had not been given one.
   */
  bearerToken: string;
  /**
   * Whether the surface can read the self-description at a station URL.
   *
   * `false` is the connector's `502`: the counterparty's host was
   * unreachable, redirecting, or described a node it cannot peer with. It is
   * the one refusal that is about the caller's own node.
   */
  stationIsReadable?: (url: string) => boolean;
  /**
   * How long, in milliseconds, a peering write takes before it answers.
   *
   * A slow chain, made ordinary configuration. `POST /peers` can open a
   * channel and wait for a chain to confirm it.
   */
  writeDelayMs?: number;
  /**
   * Whether a prefix is one the hub operator's **own configuration file**
   * owns.
   *
   * A runtime route may never shadow a config one, so a write naming one is
   * refused `409` exactly as the real table refuses it — which is what makes
   * "the app can never take an address I reserved" something a suite finds
   * out rather than assumes. A predicate rather than a list because the
   * addresses a hub grants are derived from a payer, so a suite knows the
   * shape of the row it wants reserved before it knows its name.
   */
  configOwns?: (prefix: string) => boolean;
}

/** A running fake operator surface. */
export interface FakeOperatorSurface {
  /** Its base URL — what `TOON_OPERATOR_URL` is pointed at. */
  url: string;
  /** Every write it accepted, in the order it accepted them. */
  writes(): RecordedWrite[];
  /** Every write it refused, and why. */
  refusals(): RefusedWrite[];
  /** Every peering it holds — the hub's routing table, as far as it goes. */
  peerings(): FakePeering[];
  /**
   * Every forwarded route it holds, in the order it first learned each one —
   * the rows that decide what a hub actually carries. A row removed over
   * `DELETE /routes/peers/:prefix` is gone from here, which is how a suite
   * sees that a renewal took a dropped rung back out.
   */
  routes(): FakeForwardedRoute[];
  /**
   * Make the next `count` **authenticated** writes fail transiently, as a
   * chain that timed out would — every write, or only those on `path`.
   *
   * The failure lands after authentication on purpose: the signature is spent
   * before the failure, so a retry that replayed it would be refused. That is
   * the situation a retry has to survive, and making it survivable only by a
   * fresh signature is the point of the option.
   *
   * `path` narrows it to one endpoint, which is how a suite exercises a hub
   * whose peering landed and whose routing table then would not take a row.
   */
  failNextWrites(count: number, path?: string): void;
  /** Stop it. Idempotent. */
  stop(): Promise<void>;
}

/**
 * The public half of a 32-byte ed25519 seed, hex.
 *
 * The value a hub operator puts on their connector's `write_keys` allowlist,
 * derived here independently of the app's own signer — so a suite that
 * allowlists a key derived by this and accepts a signature made by that has
 * proven the two agree, rather than proven that one module agrees with
 * itself.
 */
export function publicKeyOf(seedHex: string): string {
  const seed = Buffer.from(seedHex.trim(), 'hex');
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const spki = createPublicKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  ).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}

/** Boot a fake operator surface on an ephemeral port. */
export async function startFakeOperatorSurface(
  options: FakeOperatorSurfaceOptions
): Promise<FakeOperatorSurface> {
  const allowlist = new Set(options.writeKeys.map((key) => key.toLowerCase()));
  const stationIsReadable = options.stationIsReadable ?? (() => true);

  const accepted: RecordedWrite[] = [];
  const refused: RefusedWrite[] = [];
  const peerings = new Map<string, FakePeering>();
  const forwarded = new Map<string, FakeForwardedRoute>();
  const configOwns = options.configOwns ?? (() => false);
  // Keyed on the signature itself, exactly as the connector's write auth is:
  // ed25519 is deterministic, so an identical parameter set is an identical
  // signature and is the same spent credential.
  const spent = new Set<string>();
  let failures = 0;
  let failuresOn: string | undefined;

  /**
   * Whether this write is one the suite asked to fail, spending it if so.
   * Counted only where the path matches, so narrowing the failures to one
   * endpoint does not burn one on another.
   */
  function failing(path: string): boolean {
    if (failures <= 0) return false;
    if (failuresOn !== undefined && failuresOn !== path) return false;
    failures -= 1;
    return true;
  }

  const surface = new Hono();

  surface.post('/peers', async (c) => {
    const body = await c.req.text();
    const headers = headersOf(c.req.raw);
    const path = new URL(c.req.url).pathname;

    const authenticated = authenticate({
      method: 'POST',
      path,
      headers,
      body,
      allowlist,
      spent,
    });
    if ('reason' in authenticated) {
      refused.push({ method: 'POST', path, reason: authenticated.reason });
      return c.json({ error: authenticated.reason }, 401);
    }

    accepted.push({
      method: 'POST',
      path,
      keyid: authenticated.keyid,
      body,
      headers,
      created: authenticated.created,
    });

    if (options.writeDelayMs !== undefined && options.writeDelayMs > 0) {
      await new Promise((wake) => setTimeout(wake, options.writeDelayMs));
    }

    if (failing(path)) {
      return c.text('the chain did not answer in time', 503);
    }

    let request: {
      id?: unknown;
      url?: unknown;
      fee?: unknown;
      max_packet_amount?: unknown;
      chain?: unknown;
    };
    try {
      request = JSON.parse(body) as typeof request;
    } catch {
      return c.text('not JSON', 400);
    }
    if (typeof request.id !== 'string' || request.id.trim() === '') {
      return c.text('a peering needs a local label', 400);
    }
    if (typeof request.url !== 'string') {
      return c.text('a peering needs a URL', 400);
    }
    if (!stationIsReadable(request.url)) {
      // The connector's own word for "about the counterparty's host".
      return c.text(
        `${request.url} could not be read: no self-description answered there`,
        502
      );
    }

    // Retry-safe: a repeat against an established peering finds the same
    // channel rather than opening a second one, and says which branch it
    // took. This is what makes the write safe to make inside a paid request.
    const held = peerings.get(request.id);
    const chain = typeof request.chain === 'string' ? request.chain : 'evm';
    const peering: FakePeering = {
      id: request.id,
      url: request.url,
      fee: typeof request.fee === 'number' ? request.fee : 0,
      max_packet_amount:
        typeof request.max_packet_amount === 'number'
          ? request.max_packet_amount
          : 0,
      channel: {
        id: held?.channel.id ?? `0x${randomUUID().replaceAll('-', '')}`,
        status: held === undefined ? 'created' : 'found',
        chain,
      },
    };
    peerings.set(peering.id, peering);

    return c.json({
      id: peering.id,
      fee: peering.fee,
      max_packet_amount: peering.max_packet_amount,
      source: 'runtime',
      channel: peering.channel,
    });
  });

  surface.post('/routes/peers', async (c) => {
    const body = await c.req.text();
    const headers = headersOf(c.req.raw);
    const path = new URL(c.req.url).pathname;

    const authenticated = authenticate({
      method: 'POST',
      path,
      headers,
      body,
      allowlist,
      spent,
    });
    if ('reason' in authenticated) {
      refused.push({ method: 'POST', path, reason: authenticated.reason });
      return c.json({ error: authenticated.reason }, 401);
    }

    accepted.push({
      method: 'POST',
      path,
      keyid: authenticated.keyid,
      body,
      headers,
      created: authenticated.created,
    });

    if (failing(path)) {
      return c.text('the route table did not answer in time', 503);
    }

    let request: { prefix?: unknown; peer_id?: unknown; price?: unknown };
    try {
      request = JSON.parse(body) as typeof request;
    } catch {
      return c.text('not JSON', 400);
    }
    if (typeof request.prefix !== 'string' || request.prefix.trim() === '') {
      return c.text('a route needs a prefix', 400);
    }
    if (typeof request.peer_id !== 'string') {
      return c.text('a route needs a peer_id', 400);
    }
    const price = readPrice(request.price);
    if (price === undefined) {
      return c.text('a price is an integer, or a { base, per_kib } table', 400);
    }

    // The config file's rows are the operator's own and a runtime write may
    // never shadow one: the real table's `OwnedByConfig`, and its `409`.
    if (configOwns(request.prefix)) {
      return c.text(
        `the route for ${request.prefix} is owned by the config file`,
        409
      );
    }
    // A route toward a peering this surface does not hold cannot resolve to a
    // valid row whatever the table's state, which is the real table's own
    // line between a `400` and a `409`.
    if (!peerings.has(request.peer_id)) {
      return c.text(`unknown peer id '${request.peer_id}'`, 400);
    }

    const route: FakeForwardedRoute = {
      prefix: request.prefix,
      peer_id: request.peer_id,
      price,
    };
    forwarded.set(route.prefix, route);

    return c.json({ ...route, source: 'runtime' });
  });

  // Reads: the bearer token and nothing else, which is the connector's own
  // split. A signature buys nothing here, and the token buys nothing on a
  // write.
  surface.get('/routes/peers', (c) => {
    const presented = c.req.header('authorization');
    if (presented !== `Bearer ${options.bearerToken}`) {
      return c.text('missing or wrong bearer token', 401);
    }
    return c.json(
      [...forwarded.values()].map((route) => ({
        ...route,
        // Every row this fake holds was written at runtime. A config row is
        // the operator's own and this surface never invents one: what it has
        // to say about them is the `409` below.
        source: 'runtime',
      }))
    );
  });

  surface.delete('/routes/peers/:prefix', async (c) => {
    // A DELETE carries no body, and the digest of no body is still covered —
    // `authenticate_write` binds the signature to the whole request rather
    // than to a body a DELETE need not have.
    const body = await c.req.text();
    const headers = headersOf(c.req.raw);
    const path = new URL(c.req.url).pathname;

    const authenticated = authenticate({
      method: 'DELETE',
      path,
      headers,
      body,
      allowlist,
      spent,
    });
    if ('reason' in authenticated) {
      refused.push({ method: 'DELETE', path, reason: authenticated.reason });
      return c.json({ error: authenticated.reason }, 401);
    }

    accepted.push({
      method: 'DELETE',
      path,
      keyid: authenticated.keyid,
      body,
      headers,
      created: authenticated.created,
    });

    if (failing(path)) {
      return c.text('the route table did not answer in time', 503);
    }

    const prefix = c.req.param('prefix');

    // Owned by the config file before found or not found, exactly as
    // `remove_runtime_peer_route` orders its own two checks.
    if (configOwns(prefix)) {
      return c.text(`the route for ${prefix} is owned by the config file`, 409);
    }
    if (!forwarded.delete(prefix)) {
      return c.text(`no runtime route for '${prefix}'`, 404);
    }

    return c.body(null, 204);
  });

  const { server, port } = await listen(surface.fetch);

  return {
    url: `http://127.0.0.1:${String(port)}`,
    writes: () => [...accepted],
    refusals: () => [...refused],
    peerings: () => [...peerings.values()],
    routes: () => [...forwarded.values()],
    failNextWrites(count, path) {
      failures = count;
      failuresOn = path;
    },
    stop() {
      return new Promise<void>((stopped, failed) => {
        server.close((err) => (err ? failed(err) : stopped()));
      });
    },
  };
}

/**
 * A price as the real surface reads one: a bare integer, or a
 * `{ base, per_kib }` table (connector ADR 0065's two spellings, and no
 * others — a string is refused here exactly as it would be there).
 */
function readPrice(
  stated: unknown
): number | { base: number; per_kib: number } | undefined {
  if (typeof stated === 'number' && Number.isInteger(stated) && stated >= 0) {
    return stated;
  }
  if (typeof stated !== 'object' || stated === null) return undefined;
  const { base, per_kib: perKib } = stated as Record<string, unknown>;
  if (
    typeof base !== 'number' ||
    !Number.isInteger(base) ||
    base < 0 ||
    typeof perKib !== 'number' ||
    !Number.isInteger(perKib) ||
    perKib < 0
  ) {
    return undefined;
  }
  return { base, per_kib: perKib };
}

/** What authentication produced: a verified write, or the reason it was not. */
type Authentication = { keyid: string; created: number } | { reason: string };

/**
 * Verify one write the way the connector's own verifier does.
 *
 * Every step here is the verifier's, in the verifier's order: the covered set
 * is exactly three components, `expires` is required, the digest is checked
 * against the body before the signature is checked against the base, and the
 * base is rebuilt from **this** request rather than taken from anything the
 * caller sent.
 */
function authenticate(request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  allowlist: Set<string>;
  spent: Set<string>;
}): Authentication {
  const signatureInput = request.headers['signature-input'];
  const signatureHeader = request.headers['signature'];
  if (signatureInput === undefined || signatureHeader === undefined) {
    return { reason: 'unsigned' };
  }

  const parsed = parseSignatureInput(signatureInput);
  if (parsed === undefined) return { reason: 'malformed_signature_input' };

  const signature = parseSignature(signatureHeader, parsed.label);
  if (signature === undefined) return { reason: 'malformed_signature' };

  if (parsed.alg !== SIGNATURE_ALG) return { reason: 'unsupported_alg' };
  if (
    parsed.components.length !== COVERED_COMPONENTS.length ||
    !parsed.components.every((c, i) => c === COVERED_COMPONENTS[i])
  ) {
    return { reason: 'covered_components_mismatch' };
  }

  const contentDigest = request.headers['content-digest'];
  if (contentDigest === undefined) return { reason: 'digest_missing' };
  const expected = `sha-256=:${createHash('sha256')
    .update(request.body, 'utf8')
    .digest('base64')}:`;
  if (contentDigest.trim() !== expected) return { reason: 'digest_mismatch' };

  if (parsed.expires === undefined) return { reason: 'missing_expiry' };
  if (Math.floor(Date.now() / 1000) > parsed.expires) {
    return { reason: 'expired' };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(parsed.keyid))
    return { reason: 'invalid_keyid' };
  if (!request.allowlist.has(parsed.keyid.toLowerCase())) {
    return { reason: 'key_not_allowlisted' };
  }

  const base = [
    `"@method": ${request.method.toUpperCase()}`,
    `"@path": ${request.path}`,
    `"content-digest": ${contentDigest.trim()}`,
    `"@signature-params": ${parsed.params}`,
  ].join('\n');

  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(parsed.keyid, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, Buffer.from(base, 'utf8'), publicKey, signature)) {
    return { reason: 'signature_invalid' };
  }

  // Spent only once it has verified, so a rejected signature is not burned.
  const spentKey = signature.toString('base64');
  if (request.spent.has(spentKey)) return { reason: 'replayed' };
  request.spent.add(spentKey);

  return { keyid: parsed.keyid.toLowerCase(), created: parsed.created };
}

interface ParsedSignatureInput {
  label: string;
  components: string[];
  /** The `@signature-params` value, verbatim — what the base names. */
  params: string;
  created: number;
  expires: number | undefined;
  keyid: string;
  alg: string;
}

function parseSignatureInput(header: string): ParsedSignatureInput | undefined {
  const match = /^([A-Za-z0-9_-]+)=(\(([^)]*)\)(.*))$/.exec(header.trim());
  if (match === null) return undefined;
  const [, label, params, inner, rest] = match;
  if (
    label === undefined ||
    params === undefined ||
    inner === undefined ||
    rest === undefined
  ) {
    return undefined;
  }

  const components = inner
    .split(' ')
    .filter((component) => component !== '')
    .map((component) => component.replace(/^"|"$/g, ''));

  const fields = new Map<string, string>();
  for (const pair of rest.split(';')) {
    if (pair === '') continue;
    const cut = pair.indexOf('=');
    if (cut < 0) return undefined;
    fields.set(pair.slice(0, cut), pair.slice(cut + 1).replace(/^"|"$/g, ''));
  }

  const created = Number(fields.get('created'));
  const expires = fields.has('expires')
    ? Number(fields.get('expires'))
    : undefined;
  const keyid = fields.get('keyid');
  if (!Number.isFinite(created) || keyid === undefined) return undefined;

  return {
    label,
    components,
    params,
    created,
    expires,
    keyid,
    alg: fields.get('alg') ?? SIGNATURE_ALG,
  };
}

function parseSignature(header: string, label: string): Buffer | undefined {
  const match = new RegExp(`^${label}=:([A-Za-z0-9+/=]+):$`).exec(
    header.trim()
  );
  const encoded = match?.[1];
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64');
}

function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

function listen(
  fetch: Hono['fetch']
): Promise<{ server: ServerType; port: number }> {
  return new Promise((bound, failed) => {
    const server = serve({ fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      bound({ server, port: info.port });
    });
    server.once('error', failed);
  });
}
