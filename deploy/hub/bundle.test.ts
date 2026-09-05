/**
 * Guards the hub bundle — the files this repo hands a hub operator to run a
 * hub node.
 *
 * The sibling of `deploy/bundle.test.ts` and held to the same two rules. It
 * reads the REAL committed files, not fixtures, because a fixture keeps
 * passing while the shipped artifact regresses; and every expected value is a
 * literal declared here and never read back out of the file under test, so a
 * reverted fix fails this suite instead of quietly agreeing with itself.
 *
 * Three hazards earn most of this file, and all three fail SILENTLY on a live
 * box — which is the whole reason a guard exists rather than a review note.
 *
 * - A FREE DOOR. The slot app's port is the payment-oblivious surface:
 *   `/quote`, `/buy`, `/health` and `/roster` all answer on it with no notion
 *   of a payment at all. The only thing that makes a slot a paid slot is that
 *   this port is published on NO interface — not even on loopback — so the one
 *   route to it is a paid packet through the hub's connector. Turning its
 *   `expose:` into a `ports:` for a quick curl, in any compose file, in any
 *   file set, opens a door onto free slots AND onto `/roster`'s list of every
 *   broadcaster this hub admitted. A docker publish with no host-IP prefix
 *   beats ufw, because Docker's iptables chain runs ahead of it. A Caddy route
 *   does the same thing through the front. The relay's write port is the same
 *   shape for the same reason: the relay skips signature verification on paid
 *   ephemeral kinds precisely because that port is reachable only through the
 *   payment-gating connector.
 *
 * - A ROUTE TO NOWHERE. A connector route naming an address the app does not
 *   serve is a paid 404: a broadcaster's purchase failing in production rather
 *   than a build failing here. The routes and the app's own surface are two
 *   halves of one fact, so this file asserts them against each other — and
 *   connector ADR 0067 assigns exactly that check ("a declared `request` shape
 *   matches what the app actually serves") to the APP'S OWN repository, which
 *   is this one. So the last section boots the REAL slot app and speaks HTTP
 *   at it rather than trusting a literal on both sides of the comparison.
 *
 * - A HUB THAT THINKS IT IS A STATION. A station publishes a third port, its
 *   RTMPS ingest, because stock Caddy does not speak RTMP and an origin must
 *   front its own uplink. A hub has no uplink and carries no vibes of its own,
 *   so RTMP anywhere in this bundle is a copy-paste from the sibling bundle
 *   that opens a port nothing is listening on and nothing is gating.
 *
 * The rest holds still the facts that make the paid path a paid path: the four
 * routes at their four prices, each terminating strictly beneath the service
 * root it claims to price; `/health`, `/roster` and `/metrics` reachable at no
 * price because they have no route at all; `TOON_*` in the compose file and
 * the routes in `connector.toml` asserted as ONE PAIR; both operator
 * credentials named by path and never by value; and healthchecks dialling
 * 127.0.0.1, because "localhost" in a container can resolve to ::1 where an
 * IPv4-bound listener never answers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { startSlotApp } from '../../packages/slot-app/src/slot-app/slot-app.js';
import type { SlotAppInstance } from '../../packages/slot-app/src/slot-app/slot-app.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The bundle, as a path a failure message can be pasted from. */
const HUB_DIR = 'deploy/hub';

const BASE_COMPOSE_PATH = `${HUB_DIR}/docker-compose.yml`;
const LOCAL_COMPOSE_PATH = `${HUB_DIR}/docker-compose.local.yml`;
const WATCHTOWER_COMPOSE_PATH = `${HUB_DIR}/docker-compose.watchtower.yml`;
const CONNECTOR_TOML_PATH = `${HUB_DIR}/connector.toml`;
const CADDYFILE_PATH = `${HUB_DIR}/Caddyfile`;
const ENV_EXAMPLE_PATH = `${HUB_DIR}/.env.example`;
const GITIGNORE_PATH = `${HUB_DIR}/.gitignore`;
const DOCKERIGNORE_PATH = '.dockerignore';

/** Every compose file this bundle ships. Each is checked on its own. */
const EVERY_COMPOSE_FILE = [
  BASE_COMPOSE_PATH,
  LOCAL_COMPOSE_PATH,
  WATCHTOWER_COMPOSE_PATH,
];

/**
 * Every file set a hub operator is told to run — `deploy/hub/README.md` and
 * the header of `docker-compose.yml` name exactly these three. A publish added
 * to an overlay is as much a free door as one added to the base file, so the
 * ports invariant is checked against each set, not only against the base.
 */
const COMPOSE_FILE_SETS: { name: string; files: string[] }[] = [
  { name: 'production', files: [BASE_COMPOSE_PATH] },
  { name: 'local', files: [BASE_COMPOSE_PATH, LOCAL_COMPOSE_PATH] },
  { name: 'watchtower', files: [BASE_COMPOSE_PATH, WATCHTOWER_COMPOSE_PATH] },
];

// ── The ports ────────────────────────────────────────────────────────────────

/**
 * The slot app's port. THE ONE PORT THAT IS NEVER HOST-PUBLISHED, IN ANY FORM,
 * NOT EVEN ON LOOPBACK — it has no authentication and no notion of a payment,
 * so a loopback publish is not a mitigation, it is a free slot and a free
 * roster for anything that can reach the box.
 */
const SLOT_APP_PORT = '3200';
/** The relay's paid write port. Same shape, same reason: only the connector may dial it. */
const RELAY_WRITE_PORT = '3100';
/** The relay's free NIP-01 reads. Fronted by Caddy in production. */
const RELAY_READ_PORT = '7100';
/** The connector's client edge. Loopback only — broadcaster traffic arrives via Caddy. */
const CONNECTOR_EDGE_PORT = '3000';
/** RTMPS ingest. A STATION's third published port, and it belongs to no hub. */
const RTMP_PORT = '1935';

/**
 * The prefix that makes a publish local-only. A `ports:` entry with no host IP
 * — or with 0.0.0.0 — binds every interface, and Docker's iptables chain runs
 * ahead of ufw, so such a publish is internet-reachable even with ufw locked
 * to 22/80/443.
 */
const LOOPBACK_PUBLISH_PREFIX = '127.0.0.1:';

/**
 * The whole published set, per file set. EXACTLY TWO DOORS ARE REACHABLE
 * OFF-BOX and they are both Caddy's; everything else is either `expose:`d on
 * the compose network or published to loopback.
 *
 * Caddy's two appear in the `local` set as well, even though that overlay
 * parks the service on a profile that is never activated: compose still merges
 * the declaration, and this guard deliberately over-approximates towards
 * flagging a publish rather than missing one.
 */
const EXPECTED_PUBLISHED_PORTS: Record<string, string[]> = {
  production: ['80:80', '443:443', `${LOOPBACK_PUBLISH_PREFIX}3000:3000`],
  local: [
    '80:80',
    '443:443',
    `${LOOPBACK_PUBLISH_PREFIX}3000:3000`,
    `${LOOPBACK_PUBLISH_PREFIX}7100:7100`,
  ],
  watchtower: ['80:80', '443:443', `${LOOPBACK_PUBLISH_PREFIX}3000:3000`],
};

/** The only unqualified — internet-reachable — publishes in any file set. */
const EXPECTED_UNQUALIFIED_PUBLISHES = ['443:443', '80:80'];
/** And the only service permitted one. A hub has no uplink, so Caddy is alone here. */
const SERVICE_ALLOWED_AN_UNQUALIFIED_PUBLISH = 'caddy';

/** The one publish the local overlay adds, and the only one it may add. */
const LOCAL_OVERLAY_ADDED_PUBLISH = `${LOOPBACK_PUBLISH_PREFIX}7100:7100`;

/**
 * Every service in each compose file, by name. Written out so that a service
 * ADDED to this bundle — an origin, an ingest sidecar, an admin console — is a
 * failure here rather than a surprise on a box.
 */
