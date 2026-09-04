/**
 * Guards the deploy bundle — the files this repo hands a broadcaster to run a
 * station node.
 *
 * It reads the REAL files, not fixtures: a fixture would keep passing while
 * the shipped artifact regressed. Every expected value is a literal declared
 * here and never read back out of the file under test, so a reverted fix
 * fails this suite instead of quietly agreeing with itself.
 *
 * Two hazards earn most of this file, and both are "fixes" a future reader
 * will reach for:
 *
 * - A FREE DOOR. The origin's segment port is the payment-oblivious surface:
 *   `/segments/<rung>/<seq>.ts`, `/now`, `/health` and `/encode` all answer on
 *   it with no notion of a payment at all. The only thing that makes a
 *   station a paid station is that this port is published on no interface, so
 *   the one route to a broadcaster's vibes is a paid packet through their
 *   connector. Turning its `expose:` into a `ports:` — for a quick curl, in
 *   any compose file, in any file set — opens that door, and a docker publish
 *   without a host-IP prefix beats ufw because Docker's iptables chain runs
 *   ahead of it. A Caddy route to it does the same thing through the front.
 *
 * - A DEAD PRICE. `per_kib` on a station route (ADR 0002) prices the INBOUND
 *   payload, and a viber's request for a segment is a few hundred bytes while
 *   the vibes are in the fulfill. Someone will set it expecting bigger
 *   segments to cost more; it will silently do nothing, and the symptom on a
 *   live box is "revenue is flat and nobody knows why". It fails here
 *   instead.
 *
 * The rest holds still the facts that make the paid path a paid path: one
 * route per rung at that rung's price, each terminating strictly beneath the
 * origin path it claims to price; `/health` and `/encode` reachable at no
 * price because they have no route at all; the connector pin in exactly one
 * place, because two copies drift; and healthchecks dialling 127.0.0.1,
 * because "localhost" in a container can resolve to ::1 where an IPv4-bound
 * listener never answers.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');

const CONNECTOR_TOML_PATH = 'deploy/connector.toml';
const CADDYFILE_PATH = 'deploy/Caddyfile';
const ENV_EXAMPLE_PATH = 'deploy/.env.example';
const ORIGIN_DOCKERFILE_PATH = 'packages/station-origin/Dockerfile';

// The pin of record, and the only file in this repository a connector build
// may be named in.
const BASE_COMPOSE_PATH = 'deploy/docker-compose.yml';
const LOCAL_COMPOSE_PATH = 'deploy/docker-compose.local.yml';
const WATCHTOWER_COMPOSE_PATH = 'deploy/docker-compose.watchtower.yml';

/** Every compose file this bundle ships. Each is checked on its own. */
const EVERY_COMPOSE_FILE = [
  BASE_COMPOSE_PATH,
  LOCAL_COMPOSE_PATH,
  WATCHTOWER_COMPOSE_PATH,
];

/**
 * Every file set an operator is told to run — deploy/README.md and the header
 * of docker-compose.yml name exactly these three. A publish added to an
 * overlay is as much a free door as one added to the base file, so the ports
 * invariant is checked against each set, not only against the base.
 */
const COMPOSE_FILE_SETS: { name: string; files: string[] }[] = [
  { name: 'production', files: [BASE_COMPOSE_PATH] },
  { name: 'local', files: [BASE_COMPOSE_PATH, LOCAL_COMPOSE_PATH] },
  { name: 'watchtower', files: [BASE_COMPOSE_PATH, WATCHTOWER_COMPOSE_PATH] },
];

// ── The ports ────────────────────────────────────────────────────────────────

/**
 * The segment port. THE ONE PORT THAT IS NEVER HOST-PUBLISHED, IN ANY FORM,
 * NOT EVEN ON LOOPBACK — it has no authentication and no notion of a payment,
 * so a loopback publish is not a mitigation, it is a free door for anything
 * that can reach the box.
 */
const SEGMENT_PORT = '3100';
/** RTMPS ingest. Published straight to the internet, gated on the stream key. */
const INGEST_PORT = '1935';
/** The connector's client edge. Loopback only — viber traffic arrives via Caddy. */
const CONNECTOR_EDGE_PORT = '3000';

/**
 * The prefix that makes a publish local-only. A `ports:` entry with no host IP
 * — or with 0.0.0.0 — binds every interface, and Docker's iptables chain runs
 * ahead of ufw, so such a publish is internet-reachable even with ufw locked
 * to 22/80/443/1935.
 */
