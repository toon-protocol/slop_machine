/**
 * Guards the devnet bundle — the topology this repo runs a hub, a station and
 * a chain on, side by side, to prove the paid path works at all.
 *
 * The third sibling of `deploy/bundle.test.ts` and `deploy/hub/bundle.test.ts`,
 * held to the same two rules. It reads the REAL committed files, not fixtures,
 * because a fixture keeps passing while the shipped artifact regresses; and
 * every expected value is a literal declared here and never read back out of
 * the file under test, so a reverted fix fails this suite instead of quietly
 * agreeing with itself. Like both of them it needs no Docker daemon and runs
 * in `pnpm test` with everything else, so a broken topology fails fast rather
 * than after a chain has booted.
 *
 * A devnet is where a rule gets quietly relaxed, because nothing here is a box
 * anybody's money is on. That is exactly why it is guarded, and why the two
 * hazards that earn most of this file are the shipped bundles' own:
 *
 * - A FREE DOOR. The slot app's port and the origin's segment port are the
 *   payment-oblivious surfaces: `/quote`, `/buy`, `/health` and `/roster`
 *   answer on one and `/segments`, `/now`, `/health` and `/encode` on the
 *   other, none of them with any notion of a payment. Publishing either "just
 *   for the driver" would prove the paid path over a topology that had a free
 *   door in it — and it is the one habit that would then look normal in a
 *   bundle an operator runs. THE ANSWER HERE IS STRICTER THAN EITHER SIBLING'S:
 *   a hub publishes two doors off-box and a station three, and this bundle
 *   publishes NONE. There is no certificate in a laptop topology and nothing
 *   to terminate, so every publish is loopback-qualified and exists only for
 *   the driver.
 *
 * - A HUB THAT THINKS IT IS A STATION. Both node shapes are described in one
 *   file here for the first time, which is precisely the file in which an
 *   ingest port or an origin can be pasted into the wrong half. A hub carries
 *   no vibes of its own; RTMP belongs to the station half and to nothing else.
 *
 * The rest holds still the facts that make this a devnet rather than a fourth
 * deployment: two connectors on DISTINCT host ports, because they now share a
 * machine and that is the whole reason the two shipped bundles' overlays could
 * not be stacked into one; service names that say which node they belong to,
 * because two of everything is running; a chain pinned by DIGEST, so a foundry
 * release cannot change what the devnet's chain means underneath a green run;
 * no new published image; and no committed credential, on the same terms the
 * hub bundle is held to.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The bundle, as a path a failure message can be pasted from. */
const DEVNET_DIR = 'deploy/devnet';

const COMPOSE_PATH = `${DEVNET_DIR}/docker-compose.yml`;
const GITIGNORE_PATH = `${DEVNET_DIR}/.gitignore`;

/**
 * Every file set the devnet is run with — one, and that is the point. The two
 * shipped bundles each ship three (production, local, watchtower) because an
 * operator chooses between them; nobody operates a devnet, so there is one
 * topology and the driver drives it.
 */
const EVERY_COMPOSE_FILE = [COMPOSE_PATH];

/** The compose project name. Two connectors and two node shapes share a machine with it. */
const PROJECT_NAME = 'slopmachine-devnet';

// ── The services ─────────────────────────────────────────────────────────────

/**
 * Every service, by name, written out so that one ADDED to this topology — a
 * Caddy, a relay, a second station — is a failure here rather than a surprise
 * in a run.
 *
 * EVERY NAME SAYS WHICH NODE IT BELONGS TO. Two connectors are running; they
 * hold different keys, terminate different prefixes and answer on different
 * host ports. A bare `connector` is a log line nobody can place and a
 * `docker compose exec` into the wrong box.
 */
const HUB_SERVICES = ['hub-connector', 'hub-slot-app'];
const STATION_SERVICES = ['station-connector', 'station-origin'];
const CHAIN_SERVICE = 'chain';
const EXPECTED_SERVICES = [CHAIN_SERVICE, ...HUB_SERVICES, ...STATION_SERVICES];

/**
 * A service name that names a role without naming its node. `connector` is the
 * one that matters — there are two — but an `origin` or a `slot-app` would be
 * the same mistake made about a node that happens to have only one of them.
 */
const UNPLACEABLE_SERVICE_NAMES = [
  'connector',
  'origin',
  'slot-app',
  'relay',
  'caddy',
];

/** A service name that would mean a hub had grown an uplink. */
const A_STATION_SERVICE = /(^|[-_])(origin|ingest|rtmp)([-_]|$)/i;

// ── The ports ────────────────────────────────────────────────────────────────

/**
 * The slot app's port. NEVER HOST-PUBLISHED, IN ANY FORM, NOT EVEN ON LOOPBACK
 * — it has no authentication and no notion of a payment, so a loopback publish
 * is not a mitigation, it is a free slot and a free roster.
 */
const SLOT_APP_PORT = '3200';
/** The origin's segment port. The same rule, for the same reason: it serves vibes. */
const SEGMENT_PORT = '3100';
/** RTMP ingest. The STATION half's, `expose:`d and never published. */
const RTMP_PORT = '1935';
/** Both connectors' client edge, INSIDE the container. Both listen on it. */
const CONNECTOR_EDGE_PORT = '3000';

