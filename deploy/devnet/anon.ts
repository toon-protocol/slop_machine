/**
 * The Anyone-network half of `pnpm demo --anyone`: the fixed addresses the
 * hidden service targets, and the two `anonrc` files a run generates.
 *
 * This module holds CONSTANTS AND TEXT and nothing else — no file is written
 * and no process is started from here. `credentials.ts` writes the hub
 * daemon's `anonrc` beside every other generated file, `viewer.ts` writes its
 * own, and `compose.ts` remains the one module that spawns anything.
 *
 * ## Why the addresses are fixed
 *
 * `anon` resolves a `HiddenServicePort` target when it PARSES its config, not
 * when a stream arrives — a compose service name here aborts the daemon
 * before it runs, because the container it names does not exist yet and
 * cannot: the hub's config names an address only this daemon can generate, so
 * the daemon must start first. The fixed IP is what breaks that circle.
 * `docker-compose.yml` pins the three services to these addresses, and
 * `bundle.test.ts` holds the two files to each other the way the
 * mounts-vs-manifest check holds the compose file to the generator.
 *
 * The subnet is RFC1918 on purpose, and from 10/8 rather than docker's own
 * default pools (172.17–172.31, and chunks of 192.168/16): the daemon's
 * `SocksPolicy` accepts private ranges only, and the host's own payers arrive
 * through the loopback publish with the network's gateway as their source
 * address — a subnet outside RFC1918 would have the policy refusing the very
 * payers the publish exists for.
 */

/** The devnet network's subnet, pinned so the addresses below can exist. */
export const DEVNET_SUBNET = '10.213.0.0/16';

/** The hub's client edge — what `HiddenServicePort 80` forwards to. */
export const HUB_CONNECTOR_IPV4 = '10.213.0.10';

/** The chain's RPC — what `HiddenServicePort 8545` forwards to. */
export const CHAIN_IPV4 = '10.213.0.20';

/** The daemon itself. Pinned only so the topology is the same every run. */
export const HUB_ANON_IPV4 = '10.213.0.30';

/** The compose profile that keeps `hub-anon` out of every non-anyone `up`. */
export const ANYONE_PROFILE = 'anyone';

/**
 * A v3 hidden-service address as anon v0.4.10.2 writes one: 56 characters of
 * the base32 alphabet and the `.anyone` TLD. An address ending `.onion` is
 * the OLDER daemon — a wrong build, not a wrong config — and the driver says
 * so by name.
 */
export const HS_HOSTNAME_PATTERN = /^[a-z2-7]{56}\.anyone$/;

/** Where the SOCKS side answers, inside either daemon's container. */
export const ANON_SOCKS_PORT = 9050;

/**
 * The policy both anonrc files share: only a private-range or loopback source
 * may use the SOCKS port. The port is published on loopback only, so this is
 * the belt to that braces — a host payer arrives as the docker network's
 * gateway, which every one of these ranges covers.
 */
const SOCKS_POLICY = [
  'SocksPolicy accept 10.0.0.0/8',
  'SocksPolicy accept 172.16.0.0/12',
  'SocksPolicy accept 192.168.0.0/16',
  'SocksPolicy accept 127.0.0.0/8',
  'SocksPolicy reject *',
].join('\n');

/**
 * The hub daemon's configuration: ONE daemon doing both jobs — hosting the
 * hidden service and serving SOCKS to the host's own payers.
 *
 * The connector repository's `local/anyone` rehearsal splits these across two
 * daemons, and deliberately: it exists to prove network isolation, so the
 * payer's way onto the network must be structurally unable to be the service's.
 * Nothing here is proving that — the demo's payers and its hub share a laptop
 * — so one daemon carries both, which is one bootstrap to wait for instead of
 * two.
 *
 * `AgreeToTerms 1` or the daemon exits before saying anything; the explicit
 * `Nickname` cannot be dropped, because the image's entrypoint appends one
 * when it finds none and the file is mounted read-only. `HiddenServiceDir` is
 * the BIND-MOUNTED path — `run/hub-anon/hs` on the host — so the address
 * survives `down --volumes` and a broadcaster's viewers are not told a new
 * one every run.
 */
export function hubAnonrc(): string {
  return `##====== /etc/anon/anonrc — the devnet hub's hidden service (GENERATED) =====##
# Written per run by credentials.ts; deploy/devnet/anon.ts is the source.
# The HiddenServicePort targets are the FIXED addresses docker-compose.yml
# pins, because anon resolves them at config-parse time — see anon.ts.

AgreeToTerms 1

User anond
DataDirectory /var/lib/anon
Nickname slopmachinehubanon

ClientOnly 1
ORPort 0
DirPort 0
ControlSocket 0

# The SOCKS side, for the HOST's own payers — the broadcaster and the demo's
# viber dial the hub's .anyone address through this, published on loopback.
SocksPort 0.0.0.0:${String(ANON_SOCKS_PORT)}
${SOCKS_POLICY}

# The address, and where it lives. This path is the bind mount of
# ./run/hub-anon/hs — persisted across runs on purpose, because an unpersisted
# HiddenServiceDir is a new address on every start and every viewer's command
# goes stale silently.
HiddenServiceDir /var/lib/anon/hidden_service

# One hidden service fronting BOTH of the surfaces a remote payer needs: the
# hub's client edge on the address's port 80, and the chain's RPC on 8545 —
# a viewer's client reads chain state and settles through the same circuit it
# pays over, so its settlement address is never broadcast from its own IP.
HiddenServicePort 80 ${HUB_CONNECTOR_IPV4}:3000
HiddenServicePort 8545 ${CHAIN_IPV4}:8545

Log notice stdout
Log notice file /var/lib/anon/notice.log
`;
}

/**
 * A viewer's configuration: a SOCKS proxy and nothing else. It publishes no
 * service and opens no ORPort — it is the viewer's way onto the network, and
 * the only route their payer has to the hub.
 */
export function viewerAnonrc(): string {
  return `##====== anonrc — a remote viewer's way onto the network (GENERATED) ======##
# Written per run by viewer.ts; deploy/devnet/anon.ts is the source.

AgreeToTerms 1

User anond
DataDirectory /var/lib/anon
Nickname slopmachineviewer

ClientOnly 1
ORPort 0
DirPort 0
ControlSocket 0

SocksPort 0.0.0.0:${String(ANON_SOCKS_PORT)}
${SOCKS_POLICY}

Log notice stdout
Log notice file /var/lib/anon/notice.log
`;
}