const LOOPBACK_PUBLISH_PREFIX = '127.0.0.1:';

/**
 * The whole published set, in every file set: Caddy's two, the origin's
 * RTMPS ingest, and the connector edge on loopback. Exactly three ports are
 * reachable off-box and the segment port is not one of them.
 */
const EXPECTED_PUBLISHED_PORTS = [
  '127.0.0.1:3000:3000',
  '1935:1935',
  '443:443',
  '80:80',
];

/** The only two services allowed an unqualified — internet-reachable — publish. */
const SERVICES_ALLOWED_AN_UNQUALIFIED_PUBLISH = ['caddy', 'origin'];

// ── The ladder and the routes it must be priced by ───────────────────────────

/** The station's ILP apex. `demo` is the placeholder for a broadcaster's handle. */
const STATION_APEX = 'g.toon.slopmachine.demo';
/** The label of the *now* address — its own route at its own low price. */
const NOW_LABEL = 'now';
/** The origin path the *now* address terminates at. */
const NOW_PATH = '/now';
/** The path every rung's segments sit strictly beneath. */
const SEGMENTS_PATH = '/segments';
/** The origin, as the compose network addresses it. Nothing may terminate here. */
const ORIGIN_BASE_URL = `http://origin:${SEGMENT_PORT}`;

/**
 * The rungs on the ladder, in ladder order, cheapest first. Written out here
 * rather than read from TOON_RUNGS, so that dropping a rung from the ladder
 * without dropping its route — or the reverse — fails.
 */
const EXPECTED_RUNGS = ['audio', '480p', '720p', '1080p'];

/** The ladder spec itself: `docs/placeholder-numbers.md`'s four-rung ladder. */
const EXPECTED_LADDER_SPEC =
  'audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k';

/**
 * Every price this station charges, in the settlement token's smallest unit
 * (6-decimal USDC). Placeholders from `docs/placeholder-numbers.md`, not
 * decisions — but a price that CHANGES is a change to what a viber pays, so
 * it changes here too or it does not ship.
 */
const EXPECTED_ROUTE_PRICES: Record<string, number> = {
  [`${STATION_APEX}.now`]: 50,
  [`${STATION_APEX}.audio`]: 200,
  [`${STATION_APEX}.480p`]: 1000,
  [`${STATION_APEX}.720p`]: 2000,
  [`${STATION_APEX}.1080p`]: 3500,
};

/**
 * The origin paths this repo serves and deliberately does NOT price: in-node
 * diagnostics, outside every routed prefix. The only reason "unpriced" does
 * not mean "free to the internet" is that the segment port is published
 * nowhere — so a route acquiring one of these puts the diagnostics on sale
 * AND is the first half of pointing a route at the bare origin.
 */
const UNROUTED_ORIGIN_PATHS = ['/health', '/encode'];

// ── The connector image ──────────────────────────────────────────────────────

/**
 * The pin of record. Immutable by construction: the connector's config parser
 * is `deny_unknown_fields` and its startup is fail-closed, so a schema drift
 * under a moving tag would be an outage rather than a degraded run.
 */
const EXPECTED_CONNECTOR_TAG = 'rust-2026.08.28.1';
const EXPECTED_CONNECTOR_IMAGE = `ghcr.io/toon-protocol/connector:${EXPECTED_CONNECTOR_TAG}`;

/** Anything that reads as a connector build handle, in config or in prose. */
const CONNECTOR_BUILD_LITERAL =
  /rust-(?:sha-[0-9a-f]{7,40}|\d{4}\.\d{2}\.\d{2}\.\d+|main|release)/g;

/**
 * This file is the one place besides the pin of record that may name a
 * connector build, because a guard that cannot name the expected pin cannot
 * check it. Everything else in the repository is scanned.
 */
const THE_GUARD_ITSELF = 'deploy/bundle.test.ts';

const NOT_SCANNED_FOR_A_PIN = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'pnpm-lock.yaml',
]);

// ── Healthchecks ─────────────────────────────────────────────────────────────

/**
 * Every wget-based healthcheck this repo ships, and how to pull the target
 * host out of each site's own syntax. Both must be present: a healthcheck
 * that has been deleted is not a healthcheck that passes.
 */