const EXPECTED_SERVICES: Record<string, string[]> = {
  [BASE_COMPOSE_PATH]: ['caddy', 'connector', 'relay', 'slot-app'],
  // The overlay declares no new service: it parks Caddy on a dead profile,
  // builds the slot app from this checkout, and publishes the relay's reads.
  [LOCAL_COMPOSE_PATH]: ['caddy', 'relay', 'slot-app'],
  [WATCHTOWER_COMPOSE_PATH]: ['watchtower'],
};

/** What each service must keep on `expose:` — private, but still dialable. */
const EXPECTED_EXPOSE: Record<string, string[]> = {
  'slot-app': [SLOT_APP_PORT],
  relay: [RELAY_WRITE_PORT, RELAY_READ_PORT],
};

/** A service name that would mean this hub had grown an uplink. */
const A_STATION_SERVICE = /(^|[-_])(origin|ingest|rtmp)([-_]|$)/i;

// ── The routes, and the surface they must agree with ─────────────────────────

/** The hub's ILP apex. Every prefix it terminates and every prefix it grants sits beneath it. */
const HUB_ADDRESS = 'g.toon.slopmachine';

/** The slot app, as the compose network addresses it. Nothing may terminate here. */
const SLOT_APP_BASE_URL = `http://slot-app:${SLOT_APP_PORT}`;
/** The relay's write surface, likewise. */
const RELAY_BASE_URL = `http://relay:${RELAY_WRITE_PORT}`;

interface ExpectedRoute {
  prefix: string;
  price: number;
  handlerUrl: string;
  method: string;
  contentType?: string;
  /** `body` verbatim where it is a string; its keys where it is a table. */
  bodyKeys?: string[];
  body?: string;
}

/**
 * Every route this hub terminates: four, at four prices, each on its own
 * prefix and each declaring its own `request` shape (connector ADR 0067).
 *
 * The numbers are the placeholders from `docs/placeholder-numbers.md`, not
 * decisions — but a price that CHANGES is a change to what a broadcaster pays,
 * so it changes here too or it does not ship. The `request` shapes are what a
 * client is told to send, and the last section of this file proves the app
 * actually serves them.
 */
const EXPECTED_ROUTES: ExpectedRoute[] = [
  {
    prefix: `${HUB_ADDRESS}.slot.quote`,
    price: 50,
    handlerUrl: `${SLOT_APP_BASE_URL}/quote`,
    method: 'GET',
    body: 'none',
  },
  {
    prefix: `${HUB_ADDRESS}.slot.buy`,
    price: 1_000_000,
    handlerUrl: `${SLOT_APP_BASE_URL}/buy`,
    method: 'POST',
    contentType: 'application/json',
    bodyKeys: ['stationUrl'],
  },
  {
    prefix: `${HUB_ADDRESS}.announce`,
    price: 1,
    handlerUrl: `${RELAY_BASE_URL}/write`,
    method: 'POST',
    contentType: 'application/json',
    bodyKeys: ['event'],
  },
  {
    prefix: `${HUB_ADDRESS}.announce.ephemeral`,
    price: 0,
    handlerUrl: `${RELAY_BASE_URL}/write-ephemeral`,
    method: 'POST',
    contentType: 'application/json',
    bodyKeys: ['event'],
  },
];

/** The two prefixes that must stay siblings: one is the cheap question, one is the price. */
const QUOTE_PREFIX = `${HUB_ADDRESS}.slot.quote`;
const BUY_PREFIX = `${HUB_ADDRESS}.slot.buy`;

/**
 * The only handler paths this bundle may name. A route path outside this set
 * either reaches something the app does not serve — a paid 404 — or reaches
 * something it serves for nothing.
 */
const ROUTABLE_HANDLER_PATHS = ['/quote', '/buy', '/write', '/write-ephemeral'];

/**
 * The paths served on the app ports that are deliberately NOT priced: the slot
 * app's in-node diagnostics and the hub operator's roster, and the relay's
 * own. The only reason "unpriced" does not mean "free to the internet" is that
 * neither app port is published anywhere — so a route acquiring one of these
 * puts a hub's roster of every admitted broadcaster on sale AND on the
 * internet.
 */
const UNROUTED_PATHS = ['/health', '/roster', '/metrics'];

/** The two service roots. A route at either is every address beneath it at one price. */
const SERVICE_ROOTS = [SLOT_APP_BASE_URL, RELAY_BASE_URL];

// ── The pairs ────────────────────────────────────────────────────────────────

/**
 * `TOON_*` on a service and the routes in `connector.toml` are ONE PAIR, the
 * same way the station's ladder and its routes are. Each of these is a value
 * that exists in two files, and the failure of changing one without the other
 * is silent: a hub that under-charges, a hub that grants prefixes nothing
 * terminates, or a route pointed at a port nothing is listening on.
 */
const EXPECTED_SLOT_APP_ENVIRONMENT: Record<string, string> = {
  TOON_SLOT_PORT: SLOT_APP_PORT,
  TOON_HUB_ADDRESS: HUB_ADDRESS,
  TOON_SLOT_PRICE: '1000000',
  // The connector on the compose network, never the base file's loopback
  // publish: a container reaching its own host's 127.0.0.1 reaches itself.
  TOON_OPERATOR_URL: `http://connector:${CONNECTOR_EDGE_PORT}`,
  TOON_ALLOW_PLAINTEXT_STATION_URLS: 'false',
};

const EXPECTED_RELAY_ENVIRONMENT: Record<string, string> = {
  TOON_BLS_PORT: RELAY_WRITE_PORT,
  TOON_RELAY_PORT: RELAY_READ_PORT,
};

/** The only file that may relax the plaintext rule, and the value it may relax it to. */
const PLAINTEXT_VAR = 'TOON_ALLOW_PLAINTEXT_STATION_URLS';

// ── The connector image ──────────────────────────────────────────────────────

/**
 * The pin of record for a hub. Immutable by construction: the connector's
 * config parser is `deny_unknown_fields` and its startup is fail-closed, so a
 * schema drift under a moving tag is an outage rather than a degraded run —
 * and this file's `request` tables are a key the connector only learned in
 * this build.
 */
const EXPECTED_CONNECTOR_IMAGE =
  'ghcr.io/toon-protocol/connector:rust-2026.08.28.1';
const IMMUTABLE_CONNECTOR_TAG =
  /:(rust-sha-[0-9a-f]{7,40}|rust-\d{4}\.\d{2}\.\d{2}\.\d+)$/;
const MOUNTED_CONNECTOR_CONFIG =
  './connector.toml:/app/config/connector.toml:ro';

/**
 * The one image in this bundle that may be built from this checkout, and the
 * only file that may build it. The connector and the relay are stock published
 * images in every file set; a local build of either is a second, unreviewable
 * source for what a hub runs.
 */
const LOCALLY_BUILDABLE_SERVICE = 'slot-app';
const LOCAL_BUILD_DOCKERFILE = 'packages/slot-app/Dockerfile';

// ── The credentials ──────────────────────────────────────────────────────────

/** Both operator credentials, named by PATH. Neither value is ever an environment value. */
const EXPECTED_CREDENTIAL_FILE_VARS: Record<string, string> = {
  TOON_OPERATOR_WRITE_KEY_FILE: '/run/secrets/operator-signing.key',
  TOON_OPERATOR_BEARER_TOKEN_FILE: '/run/secrets/operator-bearer.token',
};

/**
 * The literal-valued forms, which must exist nowhere. An environment value is
 * readable from an image's metadata without ever running it, and a flag is
 * world-readable on the box.
 */
const FORBIDDEN_LITERAL_CREDENTIAL_VARS = [
  'TOON_OPERATOR_WRITE_KEY',
  'TOON_OPERATOR_BEARER_TOKEN',
];

const EXPECTED_SLOT_APP_CREDENTIAL_MOUNTS = [
  './operator-signing.key:/run/secrets/operator-signing.key:ro',
  './operator-bearer.token:/run/secrets/operator-bearer.token:ro',
];