/** The prefix that makes a publish local-only. A publish without it beats ufw. */
const LOOPBACK_PUBLISH_PREFIX = '127.0.0.1:';

/**
 * The whole published set. NOTHING IS REACHABLE OFF-BOX — not two doors as a
 * hub has, not three as a station has, but none — and each of these exists
 * only so the driver can speak to what it is driving.
 *
 * The two connector edges are the reason this bundle cannot be assembled out
 * of the two shipped local overlays: they publish the same host port, each
 * frozen by its own guard, and here two connectors share a machine.
 */
const EXPECTED_PUBLISHED_PORTS: Record<string, string> = {
  chain: `${LOOPBACK_PUBLISH_PREFIX}8545:8545`,
  'hub-connector': `${LOOPBACK_PUBLISH_PREFIX}3000:${CONNECTOR_EDGE_PORT}`,
  'station-connector': `${LOOPBACK_PUBLISH_PREFIX}3001:${CONNECTOR_EDGE_PORT}`,
};

/** What each service keeps on `expose:` — private, but still dialable on this network. */
const EXPECTED_EXPOSE: Record<string, string[]> = {
  'hub-slot-app': [SLOT_APP_PORT],
  // The segment port AND the ingest port. The vibes are pushed by an ffmpeg
  // inside the origin's own image, on this network, so ingest needs no publish
  // either — and the devnet introduces no image to encode with.
  'station-origin': [SEGMENT_PORT, RTMP_PORT],
};

/** A TLS front's two doors. Neither may be named anywhere: there is no certificate here. */
const TLS_FRONT_PORTS = ['80', '443'];

// ── The chain ────────────────────────────────────────────────────────────────

/**
 * anvil, PINNED BY DIGEST. The tag beside it is for a reader; the digest is
 * what is fetched, so a foundry release cannot change what "the devnet's
 * chain" means underneath a green run. It is also the one 64-hex run this
 * bundle is allowed to commit — see the key-material check at the foot.
 */
const EXPECTED_CHAIN_IMAGE =
  'ghcr.io/foundry-rs/foundry:v1.4.0@sha256:f6a3fd201ae617fdc67bf7b3db9abdca7678e2589e15eda6bc84f88eb5239e04';
const PINNED_BY_DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * The chain's own facts. Chain id 31337 and ten funded accounts are what make
 * the settlement contracts land at the deterministic addresses the rest of the
 * fleet commits, so a configuration copied from a sibling repo is either right
 * here or loudly wrong.
 */
const EXPECTED_CHAIN_ID = '31337';
const EXPECTED_ACCOUNTS = '10';
/**
 * And NO block time. A block per transaction means a transaction waits on
 * itself rather than on a clock, so the run is bounded by the work it does.
 */
const A_BLOCK_TIME = '--block-time';

// ── The images ───────────────────────────────────────────────────────────────

/**
 * The pin of record for a connector build lives in `deploy/docker-compose.yml`
 * and may be named nowhere else in this repository — `deploy/bundle.test.ts`
 * fails on a third site. So both connectors here take a REQUIRED variable with
 * no default, and the driver reads that pin and passes it in: the devnet runs
 * exactly the connector the two shipped bundles pin, with nothing here that
 * can drift away from it.
 */
const CONNECTOR_IMAGE_VAR = 'DEVNET_CONNECTOR_IMAGE';
const REQUIRED_VARIABLE = new RegExp(
  `^\\$\\{${CONNECTOR_IMAGE_VAR}:\\?[^}]*\\}$`
);

/** Anything that reads as a connector build handle, in config or in prose. */
const CONNECTOR_BUILD_LITERAL =
  /rust-(?:sha-[0-9a-f]{7,40}|\d{4}\.\d{2}\.\d{2}\.\d+|main|release)/;

/**
 * The only two services that may be built, and the only Dockerfiles they may
 * be built from. THE DEVNET INTRODUCES NO NEW PUBLISHED IMAGE: the connector
 * and the chain are already-published images, and these two are this
 * repository's own apps, built from the checkout exactly as each shipped
 * bundle's local overlay builds its own.
 */
const EXPECTED_BUILDS: Record<string, string> = {
  'hub-slot-app': 'packages/slot-app/Dockerfile',
  'station-origin': 'packages/station-origin/Dockerfile',
};
/** The repository root, two directories up from this bundle. */
const EXPECTED_BUILD_CONTEXT = '../..';

// ── The generated configuration ──────────────────────────────────────────────

/**
 * The ignored working directory every generated file lands in. Both
 * `connector.toml`s, both connectors' keys, both bearer tokens and allowlists,
 * the hub's operator signing seed and the station's stream key.
 *
 * Nothing under `deploy/` or `deploy/hub/` is read as the devnet's own
 * configuration and nothing here is committed: no credential literal belongs
 * in this repository, and the addresses in a rendered `connector.toml` are the
 * ones the contracts landed at on THIS run's chain.
 */
const WORK_DIR_MOUNT_PREFIX = './run/';
const EXPECTED_GITIGNORED = ['run/'];

/** Each connector's generated config, mounted read-only where the image reads it. */
const EXPECTED_CONFIG_MOUNTS: Record<string, string> = {
  'hub-connector': './run/hub/connector.toml:/app/config/connector.toml:ro',
  'station-connector':
    './run/station/connector.toml:/app/config/connector.toml:ro',
};