const HEALTHCHECK_WGET_SITES: { file: string; pattern: RegExp }[] = [
  {
    file: BASE_COMPOSE_PATH,
    pattern: /wget -q --spider http:\/\/([^:/]+):3100\/health/,
  },
  {
    file: BASE_COMPOSE_PATH,
    pattern: /wget -q --spider http:\/\/([^:/]+):3000\/ilp\/identity/,
  },
  {
    file: ORIGIN_DOCKERFILE_PATH,
    pattern:
      /wget -q --spider "http:\/\/([^:/]+):\$\{TOON_SEGMENT_PORT:-3100\}\/health"/,
  },
];

// ── Reading the files under test ─────────────────────────────────────────────

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: string[];
  expose?: (string | number)[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  labels?: Record<string, string>;
  volumes?: string[];
}

interface DockerCompose {
  services?: Record<string, ComposeService>;
}

/**
 * `docker-compose.local.yml` tags a list `!override` so compose replaces the
 * base file's volumes instead of concatenating onto them. It is a compose
 * tag, not a YAML one, so it is taught to the parser here rather than
 * silently warned past — a bundle file that fails to parse must be a loud
 * failure, not a skipped check.
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
 * Compose substitutes `${VAR:-default}` from the operator's .env; with no
 * .env — the shape this repo ships — every substitution becomes its default.
 * A publish hidden behind a variable is still a publish.
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
 * an operator gets. A `ports: !override` in an overlay could in principle
 * shorten that union; none exists, and the over-approximation errs towards
 * flagging a publish rather than missing one, which is the direction this
 * invariant wants to be wrong in.
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

interface ConnectorRoute {
  prefix: string;
  price: number;
  handler_url: string;
  per_kib?: number;
}

interface ConnectorToml {
  node: { addresses: string[] };
  routes: ConnectorRoute[];
}

function readConnectorToml(): ConnectorToml {
  return parse(readFile(CONNECTOR_TOML_PATH)) as unknown as ConnectorToml;
}

/** The last label of an ILP prefix — the rung name, or `now`. */
function labelOf(prefix: string): string {
  return prefix.slice(`${STATION_APEX}.`.length);
}

/**
 * The origin path a route for `label` must terminate at, derived from
 * literals here rather than from the file. A rung's segments sit strictly
 * beneath `/segments/<rung>/`, and an envelope's target resolves under the
 * route's handler path and can never replace any part of it (connector ADR
 * 0025) — so this path IS the guarantee that a packet paying the audio price
 * reaches audio segments and nothing else.
 */
function expectedHandlerUrl(label: string): string {
  return label === NOW_LABEL
    ? `${ORIGIN_BASE_URL}${NOW_PATH}`
    : `${ORIGIN_BASE_URL}${SEGMENTS_PATH}/${label}`;
}

/** Every text file in the repository, bar the ones a pin could not hide in. */
function everyRepositoryFile(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (NOT_SCANNED_FOR_A_PIN.has(entry.name)) return [];
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.isFile()) return [];
      return [relative(REPO_ROOT, path)];
    });
  return walk(REPO_ROOT);
}