/**
 * The connector holds the ALLOWLIST of public halves and the bearer token, and
 * never the private seed. `operator-write.keyS`, plural, is a file a hub
 * operator hand-edits to REVOKE authority; `operator-signing.key`, singular,
 * is the secret that holds it.
 */
const EXPECTED_CONNECTOR_OPERATOR_MOUNTS = [
  './operator-bearer.token:/app/data/operator-bearer.token:ro',
  './operator-write.keys:/app/data/operator-write.keys:ro',
];
const NEVER_MOUNTED_INTO_THE_CONNECTOR = 'operator-signing.key';

/**
 * What `deploy/hub/.gitignore` must name. The wildcards are the rule that
 * survives a re-derived or additional key; the three names are the rule a
 * reader can see without knowing the wildcards.
 */
const EXPECTED_GITIGNORED = [
  '.env',
  '*.key',
  '*.pem',
  '*.secret',
  'operator-bearer.token',
  'operator-write.keys',
  'operator-signing.key',
];

/**
 * What the repository's `.dockerignore` must carry for this bundle. Each has a
 * leading globstar because a `.dockerignore` pattern with no slash matches the
 * context ROOT only — and `docker-compose.local.yml` builds with
 * `context: ../..`, so a hub operator's keys are two directories down.
 */
const EXPECTED_DOCKERIGNORED = [
  '**/*.key',
  '**/*.pem',
  '**/*.secret',
  '**/operator-signing.key',
  '**/operator-bearer.token',
  '**/operator-write.keys',
];

/**
 * A run of 64 hex characters: what `openssl rand -hex 32` writes, and
 * therefore the shape of every credential this bundle's README tells an
 * operator to generate — the relay's Nostr identity, the connector's signer
 * and settlement keys, the bearer token and the slot app's signing seed. None
 * of them may ever be committed. The EVM addresses in `connector.toml` are 40
 * hex characters and are public by definition, so they do not match.
 */
const KEY_MATERIAL = /[0-9a-fA-F]{64}/;

/** The one secret a hub operator puts in `.env`, and it ships empty. */
const ENV_EXAMPLE_SECRET = 'RELAY_NOSTR_SECRET_KEY';

// ── Healthchecks ─────────────────────────────────────────────────────────────

/**
 * Every healthcheck this bundle ships, and the target each must dial. All
 * three must be PRESENT: a healthcheck that has been deleted is not a
 * healthcheck that passes, and `caddy` and the connector both gate their
 * startup on these.
 */
const EXPECTED_HEALTHCHECKS: Record<string, string> = {
  connector: `wget -q --spider http://127.0.0.1:${CONNECTOR_EDGE_PORT}/ilp/identity || exit 1`,
  'slot-app': `wget -q --spider http://127.0.0.1:${SLOT_APP_PORT}/health || exit 1`,
  relay: `wget -q --spider http://127.0.0.1:${RELAY_WRITE_PORT}/health || exit 1`,
};

// ── Caddy ────────────────────────────────────────────────────────────────────

/** The only two upstreams Caddy may name, and the hostname variable each sits under. */
const EXPECTED_CADDY_UPSTREAMS: { host: string; upstream: string }[] = [
  { host: '{$EDGE_HOST}', upstream: `connector:${CONNECTOR_EDGE_PORT}` },
  { host: '{$READ_HOST}', upstream: `relay:${RELAY_READ_PORT}` },
];

/**
 * What no Caddy directive may name. A public path to either payment-oblivious
 * surface is the same free door as a `ports:` entry, reached through the front
 * instead of around it.
 */
const FORBIDDEN_CADDY_UPSTREAMS = [
  'slot-app',
  SLOT_APP_PORT,
  `relay:${RELAY_WRITE_PORT}`,
];

// ── Reading the files under test ─────────────────────────────────────────────

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  ports?: string[];
  expose?: (string | number)[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  volumes?: string[];
}

interface DockerCompose {
  services?: Record<string, ComposeService>;
}

/**
 * `!override` is a COMPOSE tag, not a YAML one. No file in this bundle uses it
 * today; it is taught to the parser here so that one which starts to is parsed
 * rather than silently degraded into an unchecked node.
 */
const COMPOSE_OVERRIDE_TAG = {
  tag: '!override',
  collection: 'seq' as const,
  resolve: (seq: unknown) => seq,
};

function readFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function readCompose(relativePath: string): DockerCompose {
  return parseYaml(readFile(relativePath), {
    customTags: [COMPOSE_OVERRIDE_TAG],
  }) as DockerCompose;
}

/**
 * A file with its comments removed.
 *
 * Every file in this bundle explains at length what it must never contain —
 * "NO RTMP PORT, SERVICE OR PATH APPEARS ANYWHERE IN THIS BUNDLE", and so on —
 * so a check for a forbidden string has to read what the file DOES, not what
 * it says about itself. `#` opens a comment in YAML, TOML and a Caddyfile
 * alike, which is why one helper serves all three.
 */
function directivesOf(relativePath: string): string {
  return readFile(relativePath)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Compose substitutes `${VAR:-default}` from the operator's .env; with no .env
 * — the shape this repo ships — every substitution becomes its default. A
 * publish hidden behind a variable is still a publish.
 */
function resolveComposeDefaults(entry: string): string {
  return entry.replace(
    /\$\{([^}]+)\}/g,
    (_match, reference: string) => reference.split(':-')[1] ?? ''
  );
}

/**
 * Every `ports:` entry in one file set, with the service that declares it.
 *
 * Compose concatenates `ports:` lists across a file set, so the union is what
 * an operator gets. The over-approximation errs towards flagging a publish
 * rather than missing one, which is the direction this invariant wants to be
 * wrong in.
 */
function publishedPorts(
  files: string[]
): { file: string; service: string; entry: string }[] {
  return files.flatMap((file) =>
    Object.entries(readCompose(file).services ?? {}).flatMap(
      ([service, definition]) =>
        (definition.ports ?? []).map((entry) => ({
          file,
          service,
          entry: resolveComposeDefaults(entry),
        }))
    )
  );
}

/** The port half of a `[host-ip:][host:]container` publish, on either side. */
function portsNamedBy(entry: string): string[] {
  return entry.split(':').filter((field) => /^\d+$/.test(field));
}

/** One service's environment across a file, with every `${VAR:-default}` resolved. */
function environmentOf(
  file: string,
  service: string
): Record<string, string> | undefined {
  const declared = readCompose(file).services?.[service]?.environment;
  if (declared === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(declared).map(([key, value]) => [
      key,
      resolveComposeDefaults(String(value)),
    ])
  );
}

interface ConnectorRouteRequest {
  method?: string;
  contentType?: string;
  body?: string | Record<string, string>;
}

interface ConnectorRoute {
  prefix: string;
  price: number;
  handler_url: string;
  per_kib?: number;
  request?: ConnectorRouteRequest;
}

interface ConnectorToml {
  node: { addresses: string[] };
  routes: ConnectorRoute[];
}

function readConnectorToml(): ConnectorToml {
  return parse(readFile(CONNECTOR_TOML_PATH)) as unknown as ConnectorToml;
}

/**
 * Every `reverse_proxy` in the Caddyfile, with the site block that holds it.
 *
 * Parsed structurally rather than grepped: a substring search would pass on a
 * file that had grown a THIRD site block, and the whole invariant is that
 * there are exactly two public paths onto a hub. A site block opens with a
 * line ending in `{`; the global options block at the top opens the same way
 * and holds no `reverse_proxy`, so it contributes nothing.
 */
function caddyReverseProxies(): { host: string; upstream: string }[] {
  const found: { host: string; upstream: string }[] = [];
  let host = '';

  for (const line of directivesOf(CADDYFILE_PATH).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.endsWith('{')) {
      host = trimmed.slice(0, -1).trim();
      continue;
    }
    const [directive, upstream] = trimmed.split(/\s+/);
    if (directive === 'reverse_proxy' && upstream !== undefined) {
      found.push({ host, upstream });
    }
  }

  return found;
}

/** The path half of a handler URL — everything after the `host:port`. */
function pathOf(handlerUrl: string): string {
  return new URL(handlerUrl).pathname;
}