/**
 * The slot app's PRIVATE ed25519 seed. It is mounted into the app and into
 * nothing else — the hub's connector gets `operator-write.keys`, the ALLOWLIST
 * of public halves, which is a different kind of artifact living in the same
 * generated directory.
 */
const NEVER_MOUNTED_INTO_A_CONNECTOR = 'operator-signing.key';

/**
 * Both operator credentials are named by PATH. The literal-valued forms must
 * exist nowhere: an image's environment is readable from its metadata without
 * ever running it, and a devnet is not an exception to that.
 */
const FORBIDDEN_LITERAL_CREDENTIAL_VARS = [
  'TOON_OPERATOR_WRITE_KEY',
  'TOON_OPERATOR_BEARER_TOKEN',
  'TOON_STREAM_KEY',
];

/**
 * The origin's ingest TLS pair, EMPTY and not absent. There is no certificate
 * in a laptop topology; the origin refuses to start on a certificate without a
 * key, so the two go together, and it says loudly at boot that ingest is
 * unencrypted — which here is the truth rather than a warning.
 */
const EXPECTED_EMPTY_INGEST_TLS = [
  'TOON_INGEST_TLS_CERT',
  'TOON_INGEST_TLS_KEY',
];

// ── The settlement contracts ─────────────────────────────────────────────────

/**
 * The trimmed artifacts the chain replay deploys from, and the whole reason a
 * run needs NO FOUNDRY, NO RUST AND NO SUBMODULES on the machine: a
 * `forge script` in a container would need the contracts tree and two
 * submodules, and a vendored `anvil --dump-state` snapshot would be coupled to
 * the anvil version and would carry a mock token with no `mint` — which a
 * devnet that has to fund a viber needs.
 */
const CONTRACTS_DIR = `${DEVNET_DIR}/contracts`;
const EXPECTED_ARTIFACTS = ['MockERC20', 'TokenNetworkRegistry'];

/**
 * `{ abi, bytecode }` and nothing else. This is what makes the key-material
 * exemption below sound rather than convenient: an artifact of exactly these
 * two keys, with a bytecode that is one `0x` hex run and an abi that is a
 * list, has nowhere in it for a credential to hide.
 */
const ARTIFACT_KEYS = ['abi', 'bytecode'];
const COMPILED_BYTECODE = /^0x[0-9a-f]+$/i;

/**
 * The one binary a devnet run ever spawns.
 *
 * Docker and this repository's own toolchain are the whole prerequisite, which
 * is exactly why the contracts are replayed with viem. A `forge`, an `anvil`
 * or a `cast` on the host would be a fourth thing to install and a second way
 * for two machines to disagree — anvil runs in the pinned image and nowhere
 * else.
 */
const THE_ONLY_BINARY = 'docker';
const A_SPAWNED_BINARY =
  /(?:execFile|execFileSync|spawn|spawnSync|execSync|exec)\(\s*'([^']+)'/g;

/**
 * The guard itself, which asks git what this bundle commits and is therefore
 * the one file here that spawns something else. Reading the repository is not
 * the devnet running, and a guard that could not read the repository could not
 * guard it.
 */
const THE_GUARD = `${DEVNET_DIR}/bundle.test.ts`;

/**
 * A run of 64 hex characters: what `openssl rand -hex 32` writes, and the
 * shape of every credential this devnet generates. None of them may ever be
 * committed — which is the hub bundle's rule, and the devnet is held to it
 * unchanged. The chain's digest is the one 64-hex run in this bundle, and it
 * is declared above rather than pattern-matched past.
 */
const KEY_MATERIAL = /[0-9a-fA-F]{64}/;

// ── Healthchecks ─────────────────────────────────────────────────────────────

/**
 * Every service healthchecks, and each dials 127.0.0.1 — inside a container
 * "localhost" can resolve to ::1, where an IPv4-bound listener never answers.
 * All five must be PRESENT: the connectors gate their own startup on the
 * chain's and on the app behind them, so a missing one is a node that comes up
 * in the wrong order and fails on something else.
 */
const EXPECTED_HEALTHCHECKS: Record<string, string> = {
  chain: 'cast block-number --rpc-url http://127.0.0.1:8545 || exit 1',
  'hub-connector': `wget -q --spider http://127.0.0.1:${CONNECTOR_EDGE_PORT}/ilp/identity || exit 1`,
  'hub-slot-app': `wget -q --spider http://127.0.0.1:${SLOT_APP_PORT}/health || exit 1`,
  'station-connector': `wget -q --spider http://127.0.0.1:${CONNECTOR_EDGE_PORT}/ilp/identity || exit 1`,
  'station-origin': `wget -q --spider http://127.0.0.1:${SEGMENT_PORT}/health || exit 1`,
};

/**
 * A devnet failure must be VISIBLE. Every service is `no`, unlike the shipped
 * bundles' `unless-stopped`: a container that crash-loops in a run hides its
 * own first error behind twenty later ones, and what a red run owes its reader
 * is the log of what actually happened.
 */
const EXPECTED_RESTART_POLICY = 'no';

// ── Reading the files under test ─────────────────────────────────────────────

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  command?: string | string[];
  ports?: string[];
  expose?: (string | number)[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  volumes?: string[];
  restart?: string;
}