describe('deploy bundle', () => {
  // ── A free door ────────────────────────────────────────────────────────────

  it('never host-publishes the segment port, in any file, in any form', () => {
    for (const file of EVERY_COMPOSE_FILE) {
      for (const { service, entry } of publishedPorts([file])) {
        expect(
          portsNamedBy(entry).includes(SEGMENT_PORT),
          `${file} service "${service}": publishes "${entry}", which names the segment port :${SEGMENT_PORT}. That port is the payment-oblivious surface — segments, /now, /health and /encode all answer on it with no notion of a payment — so publishing it, even on ${LOOPBACK_PUBLISH_PREFIX}, is a free door onto a broadcaster's vibes. It stays \`expose:\` and nothing else.`
        ).toBe(false);
      }
    }
  });

  it('keeps the segment port on `expose:`, so the connector can still dial it', () => {
    // The other half of the invariant: a port that is published nowhere AND
    // exposed nowhere is not private, it is unreachable — the connector
    // cannot dial it and every paid pull 502s.
    const exposed = (
      readCompose(BASE_COMPOSE_PATH).services?.['origin']?.expose ?? []
    ).map(String);

    expect(
      exposed,
      `${BASE_COMPOSE_PATH} origin: expected the segment port under \`expose:\`, found ${JSON.stringify(exposed)}`
    ).toEqual([SEGMENT_PORT]);
  });

  it('publishes exactly the TLS front, the RTMPS ingest port and a loopback edge', () => {
    for (const { name, files } of COMPOSE_FILE_SETS) {
      const entries = publishedPorts(files).map(({ entry }) => entry);

      expect(
        [...new Set(entries)].sort(),
        `the ${name} file set (${files.join(' + ')}) publishes ${JSON.stringify(entries)} — the published set is Caddy's 80 and 443, the origin's RTMPS :${INGEST_PORT}, and the connector edge on loopback, and nothing else`
      ).toEqual([...EXPECTED_PUBLISHED_PORTS].sort());
    }
  });

  it('lets only the TLS front and RTMPS ingest bind every interface', () => {
    // The substance is "a publish with no host IP is internet-reachable even
    // with ufw locked down". Caddy earns one because being reachable is its
    // whole job; the origin earns one because stock Caddy does not speak RTMP,
    // so it fronts its own stream-key-gated ingest. Nothing else may.
    for (const { file, service, entry } of publishedPorts(EVERY_COMPOSE_FILE)) {
      if (
        SERVICES_ALLOWED_AN_UNQUALIFIED_PUBLISH.includes(service) &&
        !entry.startsWith(LOOPBACK_PUBLISH_PREFIX)
      ) {
        continue;
      }
      expect(
        entry.startsWith(LOOPBACK_PUBLISH_PREFIX),
        `${file} service "${service}": publishes "${entry}" with no host IP — only ${SERVICES_ALLOWED_AN_UNQUALIFIED_PUBLISH.join(' and ')} may be reachable off-box, and a bare docker publish beats ufw. Prefix it "${LOOPBACK_PUBLISH_PREFIX}" or use \`expose:\`.`
      ).toBe(true);
    }
  });

  it('binds the connector edge to loopback, exactly once', () => {
    const edgePublishes = publishedPorts([BASE_COMPOSE_PATH])
      .map(({ entry }) => entry)
      .filter((entry) => portsNamedBy(entry).includes(CONNECTOR_EDGE_PORT));

    expect(
      edgePublishes,
      `${BASE_COMPOSE_PATH}: the connector edge must be published on loopback exactly once, found ${JSON.stringify(edgePublishes)}`
    ).toEqual([
      `${LOOPBACK_PUBLISH_PREFIX}${CONNECTOR_EDGE_PORT}:${CONNECTOR_EDGE_PORT}`,
    ]);
  });

  it('routes TLS to the connector edge and never to the origin', () => {
    // The file's own prose explains at length why the segment port is absent
    // from it, so the check reads the DIRECTIVES only.
    const directives = readFile(CADDYFILE_PATH)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(directives).toContain(
      `reverse_proxy connector:${CONNECTOR_EDGE_PORT}`
    );

    // A Caddy route to the origin is the same free door as a `ports:` entry,
    // reached through the front instead of around it — and Caddy does not
    // speak RTMP, so an ingest route here would be a broken one besides.
    for (const forbidden of ['origin', SEGMENT_PORT, INGEST_PORT]) {
      expect(
        directives.includes(forbidden),
        `${CADDYFILE_PATH}: a directive names "${forbidden}" — Caddy fronts the connector edge and nothing else. The origin's segment port is the payment-oblivious surface and must be reachable through no public path at all, and ingest is RTMP, which stock Caddy does not speak.`
      ).toBe(false);
    }
  });

  // ── A dead price ───────────────────────────────────────────────────────────

  it('never sets per_kib on a station route', () => {
    // ADR 0002: every station price is flat per segment and the slope is
    // always zero. A price is a schedule over the INBOUND payload, and a
    // viber's request is a few hundred bytes while the vibes are in the
    // fulfill — so per_kib would bill the request and do nothing at all for
    // the megabyte it returns. This is the "fix" a future reader attempts.
    for (const route of readConnectorToml().routes) {
      expect(
        route.per_kib,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: sets per_kib = ${String(route.per_kib)}. A station price is flat per segment (ADR 0002) — per_kib prices the REQUEST, so it would silently do nothing while looking like it priced the vibes. Price bitrate by address instead: that is what one route per rung is for.`
      ).toBeUndefined();
    }

    // Belt and braces against a form the TOML parse would not surface as a
    // route field — a `[routes.per_kib]`-shaped table, say. Anchored to an
    // assignment so the file's own prose about per_kib does not trip it.
    expect(
      readFile(CONNECTOR_TOML_PATH),
      `${CONNECTOR_TOML_PATH}: assigns per_kib somewhere — no station route may set it (ADR 0002)`
    ).not.toMatch(/^\s*per_kib\s*=/m);
  });

  // ── One route per rung, at that rung's price ───────────────────────────────

  it('prices exactly the ladder it runs: one route per rung, plus the *now*', () => {
    const composedLadder = resolveComposeDefaults(
      readCompose(BASE_COMPOSE_PATH).services?.['origin']?.environment?.[
        'TOON_RUNGS'
      ] ?? ''
    );

    // The ladder and the routes are ONE PAIR: a rung with no route is
    // unsellable, and a route naming a rung the origin does not offer is a
    // paid 404. Both sides are asserted against the same literal here, which
    // is what makes changing one without the other fail.
    expect(
      composedLadder,
      `${BASE_COMPOSE_PATH} origin: TOON_RUNGS must default to the documented ladder`
    ).toBe(EXPECTED_LADDER_SPEC);
    expect(
      readFile(ENV_EXAMPLE_PATH),
      `${ENV_EXAMPLE_PATH}: STATION_RUNGS must document the same ladder`
    ).toContain(`STATION_RUNGS=${EXPECTED_LADDER_SPEC}`);
    expect(
      composedLadder.split(',').map((rung) => rung.split(':')[0]),
      `${BASE_COMPOSE_PATH}: the ladder's rung names must be ${JSON.stringify(EXPECTED_RUNGS)}`
    ).toEqual(EXPECTED_RUNGS);

    const { routes, node } = readConnectorToml();
    const expectedPrefixes = [
      `${STATION_APEX}.${NOW_LABEL}`,
      ...EXPECTED_RUNGS.map((rung) => `${STATION_APEX}.${rung}`),
    ];

    expect(
      routes.map((route) => route.prefix).sort(),
      `${CONNECTOR_TOML_PATH}: expected one route per rung plus the *now* address; found ${JSON.stringify(routes.map((route) => route.prefix))}`
    ).toEqual([...expectedPrefixes].sort());

    // A prefix terminated but never advertised is an address no viber can
    // discover; one advertised but not terminated is a paid 404.
    expect(
      node.addresses.slice().sort(),
      `${CONNECTOR_TOML_PATH}: [node].addresses must list every terminated prefix, found ${JSON.stringify(node.addresses)}`
    ).toEqual([...expectedPrefixes].sort());
  });

  it('charges the documented, non-zero price on every route', () => {
    for (const route of readConnectorToml().routes) {
      const expected = EXPECTED_ROUTE_PRICES[route.prefix];
      expect(
        route.price,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: expected price ${String(expected)}, found ${String(route.price)}`
      ).toBe(expected);

      // Nothing free is served from a station node — a zero price is also
      // what disarms the x402 greeting.
      expect(
        route.price,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: price is ${String(route.price)} — nothing free is served from a station node`
      ).toBeGreaterThan(0);
    }
  });

  it('terminates each route strictly beneath the origin path it prices', () => {
    const { routes } = readConnectorToml();

    for (const route of routes) {
      const expected = expectedHandlerUrl(labelOf(route.prefix));
      expect(
        route.handler_url,
        `${CONNECTOR_TOML_PATH} route ${route.prefix}: expected handler_url ${expected}, found ${route.handler_url}. A route pointed anywhere else carries another address's price.`
      ).toBe(expected);

      // Pointing a route at the bare origin, or at `/segments`, makes every
      // rung reachable at one rung's price — and the bare origin puts
      // /health and /encode on sale besides. Asserted separately from the
      // literal above so that updating the literal cannot smuggle one in.
      for (const tooShallow of [
        ORIGIN_BASE_URL,
        `${ORIGIN_BASE_URL}/`,
        `${ORIGIN_BASE_URL}${SEGMENTS_PATH}`,
        `${ORIGIN_BASE_URL}${SEGMENTS_PATH}/`,
      ]) {
        expect(
          route.handler_url,
          `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates at "${tooShallow}" — every address beneath it would then be reachable at this route's price`
        ).not.toBe(tooShallow);
      }
    }

    // Two routes on one handler is one handler reachable at two prices: the
    // cheaper door takes every packet.
    const handlerUrls = routes.map((route) => route.handler_url);
    expect(
      new Set(handlerUrls).size,
      `${CONNECTOR_TOML_PATH}: two routes terminate at the same handler_url — the cheaper one would take every packet`
    ).toBe(handlerUrls.length);
  });

  it('gives the in-node diagnostics no route at any price', () => {
    const { routes, node } = readConnectorToml();

    // /health and /encode are unpriced because they are in-node, outside
    // every routed prefix; the only reason unpriced does not mean free to the
    // internet is that the segment port is published nowhere. A route to
    // either sells the diagnostics AND makes them publicly reachable.
    for (const path of UNROUTED_ORIGIN_PATHS) {
      for (const route of routes) {
        expect(
          route.handler_url.includes(path),
          `${CONNECTOR_TOML_PATH} route ${route.prefix}: terminates at "${route.handler_url}", which reaches ${path} — the in-node diagnostics have no route here and never may`
        ).toBe(false);
      }
      for (const address of node.addresses) {
        expect(
          labelOf(address),
          `${CONNECTOR_TOML_PATH}: [node].addresses advertises "${address}" — ${path} is not for sale`
        ).not.toBe(path.slice(1));
      }
    }
  });

  // ── The connector image ────────────────────────────────────────────────────

  it('runs the stock connector image on an immutable pin', () => {
    const pinned =
      readCompose(BASE_COMPOSE_PATH).services?.['connector']?.image;

    expect(
      pinned,
      `${BASE_COMPOSE_PATH}: the connector service has no \`image:\` — it is the pin of record`
    ).toBe(EXPECTED_CONNECTOR_IMAGE);

    // A moving tag would make the pin a pointer somebody else controls, and
    // the connector's config parser is deny_unknown_fields with a fail-closed
    // startup — so a drift under it is an outage, not a degraded run.
    expect(
      pinned,
      `${BASE_COMPOSE_PATH}: pin an immutable build — a rust-sha- build or a rust-<release handle> — never a moving tag`
    ).toMatch(/:(rust-sha-[0-9a-f]{7,40}|rust-\d{4}\.\d{2}\.\d{2}\.\d+)$/);
  });

  it('names a connector build in exactly one place', () => {
    const sites = everyRepositoryFile()
      .filter((file) => file !== THE_GUARD_ITSELF)
      .flatMap((file) => {
        const found = readFile(file).match(CONNECTOR_BUILD_LITERAL) ?? [];
        return found.map((literal) => ({ file, literal }));
      });

    expect(
      sites,
      `a connector build is named in ${JSON.stringify(sites)} — ${BASE_COMPOSE_PATH}'s connector \`image:\` is the only place in this repository a build may be pinned, because two copies drift and an operator then deploys one connector while reading about another`
    ).toEqual([{ file: BASE_COMPOSE_PATH, literal: EXPECTED_CONNECTOR_TAG }]);
  });

  it('never builds the connector — this repo publishes no connector image', () => {
    for (const file of EVERY_COMPOSE_FILE) {
      const connector = readCompose(file).services?.['connector'];
      if (!connector) continue;
      expect(
        connector.build,
        `${file} connector: has a \`build:\`. This repository publishes no connector image — the connector is the stock GHCR image on an immutable pin, the same one the relay, store and gas-station bundles run, and a local build is a second unreviewable source for what it runs.`
      ).toBeUndefined();
    }
  });

  it('mounts connector.toml rather than baking it into a derived image', () => {
    // Every price this station charges lives in that file, so it must be the
    // reviewed one on the box — not a copy sealed into an image nobody here
    // can read back.
    expect(
      readCompose(BASE_COMPOSE_PATH).services?.['connector']?.volumes ?? [],
      `${BASE_COMPOSE_PATH} connector: connector.toml must be mounted read-only`
    ).toContain('./connector.toml:/app/config/connector.toml:ro');
  });

  // ── Healthchecks ───────────────────────────────────────────────────────────

  it('healthchecks dial 127.0.0.1, never localhost', () => {
    for (const site of HEALTHCHECK_WGET_SITES) {
      const match = readFile(site.file).match(site.pattern);

      expect(
        match,
        `${site.file}: healthcheck target not found matching ${String(site.pattern)}`
      ).not.toBeNull();
      expect(
        match?.[1],
        `${site.file}: healthcheck targets "${String(match?.[1])}" — inside a container "localhost" can resolve to ::1, which an IPv4-bound listener never answers on`
      ).toBe('127.0.0.1');
    }

    // And nothing anywhere in the compose set may reintroduce it.
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
});