/** A path as its segments, so `/write` is not a prefix of `/write-ephemeral`. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isProperSegmentPrefix(shorter: string[], longer: string[]): boolean {
  return (
    shorter.length < longer.length &&
    shorter.every((segment, index) => longer[index] === segment)
  );
}

/**
 * Every file this bundle COMMITS. `git ls-files` rather than a directory walk,
 * because the question is what a public repository carries: the credentials a
 * hub operator generates sit in this very directory on a live box, and they
 * are gitignored, so a walk would read a real key and fail on a clean tree.
 */
function committedHubFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', HUB_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('hub bundle', () => {
  // ── A free door ────────────────────────────────────────────────────────────

  it('never host-publishes the slot app port, in any file, in any form', () => {
    for (const file of EVERY_COMPOSE_FILE) {
      for (const { service, entry } of publishedPorts([file])) {
        expect(
          portsNamedBy(entry).includes(SLOT_APP_PORT),
          `${file} service "${service}": publishes "${entry}", which names the slot app's port :${SLOT_APP_PORT}. That port is the payment-oblivious surface — /quote, /buy, /health and /roster all answer on it with no notion of a payment — so publishing it, even on ${LOOPBACK_PUBLISH_PREFIX}, gives away a free slot and /roster's list of every broadcaster this hub admitted. It stays \`expose:\` and nothing else.`
        ).toBe(false);
      }
    }
  });

  it("never host-publishes the relay's write port, in any file, in any form", () => {
    // The relay skips schnorr verification for PAID EPHEMERAL kinds on the
    // assumption that this port is reachable exclusively through the
    // payment-gating connector. Publishing it does not merely open a door, it
    // opens a door onto a surface that stopped checking signatures because
    // this invariant held.
    for (const file of EVERY_COMPOSE_FILE) {
      for (const { service, entry } of publishedPorts([file])) {
        expect(
          portsNamedBy(entry).includes(RELAY_WRITE_PORT),
          `${file} service "${service}": publishes "${entry}", which names the relay's write port :${RELAY_WRITE_PORT}. Only the connector may dial it — the relay skips signature verification on paid ephemeral kinds precisely because that is true.`
        ).toBe(false);
      }
    }
  });

  it('keeps both private surfaces on `expose:`, so the connector can still dial them', () => {
    // The other half of the invariant: a port published nowhere AND exposed
    // nowhere is not private, it is unreachable — the connector cannot dial it
    // and every paid purchase 502s.
    for (const [service, ports] of Object.entries(EXPECTED_EXPOSE)) {
      const exposed = (
        readCompose(BASE_COMPOSE_PATH).services?.[service]?.expose ?? []
      ).map(String);

      expect(
        exposed,
        `${BASE_COMPOSE_PATH} ${service}: expected ${JSON.stringify(ports)} under \`expose:\`, found ${JSON.stringify(exposed)}`
      ).toEqual(ports);
    }
  });

  it("publishes exactly two off-box doors — Caddy's — in every file set an operator runs", () => {
    for (const { name, files } of COMPOSE_FILE_SETS) {
      const entries = publishedPorts(files).map(({ entry }) => entry);
      const expected = EXPECTED_PUBLISHED_PORTS[name] ?? [];

      expect(
        [...new Set(entries)].sort(),
        `the ${name} file set (${files.join(' + ')}) publishes ${JSON.stringify(entries)} — a hub publishes Caddy's 80 and 443 and nothing else off-box, with the connector edge on loopback${name === 'local' ? " and the relay's free reads on loopback, because that overlay drops Caddy" : ''}`
      ).toEqual([...expected].sort());
    }
  });

  it('lets only the TLS front bind every interface', () => {
    // The substance is "a publish with no host IP is internet-reachable even
    // with ufw locked down". Caddy earns one because being reachable is its
    // whole job. Unlike a station, a hub has no second service that earns one:
    // there is no uplink to front.
    const unqualified = publishedPorts(EVERY_COMPOSE_FILE).filter(
      ({ entry }) => !entry.startsWith(LOOPBACK_PUBLISH_PREFIX)
    );

    for (const { file, service, entry } of unqualified) {
      expect(
        service,
        `${file} service "${service}": publishes "${entry}" with no host IP — only ${SERVICE_ALLOWED_AN_UNQUALIFIED_PUBLISH} may be reachable off-box, and a bare docker publish beats ufw. Prefix it "${LOOPBACK_PUBLISH_PREFIX}" or use \`expose:\`.`
      ).toBe(SERVICE_ALLOWED_AN_UNQUALIFIED_PUBLISH);
    }

    expect(
      [...new Set(unqualified.map(({ entry }) => entry))].sort(),
      `the bundle's unqualified publishes are ${JSON.stringify(unqualified)} — exactly two doors are reachable off-box and they are the TLS front's`
    ).toEqual([...EXPECTED_UNQUALIFIED_PUBLISHES].sort());
  });

  it('binds the connector edge to loopback, exactly once', () => {
    const edgePublishes = publishedPorts(EVERY_COMPOSE_FILE)
      .map(({ entry }) => entry)
      .filter((entry) => portsNamedBy(entry).includes(CONNECTOR_EDGE_PORT));

    expect(
      edgePublishes,
      `the bundle publishes ${JSON.stringify(edgePublishes)} for the connector edge — it belongs on loopback exactly once, for on-box operator calls and nothing else. Dropping the "${LOOPBACK_PUBLISH_PREFIX}" would put the operator surface on the internet.`
    ).toEqual([
      `${LOOPBACK_PUBLISH_PREFIX}${CONNECTOR_EDGE_PORT}:${CONNECTOR_EDGE_PORT}`,
    ]);
  });

  it('adds one loopback publish in the local overlay and no other', () => {
    // With Caddy dropped nothing would reach the relay's free reads, and
    // reading announcements is how an operator checks a local hub carries
    // anything. It is loopback-qualified, so it adds no third off-box door.
    const added = publishedPorts([LOCAL_COMPOSE_PATH]);

    expect(
      added.map(({ service, entry }) => `${service} ${entry}`),
      `${LOCAL_COMPOSE_PATH}: the overlay's only publish is the relay's free reads on loopback, found ${JSON.stringify(added)}`
    ).toEqual([`relay ${LOCAL_OVERLAY_ADDED_PUBLISH}`]);
  });

  it('adds no published port in the watchtower overlay', () => {
    // Watchtower recreates containers. There is nothing here for Caddy to
    // front and nothing that should ever be reachable off-box.
    expect(
      publishedPorts([WATCHTOWER_COMPOSE_PATH]),
      `${WATCHTOWER_COMPOSE_PATH}: an auto-redeploy sidecar publishes nothing`
    ).toEqual([]);
  });

  it('runs exactly the four services a hub is, and no station service', () => {
    for (const [file, services] of Object.entries(EXPECTED_SERVICES)) {
      const declared = Object.keys(readCompose(file).services ?? {}).sort();

      expect(
        declared,
        `${file}: expected the services ${JSON.stringify(services)}, found ${JSON.stringify(declared)}`
      ).toEqual([...services].sort());

      for (const service of declared) {
        expect(
          A_STATION_SERVICE.test(service),
          `${file}: declares a service named "${service}". A hub carries no vibes of its own — it ingests nothing and serves no segments — so an origin or an ingest sidecar here is a copy-paste from the station bundle.`
        ).toBe(false);
      }
    }
  });

  // ── A hub that thinks it is a station ──────────────────────────────────────

  it('carries no RTMP port, service or path anywhere', () => {
    // A station publishes RTMPS ingest because stock Caddy does not speak RTMP
    // and an origin fronts its own uplink. A hub has no uplink, so an RTMP
    // port here is a door onto nothing, gated by nothing.
    for (const file of [
      ...EVERY_COMPOSE_FILE,
      CADDYFILE_PATH,
      CONNECTOR_TOML_PATH,
      ENV_EXAMPLE_PATH,
    ]) {
      // The whole file for the port number: no prose in this bundle names it,
      // and none should start to.
      expect(
        readFile(file),
        `${file}: names :${RTMP_PORT}. No RTMP port, service or path appears anywhere in this bundle and none may — a hub is never a station.`
      ).not.toContain(RTMP_PORT);

      // The DIRECTIVES only for the protocol name, because several of these
      // files explain at length that RTMP is exactly what they must not have.
      expect(
        directivesOf(file),
        `${file}: a directive names RTMP. A hub ingests nothing, so it fronts no uplink — that is the station bundle's job, and this is not it.`
      ).not.toMatch(/rtmps?/i);
    }

    for (const file of EVERY_COMPOSE_FILE) {
      for (const [service, definition] of Object.entries(
        readCompose(file).services ?? {}
      )) {
        for (const entry of [
          ...(definition.ports ?? []),
          ...(definition.expose ?? []).map(String),
        ]) {
          expect(
            portsNamedBy(resolveComposeDefaults(entry)).includes(RTMP_PORT),
            `${file} ${service}: names :${RTMP_PORT} in "${entry}"`
          ).toBe(false);
        }
      }
    }
  });

  // ── A route to nowhere ─────────────────────────────────────────────────────

  it('terminates exactly four routes, at four prices, on four handlers', () => {
    const { routes } = readConnectorToml();

    expect(
      routes.map((route) => ({
        prefix: route.prefix,
        price: route.price,
        handler_url: route.handler_url,
      })),
      `${CONNECTOR_TOML_PATH}: expected the hub's four routes — the quote, the buy, the paid announcement and the free ephemeral one — in that order`
    ).toEqual(
      EXPECTED_ROUTES.map((route) => ({
        prefix: route.prefix,
        price: route.price,
        handler_url: route.handlerUrl,
      }))
    );
  });

  it('advertises exactly the prefixes it terminates', () => {
    // A prefix terminated but never advertised is an address no broadcaster
    // can discover — `GET /ilp` is how a stranger who has only heard of this
    // hub finds where to buy. One advertised but not terminated is a paid 404.
    const { node } = readConnectorToml();

    expect(
      node.addresses,
      `${CONNECTOR_TOML_PATH}: [node].addresses must list every terminated prefix and nothing else, found ${JSON.stringify(node.addresses)}`
    ).toEqual(EXPECTED_ROUTES.map((route) => route.prefix));

    for (const address of node.addresses) {
      expect(
        address.startsWith(`${HUB_ADDRESS}.`),
        `${CONNECTOR_TOML_PATH}: [node].addresses advertises "${address}", which is not beneath this hub's own apex ${HUB_ADDRESS}`
      ).toBe(true);
    }
  });

  it('keeps the quote and the buy siblings, never one beneath the other', () => {
    // The quote is cheap and separate because a connector fulfils on ANY
    // complete answer whatever its status, so every foreseeable refusal is
    // moved to the cheap address. If either prefix sat beneath the other, one
    // would be reachable at the other's price and that whole design is gone.
    expect(
      QUOTE_PREFIX.startsWith(`${BUY_PREFIX}.`),
      `${CONNECTOR_TOML_PATH}: ${QUOTE_PREFIX} sits beneath ${BUY_PREFIX}`
    ).toBe(false);
    expect(
      BUY_PREFIX.startsWith(`${QUOTE_PREFIX}.`),
      `${CONNECTOR_TOML_PATH}: ${BUY_PREFIX} sits beneath ${QUOTE_PREFIX} — a slot would be sellable for the price of a quote`
    ).toBe(false);

    const { routes } = readConnectorToml();
    const quote = routes.find((route) => route.prefix === QUOTE_PREFIX);
    const buy = routes.find((route) => route.prefix === BUY_PREFIX);

    expect(quote?.price).toBeLessThan(buy?.price ?? 0);
  });

  it('terminates every route strictly beneath a service root', () => {
    const { routes } = readConnectorToml();

    for (const route of routes) {
      // Pointing a route at the bare app makes every address beneath it
      // reachable at this route's price — and on the slot app that means
      // /health and /roster on sale besides.
      for (const root of [
        ...SERVICE_ROOTS,
        ...SERVICE_ROOTS.map((r) => `${r}/`),
      ]) {
        expect(
          route.handler_url,
          `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates at "${root}" — every address beneath it would then be reachable at this route's price`
        ).not.toBe(root);
      }

      expect(
        ROUTABLE_HANDLER_PATHS,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates at path "${pathOf(route.handler_url)}", which is outside the set this bundle serves for money`
      ).toContain(pathOf(route.handler_url));
    }

    // Two routes on one handler is one handler reachable at two prices: the
    // cheaper door takes every packet.
    const handlerUrls = routes.map((route) => route.handler_url);
    expect(
      new Set(handlerUrls).size,
      `${CONNECTOR_TOML_PATH}: two routes terminate at the same handler_url — the cheaper one would take every packet`
    ).toBe(handlerUrls.length);

    // And no handler path may sit beneath another's, which would make the
    // deeper one reachable through the shallower route's price: an envelope's
    // target resolves strictly beneath the handler path (connector ADR 0025).
    for (const outer of routes) {
      for (const inner of routes) {
        if (outer === inner) continue;
        if (new URL(outer.handler_url).host !== new URL(inner.handler_url).host)
          continue;
        expect(
          isProperSegmentPrefix(
            segmentsOf(pathOf(outer.handler_url)),
            segmentsOf(pathOf(inner.handler_url))
          ),
          `${CONNECTOR_TOML_PATH}: route ${inner.prefix} terminates beneath route ${outer.prefix}'s handler path, so it is reachable at ${outer.prefix}'s price`
        ).toBe(false);
      }
    }
  });

  it('gives the unpriced addresses no route at any price', () => {
    const { routes, node } = readConnectorToml();

    // /health and /roster are unpriced because they are in-node, outside every
    // routed prefix; the only reason unpriced does not mean free to the
    // internet is that the app port is published nowhere. A route to either
    // sells the diagnostics AND makes them publicly reachable — and /roster
    // names every broadcaster this hub admitted.
    for (const path of UNROUTED_PATHS) {
      for (const route of routes) {
        expect(
          route.handler_url.includes(path),
          `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates at "${route.handler_url}", which reaches ${path} — the unpriced addresses have no route here and never may`
        ).toBe(false);
      }
      for (const address of node.addresses) {
        expect(
          address.endsWith(`.${path.slice(1)}`),
          `${CONNECTOR_TOML_PATH}: [node].addresses advertises "${address}" — ${path} is not for sale`
        ).toBe(false);
      }
    }
  });

  it('declares a request shape on every route, and only the shapes this hub serves', () => {
    // Connector ADR 0067: the shape is published verbatim on the route's
    // self-description entry and on its x402 greeting, and the connector never
    // reads a key out of it. It is for the client — so a shape that does not
    // match the app is a client told to send the wrong thing, which is a paid
    // 400 rather than a build failure.
    const { routes } = readConnectorToml();

    for (const expected of EXPECTED_ROUTES) {
      const route = routes.find((r) => r.prefix === expected.prefix);
      const request = route?.request;

      expect(
        request,
        `${CONNECTOR_TOML_PATH} route ${expected.prefix}: declares no [routes.request]. Every route this hub terminates publishes what to send it.`
      ).toBeDefined();
      expect(
        request?.method,
        `${CONNECTOR_TOML_PATH} route ${expected.prefix}: declares method ${String(request?.method)}, expected ${expected.method}`
      ).toBe(expected.method);
      expect(
        request?.contentType,
        `${CONNECTOR_TOML_PATH} route ${expected.prefix}: declares contentType ${String(request?.contentType)}, expected ${String(expected.contentType)}`
      ).toBe(expected.contentType);

      if (expected.body !== undefined) {
        expect(
          request?.body,
          `${CONNECTOR_TOML_PATH} route ${expected.prefix}: a GET carries nothing, so its body is "${expected.body}"`
        ).toBe(expected.body);
      } else {
        expect(
          Object.keys(request?.body ?? {}),
          `${CONNECTOR_TOML_PATH} route ${expected.prefix}: declares the body keys ${JSON.stringify(Object.keys(request?.body ?? {}))}, expected ${JSON.stringify(expected.bodyKeys)}. A purchase carries ONE thing and everything else is derived — the handle from the payer the connector verified, the prices from the station's own self-description, the carriage terms from this hub's configuration.`
        ).toEqual(expected.bodyKeys);
      }
    }
  });

  it('never sets per_kib on a hub route', () => {
    // A price is a schedule over the INBOUND payload, and everything this hub
    // terminates is a small request: a quote with no body at all, a purchase
    // carrying one URL, an announcement carrying one event. A slope on the buy
    // would mean a longer station URL cost more.
    for (const route of readConnectorToml().routes) {
      expect(
        route.per_kib,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: sets per_kib = ${String(route.per_kib)}. There is no slope worth having here.`
      ).toBeUndefined();
    }

    expect(
      readFile(CONNECTOR_TOML_PATH),
      `${CONNECTOR_TOML_PATH}: assigns per_kib somewhere — no hub route may set it`
    ).not.toMatch(/^\s*per_kib\s*=/m);
  });

  it('prices everything a broadcaster buys above zero, and only presence for free', () => {
    // A zero price is also what disarms the x402 greeting on a route, so the
    // one free lane is deliberate and stated rather than implicit — and it is
    // the ephemeral one, whose rate limit and body cap ARE its admission
    // control because it has no payment gate to lean on.
    const free = readConnectorToml()
      .routes.filter((route) => route.price === 0)
      .map((route) => route.prefix);

    expect(
      free,
      `${CONNECTOR_TOML_PATH}: the free routes are ${JSON.stringify(free)} — presence is the only thing this hub gives away`
    ).toEqual(
      EXPECTED_ROUTES.filter((route) => route.price === 0).map(
        (route) => route.prefix
      )
    );
  });

  // ── The pairs ──────────────────────────────────────────────────────────────

  it('keeps the slot app environment and the routes as one pair', () => {
    // TOON_SLOT_PRICE is what the quote reports and the floor the buy checks
    // the connector's own stated X-TOON-Amount against; the buy ROUTE is what
    // charges. TOON_HUB_ADDRESS is the apex the app derives every granted
    // prefix from; the four routes are written beneath it. A hub whose app and
    // connector disagree about either sells slots below policy or writes
    // routes nobody addresses.
    const environment = environmentOf(BASE_COMPOSE_PATH, 'slot-app') ?? {};

    for (const [key, value] of Object.entries(EXPECTED_SLOT_APP_ENVIRONMENT)) {
      expect(
        environment[key],
        `${BASE_COMPOSE_PATH} slot-app: ${key} resolves to ${String(environment[key])}, expected ${value}`
      ).toBe(value);
    }

    const { routes, node } = readConnectorToml();
    const buy = routes.find((route) => route.prefix === BUY_PREFIX);

    expect(
      String(buy?.price),
      `${CONNECTOR_TOML_PATH}: the buy route charges ${String(buy?.price)} while ${BASE_COMPOSE_PATH} sets TOON_SLOT_PRICE to ${String(environment['TOON_SLOT_PRICE'])} — they are one pair, and the app refuses \`403 route_under_charges\` when they disagree in that direction`
    ).toBe(environment['TOON_SLOT_PRICE']);

    for (const prefix of [
      ...routes.map((route) => route.prefix),
      ...node.addresses,
    ]) {
      expect(
        prefix.startsWith(`${String(environment['TOON_HUB_ADDRESS'])}.`),
        `${CONNECTOR_TOML_PATH}: "${prefix}" is not beneath TOON_HUB_ADDRESS (${String(environment['TOON_HUB_ADDRESS'])}) — the app grants every prefix under that address`
      ).toBe(true);
    }

    // And the app port is one value in four places: the environment, both slot
    // handler URLs, the `expose:` and the healthcheck.
    for (const route of routes.filter((r) =>
      r.handler_url.startsWith(SLOT_APP_BASE_URL)
    )) {
      expect(
        new URL(route.handler_url).port,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates on a port that is not TOON_SLOT_PORT`
      ).toBe(environment['TOON_SLOT_PORT']);
    }
  });

  it('keeps the relay environment, the routes and the Caddy upstream as one pair', () => {
    // The write port is what the announcement routes terminate on; the read
    // port is what Caddy fronts. Moving either without moving the other is a
    // paid 502 or a viber who cannot read announcements at all.
    const environment = environmentOf(BASE_COMPOSE_PATH, 'relay') ?? {};

    for (const [key, value] of Object.entries(EXPECTED_RELAY_ENVIRONMENT)) {
      expect(
        environment[key],
        `${BASE_COMPOSE_PATH} relay: ${key} resolves to ${String(environment[key])}, expected ${value}`
      ).toBe(value);
    }

    for (const route of readConnectorToml().routes.filter((r) =>
      r.handler_url.startsWith(RELAY_BASE_URL)
    )) {
      expect(
        new URL(route.handler_url).port,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates on a port that is not TOON_BLS_PORT`
      ).toBe(environment['TOON_BLS_PORT']);
    }

    expect(
      directivesOf(CADDYFILE_PATH),
      `${CADDYFILE_PATH}: must front the relay's free reads on TOON_RELAY_PORT`
    ).toContain(`relay:${String(environment['TOON_RELAY_PORT'])}`);
  });

  it('refuses a plaintext station URL everywhere but the local overlay', () => {
    // The purchase body carries a URL of the buyer's choosing and the app then
    // GETs it from inside the hub's own network, so plaintext is both a
    // credential-free hop a network path can rewrite and the widest part of
    // that surface. The local overlay turns it on because a local topology has
    // no certificate anywhere; nothing on a box with a public name should.
    expect(
      environmentOf(BASE_COMPOSE_PATH, 'slot-app')?.[PLAINTEXT_VAR],
      `${BASE_COMPOSE_PATH} slot-app: ${PLAINTEXT_VAR} must be 'false' — a public hub reads a station connector over TLS only`
    ).toBe('false');

    expect(
      environmentOf(LOCAL_COMPOSE_PATH, 'slot-app')?.[PLAINTEXT_VAR],
      `${LOCAL_COMPOSE_PATH} slot-app: the local overlay is the one file that may relax the plaintext rule`
    ).toBe('true');

    expect(
      environmentOf(WATCHTOWER_COMPOSE_PATH, 'slot-app')?.[PLAINTEXT_VAR],
      `${WATCHTOWER_COMPOSE_PATH}: an auto-redeploy overlay must not relax the plaintext rule`
    ).toBeUndefined();
  });

  // ── The connector image ────────────────────────────────────────────────────

  it('runs the stock connector image on an immutable pin', () => {
    const pinned =
      readCompose(BASE_COMPOSE_PATH).services?.['connector']?.image;

    expect(
      pinned,
      `${BASE_COMPOSE_PATH}: the connector service has no \`image:\` — it is this bundle's pin of record`
    ).toBe(EXPECTED_CONNECTOR_IMAGE);

    // A moving tag would make the pin a pointer somebody else controls, and
    // the connector's config parser is deny_unknown_fields with a fail-closed
    // startup — so a drift under it is an outage, not a degraded run. It cuts
    // the other way too: `request` is a key the connector only learned in this
    // build, so rolling the pin BACKWARDS is a refuse-to-start.
    expect(
      pinned,
      `${BASE_COMPOSE_PATH}: pin an immutable build — a rust-sha- build or a rust-<release handle> — never a moving tag`
    ).toMatch(IMMUTABLE_CONNECTOR_TAG);

    // Exactly once across the bundle: a second copy in an overlay is a copy
    // that drifts. (`deploy/bundle.test.ts` holds the whole-repository half of
    // this rule — two pins, one per bundle, naming the same build.)
    const named = EVERY_COMPOSE_FILE.filter((file) =>
      readFile(file).includes(EXPECTED_CONNECTOR_IMAGE)
    );
    expect(
      named,
      `the connector pin appears in ${JSON.stringify(named)} — it belongs in ${BASE_COMPOSE_PATH} and nowhere else in this bundle`
    ).toEqual([BASE_COMPOSE_PATH]);
  });

  it("builds only this repository's own app, and never from an overlay it did not mean to", () => {
    // This repository publishes no connector image and no relay image; it only
    // pins them. A local build of either is a second, unreviewable source for
    // what a hub runs.
    for (const file of EVERY_COMPOSE_FILE) {
      for (const [service, definition] of Object.entries(
        readCompose(file).services ?? {}
      )) {
        if (definition.build === undefined) continue;
        expect(
          service,
          `${file} ${service}: has a \`build:\`. The connector and the relay are stock published images in every file set — this repo publishes neither.`
        ).toBe(LOCALLY_BUILDABLE_SERVICE);
        expect(
          definition.build.dockerfile,
          `${file} ${service}: builds from ${String(definition.build.dockerfile)}`
        ).toBe(LOCAL_BUILD_DOCKERFILE);
      }
    }

    expect(
      readCompose(BASE_COMPOSE_PATH).services?.[LOCALLY_BUILDABLE_SERVICE]
        ?.build,
      `${BASE_COMPOSE_PATH}: the production file pulls a published image and builds nothing`
    ).toBeUndefined();
  });

  it('mounts connector.toml rather than baking it into a derived image', () => {
    // Every price this hub charges lives in that file, so it must be the
    // reviewed one on the box — not a copy sealed into an image nobody here
    // can read back.
    expect(
      readCompose(BASE_COMPOSE_PATH).services?.['connector']?.volumes ?? [],
      `${BASE_COMPOSE_PATH} connector: connector.toml must be mounted read-only`
    ).toContain(MOUNTED_CONNECTOR_CONFIG);
  });

  // ── The credentials ────────────────────────────────────────────────────────

  it('names both operator credentials by path and never by value', () => {
    const environment = environmentOf(BASE_COMPOSE_PATH, 'slot-app') ?? {};

    for (const [key, path] of Object.entries(EXPECTED_CREDENTIAL_FILE_VARS)) {
      expect(
        environment[key],
        `${BASE_COMPOSE_PATH} slot-app: ${key} must name the mounted path ${path}, found ${String(environment[key])}`
      ).toBe(path);
    }

    // The literal-valued forms, in EVERY service of every file. Checked
    // against the parsed environment keys rather than the file's text, because
    // the file's own prose says at length that these two variables do not
    // exist — and because TOON_OPERATOR_WRITE_KEY_FILE contains
    // TOON_OPERATOR_WRITE_KEY as a substring.
    for (const file of EVERY_COMPOSE_FILE) {
      for (const service of Object.keys(readCompose(file).services ?? {})) {
        for (const forbidden of FORBIDDEN_LITERAL_CREDENTIAL_VARS) {
          expect(
            Object.keys(environmentOf(file, service) ?? {}),
            `${file} ${service}: sets ${forbidden} to a literal. An image's environment is readable from its metadata without ever running it — name the FILE instead.`
          ).not.toContain(forbidden);
        }
      }
    }
  });

  it('mounts both credentials read-only, and keeps the seed out of the connector', () => {
    const slotApp =
      readCompose(BASE_COMPOSE_PATH).services?.['slot-app']?.volumes ?? [];

    for (const mount of EXPECTED_SLOT_APP_CREDENTIAL_MOUNTS) {
      expect(
        slotApp,
        `${BASE_COMPOSE_PATH} slot-app: expected the mount ${mount}`
      ).toContain(mount);
    }

    const connector =
      readCompose(BASE_COMPOSE_PATH).services?.['connector']?.volumes ?? [];

    for (const mount of EXPECTED_CONNECTOR_OPERATOR_MOUNTS) {
      expect(
        connector,
        `${BASE_COMPOSE_PATH} connector: expected the mount ${mount} — the bearer token gates its reads and operator-write.keys is the ALLOWLIST of public halves a hub operator hand-edits to revoke authority`
      ).toContain(mount);
    }

    for (const mount of connector) {
      expect(
        mount.includes(NEVER_MOUNTED_INTO_THE_CONNECTOR),
        `${BASE_COMPOSE_PATH} connector: mounts "${mount}". ${NEVER_MOUNTED_INTO_THE_CONNECTOR} is the slot app's PRIVATE seed — the credential that mutates this hub's routing table — and it belongs in the slot-app service and nowhere else.`
      ).toBe(false);
    }

    // Read-only on both sides. A credential a container can rewrite is a
    // credential a compromised container can rotate out from under its
    // operator.
    for (const mount of [
      ...EXPECTED_SLOT_APP_CREDENTIAL_MOUNTS,
      ...EXPECTED_CONNECTOR_OPERATOR_MOUNTS,
    ]) {
      expect(mount.endsWith(':ro')).toBe(true);
    }
  });

  it('gitignores every credential a hub operator generates', () => {
    const rules = readFile(GITIGNORE_PATH)
      .split('\n')
      .map((line) => line.trim());

    for (const pattern of EXPECTED_GITIGNORED) {
      expect(
        rules,
        `${GITIGNORE_PATH}: no \`${pattern}\` rule. This is the one directory in the fleet where the allowlist and the seed live side by side, so both are named as well as wildcarded — a wildcard is a rule you have to know and a name is a rule you can read.`
      ).toContain(pattern);
    }
  });

  it('keeps every credential out of the build context', () => {
    // `docker-compose.local.yml` builds the slot app with `context: ../..`, so
    // a hub operator's keys beside this bundle are inside the directory handed
    // to the daemon. `pnpm test:image` proves the patterns do what they say by
    // building real images with dummy key material planted; this holds the
    // list still on every run.
    const rules = readFile(DOCKERIGNORE_PATH)
      .split('\n')
      .map((line) => line.trim());

    for (const pattern of EXPECTED_DOCKERIGNORED) {
      expect(rules, `${DOCKERIGNORE_PATH}: no \`${pattern}\` rule`).toContain(
        pattern
      );
    }
  });

  it('commits no key material', () => {
    // This repository is public and this bundle runs on live boxes. Every
    // credential its README tells an operator to generate is `openssl rand
    // -hex 32` — 64 hex characters — and none of them may ever be committed,
    // in a compose file, in an .env.example, or in a README's worked example.
    for (const file of committedHubFiles()) {
      const found = KEY_MATERIAL.exec(readFile(file));
      expect(
        found,
        `${file}: contains a 64-hex run ("${String(found?.[0]).slice(0, 8)}…") — that is the shape of every credential this bundle generates, and none of them is committable`
      ).toBeNull();
    }

    // And the one secret that lives in `.env` ships empty.
    expect(
      readFile(ENV_EXAMPLE_PATH),
      `${ENV_EXAMPLE_PATH}: ${ENV_EXAMPLE_SECRET} must ship empty for an operator to fill in`
    ).toContain(`${ENV_EXAMPLE_SECRET}=\n`);
  });

  // ── Healthchecks ───────────────────────────────────────────────────────────

  it('healthchecks all three services, and dials 127.0.0.1 rather than localhost', () => {
    // A healthcheck that has been deleted is not a healthcheck that passes:
    // Caddy and the connector both gate their own startup on these, so a
    // missing one is a node that comes up in the wrong order.
    const services = readCompose(BASE_COMPOSE_PATH).services ?? {};

    for (const [service, command] of Object.entries(EXPECTED_HEALTHCHECKS)) {
      expect(
        services[service]?.healthcheck?.test,
        `${BASE_COMPOSE_PATH} ${service}: expected the healthcheck \`${command}\``
      ).toEqual(['CMD-SHELL', command]);
    }

    // And nothing anywhere in the compose set may reintroduce localhost: the
    // listeners are IPv4-only, but "localhost" in a container can resolve to
    // ::1, where nothing is listening.
    for (const file of EVERY_COMPOSE_FILE) {
      for (const [service, definition] of Object.entries(
        readCompose(file).services ?? {}
      )) {
        const test = (definition.healthcheck?.test ?? []).join(' ');
        expect(
          test.includes('localhost'),
          `${file} ${service}: healthcheck dials localhost ("${test}") — use 127.0.0.1`
        ).toBe(false);
      }
    }
  });

  // ── Caddy ──────────────────────────────────────────────────────────────────

  it('fronts the connector edge and the free reads, and nothing else', () => {
    // The file's own prose explains at length why the app ports are absent
    // from it, so the check reads the DIRECTIVES only.
    const directives = directivesOf(CADDYFILE_PATH);

    expect(
      caddyReverseProxies(),
      `${CADDYFILE_PATH}: expected exactly ${JSON.stringify(EXPECTED_CADDY_UPSTREAMS)}. Caddy fronts the connector's client edge and the relay's free reads — being FOUND is free, being REACHABLE is the slot — and nothing else has a public path.`
    ).toEqual(EXPECTED_CADDY_UPSTREAMS);

    // A Caddy route to either payment-oblivious surface is the same free door
    // as a `ports:` entry, reached through the front instead of around it. On
    // the slot app that door would sell nothing and give away two things: a
    // free slot, and /roster's list of every broadcaster this hub admitted.
    for (const forbidden of FORBIDDEN_CADDY_UPSTREAMS) {
      expect(
        directives.includes(forbidden),
        `${CADDYFILE_PATH}: a directive names "${forbidden}" — Caddy fronts the connector's client edge and the relay's free reads, and nothing else.`
      ).toBe(false);
    }
  });
});