interface DockerCompose {
  name?: string;
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

function servicesOf(relativePath: string): Record<string, ComposeService> {
  return readCompose(relativePath).services ?? {};
}

/**
 * Compose substitutes `${VAR:-default}` from the environment; with nothing set
 * every such substitution becomes its default. A publish hidden behind a
 * variable is still a publish.
 */
function resolveComposeDefaults(entry: string): string {
  return entry.replace(
    /\$\{([^}]+)\}/g,
    (_match, reference: string) => reference.split(':-')[1] ?? ''
  );
}

/** Every `ports:` entry in one file set, with the service that declares it. */
function publishedPorts(
  files: string[]
): { file: string; service: string; entry: string }[] {
  return files.flatMap((file) =>
    Object.entries(servicesOf(file)).flatMap(([service, definition]) =>
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

/**
 * The HOST port of a publish. It is the first number in every form the entry
 * can take — `host:container`, `host-ip:host:container`, or a bare container
 * port, where the host side is whatever the daemon picks and the number here
 * is still the one to compare.
 */
function hostPortOf(entry: string): string {
  return portsNamedBy(entry)[0] ?? '';
}

/** One service's environment, with every `${VAR:-default}` resolved. */
function environmentOf(
  file: string,
  service: string
): Record<string, string> | undefined {
  const declared = servicesOf(file)[service]?.environment;
  if (declared === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(declared).map(([key, value]) => [
      key,
      resolveComposeDefaults(String(value)),
    ])
  );
}

/**
 * A service's command as one string, whichever form it is written in.
 *
 * The chain's is a LIST OF ONE STRING and has to be: the foundry image's
 * entrypoint is `/bin/sh -c`, so a plain string — which compose splits on
 * whitespace — would arrive as `sh -c anvil --host … `, where everything after
 * the first word becomes `$0`, `$1`, … and is silently dropped.
 */
function commandOf(service: ComposeService | undefined): string {
  const command = service?.command;
  if (command === undefined) return '';
  return Array.isArray(command) ? command.join(' ') : command;
}

/** Everything one service DOES, as one string: its command, ports, mounts and environment. */
function whatServiceDoes(service: ComposeService): string {
  return JSON.stringify({
    image: service.image,
    command: commandOf(service),
    ports: service.ports,
    expose: service.expose,
    environment: service.environment,
    volumes: service.volumes,
    healthcheck: service.healthcheck,
  });
}

/**
 * Every file this bundle COMMITS. `git ls-files` rather than a directory walk,
 * because the question is what a public repository carries: every credential
 * the devnet needs is generated into `./run/` beside these files on a machine
 * that has run it, and a walk would read a real key and fail on a clean tree.
 */
function committedDevnetFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', DEVNET_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('devnet bundle', () => {
  // ── One topology ───────────────────────────────────────────────────────────

  it('describes a chain, a hub and a station in one compose project', () => {
    expect(
      readCompose(COMPOSE_PATH).name,
      `${COMPOSE_PATH}: the project name is what a second run tears down and what a stray container is found under`
    ).toBe(PROJECT_NAME);

    const declared = Object.keys(servicesOf(COMPOSE_PATH)).sort();

    expect(
      declared,
      `${COMPOSE_PATH}: expected the services ${JSON.stringify(EXPECTED_SERVICES)} — a chain, a hub connector with its slot app, and a station connector with its origin — found ${JSON.stringify(declared)}`
    ).toEqual([...EXPECTED_SERVICES].sort());
  });

  it('names every service for the node it belongs to', () => {
    // Two connectors are running here. They hold different keys, terminate
    // different prefixes and answer on different host ports, so a service name
    // that does not say which node it belongs to is a log line nobody can
    // place and an `exec` into the wrong box.
    for (const service of Object.keys(servicesOf(COMPOSE_PATH))) {
      expect(
        UNPLACEABLE_SERVICE_NAMES,
        `${COMPOSE_PATH}: declares a service called "${service}" — there are two of everything here, so a name has to say which node it belongs to`
      ).not.toContain(service);

      if (service === CHAIN_SERVICE) continue;
      expect(
        service.startsWith('hub-') || service.startsWith('station-'),
        `${COMPOSE_PATH}: the service "${service}" belongs to neither node by its name`
      ).toBe(true);
    }
  });

  // ── A free door ────────────────────────────────────────────────────────────

  it('never host-publishes the slot app port or the segment port, in any form', () => {
    for (const file of EVERY_COMPOSE_FILE) {
      for (const { service, entry } of publishedPorts([file])) {
        for (const port of [SLOT_APP_PORT, SEGMENT_PORT]) {
          expect(
            portsNamedBy(entry).includes(port),
            `${file} service "${service}": publishes "${entry}", which names :${port}. That is a payment-oblivious surface — a slot and a roster on one, a broadcaster's vibes on the other — so publishing it, even on ${LOOPBACK_PUBLISH_PREFIX}, is a free door. It stays \`expose:\` and nothing else, in a devnet exactly as in a bundle an operator runs.`
          ).toBe(false);
        }
      }
    }
  });

  it('keeps every private surface on `expose:`, so this network can still dial it', () => {
    // The other half of the invariant: a port published nowhere AND exposed
    // nowhere is not private, it is unreachable — the connector cannot dial the
    // app and the vibes cannot reach the ingest.
    for (const [service, ports] of Object.entries(EXPECTED_EXPOSE)) {
      const exposed = (servicesOf(COMPOSE_PATH)[service]?.expose ?? []).map(
        String
      );

      expect(
        exposed,
        `${COMPOSE_PATH} ${service}: expected ${JSON.stringify(ports)} under \`expose:\`, found ${JSON.stringify(exposed)}`
      ).toEqual(ports);
    }
  });

  it('publishes nothing off-box: every publish is loopback-qualified', () => {
    // A hub publishes two doors and a station three. A devnet publishes NONE:
    // there is no public name here, nothing to front and nobody to reach it,
    // and a `ports:` entry with no host IP is internet-reachable even with ufw
    // locked down, because Docker's iptables chain runs ahead of it.
    for (const { file, service, entry } of publishedPorts(EVERY_COMPOSE_FILE)) {
      expect(
        entry.startsWith(LOOPBACK_PUBLISH_PREFIX),
        `${file} service "${service}": publishes "${entry}" with no host IP. Nothing in a devnet is reachable off-box — every publish here exists only so the driver can speak to what it is driving.`
      ).toBe(true);
    }
  });

  it('publishes exactly the three addresses the driver has to reach', () => {
    const published = Object.fromEntries(
      publishedPorts(EVERY_COMPOSE_FILE).map(({ service, entry }) => [
        service,
        entry,
      ])
    );

    expect(
      published,
      `${COMPOSE_PATH}: the published set is the chain's RPC and the two connector edges, all on loopback, and nothing else`
    ).toEqual(EXPECTED_PUBLISHED_PORTS);
  });

  it('gives the two connectors distinct host ports, since they share a machine', () => {
    // This is the concrete reason the devnet could not be assembled out of the
    // two shipped local overlays: both publish 127.0.0.1:3000, each frozen by
    // its own guard. Here both containers still listen on 3000 and the HOST
    // side is what differs.
    const publishes = publishedPorts(EVERY_COMPOSE_FILE);
    const hostPorts = publishes.map(({ entry }) => hostPortOf(entry));

    expect(
      new Set(hostPorts).size,
      `${COMPOSE_PATH}: two services publish the same host port (${JSON.stringify(hostPorts)}) — a devnet runs two connectors on one machine, so no host port may be claimed twice`
    ).toBe(hostPorts.length);

    for (const service of ['hub-connector', 'station-connector']) {
      const entry = EXPECTED_PUBLISHED_PORTS[service] ?? '';
      expect(
        entry.endsWith(`:${CONNECTOR_EDGE_PORT}`),
        `${COMPOSE_PATH} ${service}: both connectors listen on :${CONNECTOR_EDGE_PORT} inside the container — it is the host side that differs`
      ).toBe(true);
    }
  });

  // ── No TLS front ───────────────────────────────────────────────────────────

  it('runs no TLS front and names neither 80 nor 443', () => {
    // There is no certificate in a laptop topology and nothing to terminate, so
    // there is no Caddy here at all — which is what makes "nothing is reachable
    // off-box" achievable rather than merely stated.
    const services = servicesOf(COMPOSE_PATH);

    for (const [service, definition] of Object.entries(services)) {
      for (const entry of [
        ...(definition.ports ?? []),
        ...(definition.expose ?? []).map(String),
      ]) {
        for (const port of TLS_FRONT_PORTS) {
          expect(
            portsNamedBy(resolveComposeDefaults(entry)).includes(port),
            `${COMPOSE_PATH} ${service}: names :${port} in "${entry}" — a devnet terminates no TLS and fronts nothing`
          ).toBe(false);
        }
      }

      expect(
        (definition.image ?? '').includes('caddy'),
        `${COMPOSE_PATH} ${service}: runs a TLS front. There is no public name here to get a certificate for.`
      ).toBe(false);
    }

    // And ingest is plain RTMP, stated as an EMPTY pair rather than left out:
    // compose merges environment maps, the origin refuses to start on a
    // certificate without a key, and an empty value is what it reads as "no
    // ingest TLS".
    const origin = environmentOf(COMPOSE_PATH, 'station-origin') ?? {};
    for (const variable of EXPECTED_EMPTY_INGEST_TLS) {
      expect(
        origin[variable],
        `${COMPOSE_PATH} station-origin: ${variable} must be present and empty — there is no certificate in a laptop topology, and the pair goes together`
      ).toBe('');
    }
  });

  // ── A hub that thinks it is a station ──────────────────────────────────────

  it('keeps RTMP in the station half and nowhere near the hub', () => {
    // A station fronts its own uplink because stock Caddy does not speak RTMP.
    // A hub has no uplink and carries no vibes of its own, and this is the
    // first file in the repository where both halves are written down together
    // — which makes it the first file where one can be pasted into the other.
    const services = servicesOf(COMPOSE_PATH);

    for (const service of HUB_SERVICES) {
      const definition = services[service];
      expect(
        definition,
        `${COMPOSE_PATH}: no service "${service}"`
      ).toBeDefined();

      expect(
        A_STATION_SERVICE.test(service),
        `${COMPOSE_PATH}: the hub half declares "${service}" — a hub ingests nothing and serves no segments`
      ).toBe(false);

      const does = whatServiceDoes(definition ?? {});
      expect(
        does.includes(RTMP_PORT),
        `${COMPOSE_PATH} ${service}: names :${RTMP_PORT}. No RTMP port, service or path belongs in the hub half — a hub is never a station.`
      ).toBe(false);
      expect(
        does,
        `${COMPOSE_PATH} ${service}: names RTMP. A hub has no uplink to front.`
      ).not.toMatch(/rtmps?/i);
    }

    // And the port itself appears in exactly one place: the station origin's
    // `expose:`, where it is the broadcaster's own publish arriving on this
    // network and not a door onto anything.
    const namingIngest = Object.entries(services)
      .filter(([, definition]) =>
        whatServiceDoes(definition).includes(RTMP_PORT)
      )
      .map(([service]) => service);

    expect(
      namingIngest,
      `${COMPOSE_PATH}: :${RTMP_PORT} is named by ${JSON.stringify(namingIngest)} — ingest belongs to the origin and to nothing else`
    ).toEqual(['station-origin']);
  });

  // ── The chain ──────────────────────────────────────────────────────────────

  it('pins the chain by digest', () => {
    const image = servicesOf(COMPOSE_PATH)[CHAIN_SERVICE]?.image;

    expect(
      image,
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: expected the pinned chain image`
    ).toBe(EXPECTED_CHAIN_IMAGE);

    // A tag is a pointer somebody else controls. The digest is what is
    // fetched, so a foundry release cannot change what the devnet's chain
    // means underneath a run that was green yesterday.
    expect(
      image,
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: pin the chain by digest — a tag alone is a moving target`
    ).toMatch(PINNED_BY_DIGEST);
  });

  it('runs the chain on a known id, with funded accounts and no block time', () => {
    const declared = servicesOf(COMPOSE_PATH)[CHAIN_SERVICE]?.command;
    const command = commandOf(servicesOf(COMPOSE_PATH)[CHAIN_SERVICE]);

    // A LIST OF ONE STRING, and it has to be. The foundry image's entrypoint is
    // `/bin/sh -c`, so a plain string — which compose splits on whitespace —
    // arrives as `sh -c anvil --host 0.0.0.0 …`, where everything after `anvil`
    // becomes `$0`, `$1`, … and is SILENTLY DROPPED. anvil would then come up
    // bound to loopback inside the container, reachable by nothing, with none
    // of the flags below in effect — and the failure would look like a
    // networking problem rather than like a quoting one.
    expect(
      Array.isArray(declared) ? declared.length : declared,
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: the command must be a list of ONE string. This image's entrypoint is \`/bin/sh -c\`, so a plain string is split and every flag after the first word is dropped.`
    ).toBe(1);

    // The id and the account count are what make the settlement contracts land
    // at the deterministic addresses the rest of the fleet commits — so a
    // configuration copied from a sibling repo is either right here or loudly
    // wrong, rather than silently pointed at a different chain.
    expect(
      command,
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: must run on chain id ${EXPECTED_CHAIN_ID}`
    ).toContain(`--chain-id ${EXPECTED_CHAIN_ID}`);
    expect(
      command,
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: must fund ${EXPECTED_ACCOUNTS} accounts`
    ).toContain(`--accounts ${EXPECTED_ACCOUNTS}`);

    // No block time: a block per transaction means a transaction waits on
    // ITSELF rather than on a clock, so the run is bounded by the work it does
    // and not by a mining interval.
    expect(
      command.includes(A_BLOCK_TIME),
      `${COMPOSE_PATH} ${CHAIN_SERVICE}: sets ${A_BLOCK_TIME} — the devnet mines per transaction, so nothing in a run ever waits on a clock`
    ).toBe(false);
  });

  // ── The images ─────────────────────────────────────────────────────────────

  it('takes both connectors from the pin of record and names no build itself', () => {
    // `deploy/docker-compose.yml`'s connector `image:` is the pin of record and
    // the only place in this repository a connector build may be named;
    // `deploy/bundle.test.ts` fails on a third site. A required variable with
    // no default is how the devnet runs that same build without owning a copy
    // of it — and it also means `docker compose up` here fails with a message
    // rather than pulling something arbitrary.
    for (const service of ['hub-connector', 'station-connector']) {
      const image = servicesOf(COMPOSE_PATH)[service]?.image ?? '';
      expect(
        image,
        `${COMPOSE_PATH} ${service}: expected \`\${${CONNECTOR_IMAGE_VAR}:?…}\`, found "${image}". The connector pin lives in deploy/docker-compose.yml and a second copy is a copy that drifts.`
      ).toMatch(REQUIRED_VARIABLE);
    }

    for (const file of committedDevnetFiles()) {
      const found = CONNECTOR_BUILD_LITERAL.exec(readFile(file));
      expect(
        found,
        `${file}: names the connector build "${String(found?.[0])}". The pin of record is deploy/docker-compose.yml's and this bundle takes it as a variable — two copies that drift are how an operator deploys one connector while reading about another.`
      ).toBeNull();
    }
  });

  it("builds only this repository's own two apps, and pulls everything else", () => {
    // THE DEVNET INTRODUCES NO NEW PUBLISHED IMAGE. The chain and the connector
    // are already-published images; the slot app and the origin are built from
    // the checkout, exactly as each shipped bundle's own local overlay builds
    // its own app and for the same reason — running your own change is the
    // point.
    const built = Object.entries(servicesOf(COMPOSE_PATH)).filter(
      ([, definition]) => definition.build !== undefined
    );

    expect(
      built.map(([service]) => service).sort(),
      `${COMPOSE_PATH}: expected exactly ${JSON.stringify(Object.keys(EXPECTED_BUILDS))} to be built from this checkout`
    ).toEqual(Object.keys(EXPECTED_BUILDS).sort());

    for (const [service, definition] of built) {
      expect(
        definition.build?.dockerfile,
        `${COMPOSE_PATH} ${service}: builds from ${String(definition.build?.dockerfile)}`
      ).toBe(EXPECTED_BUILDS[service]);
      expect(
        definition.build?.context,
        `${COMPOSE_PATH} ${service}: builds from the wrong context — both Dockerfiles take the repository root`
      ).toBe(EXPECTED_BUILD_CONTEXT);
      expect(
        definition.image,
        `${COMPOSE_PATH} ${service}: declares an \`image:\` as well as a \`build:\` — one of them is what actually runs and a reader cannot tell which`
      ).toBeUndefined();
    }

    for (const service of [
      CHAIN_SERVICE,
      'hub-connector',
      'station-connector',
    ]) {
      expect(
        servicesOf(COMPOSE_PATH)[service]?.build,
        `${COMPOSE_PATH} ${service}: has a \`build:\`. This repository publishes no connector image and no chain image — both are pulled.`
      ).toBeUndefined();
    }
  });

  // ── The generated configuration ────────────────────────────────────────────

  it('boots both connectors from a generated config in the ignored working directory', () => {
    // No file under `deploy/` or `deploy/hub/` is edited or read as the
    // devnet's own configuration: the station bundle's apex is frozen to the
    // `demo` placeholder by its own guard and both bundles publish the same
    // edge port, so a devnet that reached into either would be fighting two
    // guards to prove a third thing.
    for (const [service, mount] of Object.entries(EXPECTED_CONFIG_MOUNTS)) {
      expect(
        servicesOf(COMPOSE_PATH)[service]?.volumes ?? [],
        `${COMPOSE_PATH} ${service}: expected the generated config mounted read-only at ${mount}`
      ).toContain(mount);
    }

    // And every host-side mount comes out of that same ignored directory —
    // there is no committed file in this bundle that a running node reads.
    for (const [service, definition] of Object.entries(
      servicesOf(COMPOSE_PATH)
    )) {
      for (const mount of definition.volumes ?? []) {
        if (!mount.startsWith('.')) continue; // a named volume, not a bind
        expect(
          mount.startsWith(WORK_DIR_MOUNT_PREFIX),
          `${COMPOSE_PATH} ${service}: binds "${mount}" from outside ${WORK_DIR_MOUNT_PREFIX}. Everything a devnet node reads is generated per run, because no credential literal belongs in this repository and the chain decides the addresses.`
        ).toBe(true);
      }
    }

    const rules = readFile(GITIGNORE_PATH)
      .split('\n')
      .map((line) => line.trim());
    for (const pattern of EXPECTED_GITIGNORED) {
      expect(
        rules,
        `${GITIGNORE_PATH}: no \`${pattern}\` rule — the working directory holds every credential a run generates`
      ).toContain(pattern);
    }
  });

  it('mounts every credential read-only, and keeps the seed out of both connectors', () => {
    for (const [service, definition] of Object.entries(
      servicesOf(COMPOSE_PATH)
    )) {
      for (const mount of definition.volumes ?? []) {
        if (!mount.startsWith('.')) continue;
        // A credential a container can rewrite is a credential a compromised
        // container can rotate out from under whoever generated it.
        expect(
          mount.endsWith(':ro'),
          `${COMPOSE_PATH} ${service}: binds "${mount}" writable`
        ).toBe(true);
      }

      if (!service.endsWith('-connector')) continue;
      for (const mount of definition.volumes ?? []) {
        expect(
          mount.includes(NEVER_MOUNTED_INTO_A_CONNECTOR),
          `${COMPOSE_PATH} ${service}: mounts "${mount}". ${NEVER_MOUNTED_INTO_A_CONNECTOR} is the slot app's PRIVATE seed — the credential that mutates a hub's routing table — and it belongs in the slot app and nowhere else. A connector gets operator-write.keys, the allowlist of PUBLIC halves.`
        ).toBe(false);
      }
    }
  });

  it('names every credential by path and never by value', () => {
    // There is no variable carrying a credential literal anywhere in this
    // repository, and a devnet is not the exception: an image's environment is
    // readable from its metadata without ever running it.
    for (const file of EVERY_COMPOSE_FILE) {
      for (const service of Object.keys(servicesOf(file))) {
        const keys = Object.keys(environmentOf(file, service) ?? {});
        for (const forbidden of FORBIDDEN_LITERAL_CREDENTIAL_VARS) {
          expect(
            keys,
            `${file} ${service}: sets ${forbidden} to a literal — name the FILE instead`
          ).not.toContain(forbidden);
        }
      }
    }
  });

  it('commits no key material', () => {
    // The hub bundle's rule, unchanged: every credential a devnet generates is
    // `openssl rand -hex 32` — 64 hex characters — and none of them may be
    // committed, in a compose file, in a template or in a README.
    //
    // The chain's DIGEST is 64 hex characters too, and it is the one run this
    // bundle is allowed to carry. It is declared as a literal above and
    // stripped here by that literal rather than by a pattern, so a SECOND
    // 64-hex run cannot arrive disguised as a digest.
    for (const file of committedDevnetFiles()) {
      // The trimmed artifacts are compiled bytecode — hex from end to end, and
      // by definition full of 64-hex runs. They are skipped BECAUSE the check
      // above proves what they are: an object of exactly `{ abi, bytecode }`,
      // whose bytecode is one hex run, has nowhere in it for a credential to
      // hide. Skipping them without that check would be a hole.
      if (file.startsWith(`${CONTRACTS_DIR}/`) && file.endsWith('.json')) {
        continue;
      }

      const withoutTheDigest = readFile(file)
        .split(EXPECTED_CHAIN_IMAGE)
        .join('');
      const found = KEY_MATERIAL.exec(withoutTheDigest);
      expect(
        found,
        `${file}: contains a 64-hex run ("${String(found?.[0]).slice(0, 8)}…") — that is the shape of every credential a devnet run generates, and none of them is committable. They are generated into ./run/, which git ignores.`
      ).toBeNull();
    }
  });

  // ── The settlement contracts ───────────────────────────────────────────────

  it('vendors the settlement contracts as trimmed artifacts, and nothing else', () => {
    // `{ abi, bytecode }` only — the `metadata`, `ast` and `deployedBytecode`
    // sections of a forge artifact are dropped. The trimming is what lets the
    // key-material check below skip these files honestly: an object of exactly
    // these two keys has nowhere in it for a credential to hide.
    const vendored = committedDevnetFiles()
      .filter((file) => file.startsWith(`${CONTRACTS_DIR}/`))
      .filter((file) => file.endsWith('.json'));

    expect(
      vendored
        .map((file) => file.split('/').pop()?.replace('.json', ''))
        .sort(),
      `${CONTRACTS_DIR}: expected the artifacts ${JSON.stringify(EXPECTED_ARTIFACTS)} — the mock token the devnet settles in, and the registry every connector resolves its token network through`
    ).toEqual([...EXPECTED_ARTIFACTS].sort());

    for (const file of vendored) {
      const artifact = JSON.parse(readFile(file)) as Record<string, unknown>;

      expect(
        Object.keys(artifact).sort(),
        `${file}: carries ${JSON.stringify(Object.keys(artifact))}. A trimmed artifact is exactly ${JSON.stringify(ARTIFACT_KEYS)}, and everything else a forge build writes is dropped.`
      ).toEqual([...ARTIFACT_KEYS].sort());

      expect(
        Array.isArray(artifact['abi']),
        `${file}: its abi is not a list`
      ).toBe(true);
      expect(
        String(artifact['bytecode']),
        `${file}: its bytecode is not one hex run — which is what makes this file's exemption from the key-material check safe`
      ).toMatch(COMPILED_BYTECODE);
    }
  });

  it('spawns nothing but Docker, so a run needs no Foundry, Rust or submodules', () => {
    // The prerequisite for a devnet run is Docker and this repository's own
    // toolchain, and that is a claim about what the driver EXECUTES. anvil runs
    // in the pinned image; the contracts are replayed with viem from the
    // artifacts above; nothing here shells out to a toolchain a reader would
    // have to install first.
    for (const file of committedDevnetFiles()) {
      if (!file.endsWith('.ts')) continue;
      if (file === THE_GUARD) continue;

      for (const [, binary] of readFile(file).matchAll(A_SPAWNED_BINARY)) {
        expect(
          binary,
          `${file}: spawns "${String(binary)}". The only binary a devnet run may execute is ${THE_ONLY_BINARY} — a forge, an anvil or a cast on the host is a fourth thing to install and a second way for two machines to disagree.`
        ).toBe(THE_ONLY_BINARY);
      }
    }
  });

  // ── Healthchecks and restart ───────────────────────────────────────────────

  it('healthchecks every service, and dials 127.0.0.1 rather than localhost', () => {
    const services = servicesOf(COMPOSE_PATH);

    for (const [service, command] of Object.entries(EXPECTED_HEALTHCHECKS)) {
      expect(
        services[service]?.healthcheck?.test,
        `${COMPOSE_PATH} ${service}: expected the healthcheck \`${command}\``
      ).toEqual(['CMD-SHELL', command]);
    }

    for (const [service, definition] of Object.entries(services)) {
      const test = (definition.healthcheck?.test ?? []).join(' ');
      expect(
        test.includes('localhost'),
        `${COMPOSE_PATH} ${service}: healthcheck dials localhost ("${test}") — inside a container that can resolve to ::1, where an IPv4-bound listener never answers`
      ).toBe(false);
    }
  });

  it('restarts nothing, so a failure is the first error and not the twentieth', () => {
    for (const [service, definition] of Object.entries(
      servicesOf(COMPOSE_PATH)
    )) {
      expect(
        definition.restart,
        `${COMPOSE_PATH} ${service}: expected \`restart: "${EXPECTED_RESTART_POLICY}"\`. The shipped bundles restart because a live box should heal itself; a devnet must not, because what a red run owes its reader is the log of what actually happened.`
      ).toBe(EXPECTED_RESTART_POLICY);
    }
  });
});