// ── The routes against the surface the app actually serves ───────────────────

/**
 * Connector ADR 0067 publishes each route's `request` shape to the client and
 * never reads a key out of it, and it assigns the check that a declared shape
 * matches what the app serves to the APP'S OWN repository — which is this one.
 *
 * So this last section does not compare two literals. It boots the REAL slot
 * app, configured exactly the way `docker-compose.yml` configures it, and
 * speaks HTTP at it: the declared method reaches the declared path, no other
 * method does, the declared body key is the one the app reads, and the two
 * addresses that must never be routed are addresses the app really serves.
 */
describe('the hub routes against the surface the slot app serves', () => {
  let app: SlotAppInstance;
  let dataDir: string;

  /**
   * A payer key of the shape a terminating connector states — `evm:0x<64 hex>`
   * (connector ADR 0040). Random, because no credential literal belongs in
   * this repository, and it is not a credential here anyway: it is the one
   * identity in a request that is not self-asserted.
   */
  const payer = `evm:0x${randomBytes(32).toString('hex')}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-bundle-guard-'));
    // Both credentials mounted as files, the way the compose file mounts them.
    // The app refuses to start without either.
    const writeKeyFile = join(dataDir, 'operator-signing.key');
    const bearerTokenFile = join(dataDir, 'operator-bearer.token');
    for (const file of [writeKeyFile, bearerTokenFile]) {
      writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, {
        mode: 0o600,
      });
    }

    app = await startSlotApp({
      slotPort: 0,
      host: '127.0.0.1',
      dataDir,
      // The bundle's own numbers, so the surface under test is the surface the
      // bundle configures. The operator URL is a port nothing is listening on:
      // nothing here makes an operator write, and the app's own boot
      // reconciliation says so in the log rather than refusing to boot.
      operatorUrl: 'http://127.0.0.1:1',
      hubAddress: HUB_ADDRESS,
      slotPrice: EXPECTED_SLOT_APP_ENVIRONMENT['TOON_SLOT_PRICE'],
      operatorWriteKeyFile: writeKeyFile,
      operatorBearerTokenFile: bearerTokenFile,
    });
  });

  afterAll(async () => {
    await app.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${String(app.config.slotPort)}${path}`;
  }

  it('answers the declared method at every path the hub terminates', async () => {
    for (const route of EXPECTED_ROUTES.filter((r) =>
      r.handlerUrl.startsWith(SLOT_APP_BASE_URL)
    )) {
      const path = new URL(route.handlerUrl).pathname;
      const response = await fetch(url(path), {
        method: route.method,
        headers: {
          'X-TOON-Payer': payer,
          'X-TOON-Amount':
            EXPECTED_SLOT_APP_ENVIRONMENT['TOON_SLOT_PRICE'] ?? '0',
          ...(route.contentType === undefined
            ? {}
            : { 'Content-Type': route.contentType }),
        },
        ...(route.method === 'GET' ? {} : { body: JSON.stringify({}) }),
      });

      expect(
        response.status,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: declares ${route.method} ${path}, and the slot app answers ${String(response.status)} there — a route naming an address the app does not serve is a broadcaster's purchase failing in production`
      ).not.toBe(404);
    }
  });

  it('serves no other method at those paths', async () => {
    // A declared shape a client follows is only worth having if the shape is
    // the one that works. The quote is a GET and the buy is a POST, and
    // neither answers the other's verb.
    const swapped: Record<string, string> = { GET: 'POST', POST: 'GET' };

    for (const route of EXPECTED_ROUTES.filter((r) =>
      r.handlerUrl.startsWith(SLOT_APP_BASE_URL)
    )) {
      const path = new URL(route.handlerUrl).pathname;
      const response = await fetch(url(path), {
        method: swapped[route.method],
        headers: { 'X-TOON-Payer': payer },
      });

      expect(
        [404, 405],
        `${path}: the app answered ${String(response.status)} to a ${String(swapped[route.method])} — the route declares ${route.method} and only ${route.method} should work`
      ).toContain(response.status);
    }
  });

  it('reads exactly the body key the buy route declares', async () => {
    const buy = EXPECTED_ROUTES.find((route) => route.prefix === BUY_PREFIX);
    const path = new URL(buy?.handlerUrl ?? '').pathname;
    const headers = {
      'X-TOON-Payer': payer,
      'X-TOON-Amount': EXPECTED_SLOT_APP_ENVIRONMENT['TOON_SLOT_PRICE'] ?? '0',
      'Content-Type': 'application/json',
    };

    // A body that names anything else is refused, and the refusal names the
    // key the route declares — so a client following the published shape and
    // a client that misread it get different answers.
    const wrong = await fetch(url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify({ station_url: 'https://station.invalid/ilp' }),
    });
    const refusal = (await wrong.json()) as { message?: string };

    expect(wrong.status).toBe(400);
    for (const key of buy?.bodyKeys ?? []) {
      expect(
        refusal.message,
        `${CONNECTOR_TOML_PATH} route ${BUY_PREFIX}: declares the body key "${key}", but the app's refusal for a body without it does not name it — the published shape and the shape the app reads have drifted`
      ).toContain(key);
    }

    // And a body that names it gets PAST the body check. It fails later, on
    // the station this guard does not run — a different refusal, which is the
    // point: the declared key is the one that works.
    const right = await fetch(url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify({ stationUrl: 'https://station.invalid/ilp' }),
    });

    expect(
      right.status,
      `${CONNECTOR_TOML_PATH} route ${BUY_PREFIX}: a body carrying the declared key ${JSON.stringify(buy?.bodyKeys)} was still refused as a malformed body`
    ).not.toBe(400);
  });

  it('serves the unpriced addresses that must never be routed', async () => {
    // The other half of "give them no route": these are real addresses on the
    // app port, answering with no notion of a payment at all. If they stopped
    // existing, the routing rule above would be guarding nothing — and if they
    // exist, publishing that port gives them away.
    for (const path of ['/health', '/roster']) {
      const response = await fetch(url(path));
      expect(
        response.status,
        `the slot app answers ${String(response.status)} at ${path} — it is unpriced and in-node, and the only thing keeping it off the internet is that its port is published nowhere`
      ).toBe(200);
    }
  });

  it('serves nothing at the bare app root', async () => {
    // Which is why a route pointed at `http://slot-app:3200` is not merely too
    // shallow: it is a paid packet reaching nothing at all.
    const response = await fetch(url('/'));
    expect(response.status).toBe(404);
  });
});
