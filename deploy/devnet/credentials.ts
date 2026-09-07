/**
 * Every credential a devnet run needs, generated into a directory git ignores.
 *
 * NO CREDENTIAL LITERAL ENTERS THIS REPOSITORY — not a connector's signer key,
 * not a settlement key, not a bearer token, not the operator write seed, not
 * the station's stream key, and not anvil's own well-known keys either. The
 * chain's default mnemonic reaches a run by being derived in `chain.ts` from
 * the string anvil prints on every start; everything here is fresh random
 * material per run. A key that is committed once is a key that is grep-able
 * for ever, and a well-known one is exactly the literal that teaches a reader
 * the rule has exceptions.
 *
 * ## Two things this module does not do
 *
 * It does not decide what a key is FOR — the templates and the compose file
 * name the paths, and the two are held to each other by `bundle.test.ts`. And
 * it does not derive the operator write key's public half by shelling into
 * another repo's binary to learn a keyid: it calls the slot app's own
 * {@link createWriteSigner}, which is the same ed25519 handling the app signs
 * with, so an allowlist a run writes is the allowlist that app's signatures
 * are actually verified against.
 *
 * ## Why everything is world-readable
 *
 * A bind-mounted file keeps its HOST ownership inside a container, and these
 * are read by two images that run as two different unprivileged users — the
 * connector as uid 10001, the apps as uid 1000. A 0600 file owned by whoever
 * ran the suite is unreadable to both, and the failure is a container
 * restart-looping on "Permission denied" three layers away from here. On a
 * real box a `chown` is the fix; in a throwaway directory holding a
 * throwaway chain's play money, 0644 is.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createWriteSigner } from '../../packages/slot-app/src/operator/write-signature.js';
import { hubAnonrc } from './anon.js';

/**
 * The ignored working directory, and the two node directories under it. The
 * compose file binds every one of these paths; `bundle.test.ts` holds the two
 * lists to each other, so a mount with no generator — which docker silently
 * creates as a DIRECTORY, and the node then fails to read as a file — cannot
 * ship.
 */
export const WORK_DIR = resolve(import.meta.dirname, 'run');
const HUB_DIR = resolve(WORK_DIR, 'hub');
const STATION_DIR = resolve(WORK_DIR, 'station');
const HUB_ANON_DIR = resolve(WORK_DIR, 'hub-anon');

/**
 * The hub daemon's two `HiddenServiceDir`s — the paths under `run/` that
 * SURVIVE a fresh run, because a `.anyone` address lives in each and an
 * unpersisted one is a new address every start with every viewer's command
 * (and every guide reader's bookmark) going stale silently. They are also
 * paths the driver cannot delete: the anon image's entrypoint chowns them to
 * its own unprivileged user, so they are kept in place rather than kept by
 * copying. The first is the hub's paid edge; the second is the guide's page.
 */
export const HS_DIR = resolve(HUB_ANON_DIR, 'hs');
export const GUIDE_HS_DIR = resolve(HUB_ANON_DIR, 'guide-hs');

/**
 * Every file a run generates FOR A CONTAINER TO MOUNT, as the compose file
 * names it: `run/`-relative, forward-slashed, in no particular order.
 *
 * This is the manifest half of the pair above. It is exported rather than
 * inferred so that the guard can compare two lists rather than trust one.
 * The two files a run generates and mounts NOWHERE are the list below this
 * one, and the guard holds that boundary too.
 */
export const GENERATED_FILES = [
  'hub/connector.toml',
  'hub/signer.key',
  'hub/settlement.key',
  'hub/operator-bearer.token',
  'hub/operator-write.keys',
  'hub/operator-signing.key',
  'station/connector.toml',
  'station/signer.key',
  'station/settlement.key',
  'station/operator-bearer.token',
  'station/operator-write.keys',
  'station/stream.key',
  // The hub daemon's configuration for `--anyone` runs — not a credential,
  // and generated on every run regardless so that this manifest stays the
  // whole truth about what the compose file may mount. The service that
  // mounts it sits behind the `anyone` profile and starts only when a run
  // asks for it.
  'hub-anon/anonrc',
] as const;

/**
 * The files a run generates that NO SERVICE MOUNTS, and each for its own
 * reason:
 *
 * - `hub/relay-nostr.key` is the relay's Nostr identity, and the relay image
 *   takes it as an ENVIRONMENT value with no file-valued form — the hub
 *   bundle's one `.env` secret, for the same reason. The driver reads this
 *   file and passes it in when it brings the project up; a mount would be a
 *   path the image never looks at.
 * - `station/nostr.key` is the BROADCASTER'S OWN announcement keypair — the
 *   per-broadcaster key ADR 0004's four events are signed with. Like the
 *   broadcaster's operator write seed it lives with the broadcaster, who here
 *   is the driver: the driver signs announcements from it, and mounting it
 *   into any node would hand a broadcaster's public voice to a box that must
 *   never speak for them.
 */
export const DRIVER_HELD_FILES = [
  'hub/relay-nostr.key',
  'station/nostr.key',
] as const;

/** What `openssl rand -hex 32` writes, which is the shape of every credential here. */
function randomHex32(): string {
  return randomBytes(32).toString('hex');
}

/** One generated file, world-readable, with the trailing newline a mounted credential has. */
function write(path: string, contents: string): void {
  writeFileSync(path, `${contents}\n`, { mode: 0o644 });
}

/** One node's generated credentials, and what the driver has to know about them. */
export interface NodeCredentials {
  /** The connector's own ILP signing identity. Holds no money; fresh per run. */
  signerKey: string;
  /**
   * The settlement key — the identity channels are opened against, and on the
   * hub the working capital every peering is funded from. The driver funds
   * this address on chain with gas and mints it the token it will front.
   */
  settlementKey: string;
  /** That key's address, which is what the node publishes as its settlement address. */
  settlementAddress: Address;
  /** The bearer token that gates this node's operator-surface READS. */
  bearerToken: string;
}

/** The hub's credentials, which include the one seed the slot app signs writes with. */
export interface HubCredentials extends NodeCredentials {
  /**
   * The slot app's PRIVATE ed25519 seed, mounted into the app and into
   * nothing else. Its public half is the only line in the connector's
   * allowlist.
   */
  operatorWriteKey: string;
  /**
   * That seed's public half, derived here with the slot app's own ed25519
   * handling — the value on the connector's `write_keys` allowlist, and the
   * `keyid` every signature the app makes names.
   */
  operatorKeyid: string;
  /**
   * The relay's own Nostr identity — not money, and not the broadcaster's
   * announcement key. The relay image takes it as an environment value and
   * offers no file-valued form, so the driver reads the generated file back
   * and passes it in when it brings the project up.
   */
  relayNostrKey: string;
}

/** The station's credentials, which include the one thing only a station has. */
export interface StationCredentials extends NodeCredentials {
  /**
   * The BROADCASTER'S OWN operator write seed, and it lives nowhere on the
   * station.
   *
   * `deploy/connector.toml` says this out loud: on a station the private half
   * "does not live on this box at all — you keep it wherever you sign from".
   * The station's connector holds only the ALLOWLIST of public halves. Here
   * the driver is the broadcaster, so it keeps the seed in memory and signs
   * from there — which is how a run redeems what its station was paid.
   */
  operatorWriteKey: string;
  /**
   * The broadcaster's stream key, checked on the RTMP publish before a byte is
   * transcoded. A location and never a value: the origin reads it from a
   * mounted file, and a run pushes vibes with it.
   */
  streamKey: string;
  /**
   * The broadcaster's OWN Nostr keypair seed — the per-broadcaster key every
   * announcement event is signed with (ADR 0004). It is the broadcaster's
   * public voice, distinct from every key the money touches, and like the
   * operator write seed above it lives with the broadcaster: the driver signs
   * announcements from it, and it is mounted into nothing.
   */
  nostrSecretKey: string;
}

/** Everything a run generated, for the two nodes it is about to boot. */
export interface DevnetCredentials {
  hub: HubCredentials;
  station: StationCredentials;
}

function settlementKeyPair(): { key: string; address: Address } {
  const key = randomHex32();
  return { key, address: privateKeyToAccount(`0x${key}` as Hex).address };
}

/**
 * Empty the working directory — with ONE exception, kept in place.
 *
 * `run/hub-anon/hs/` is the hub daemon's `HiddenServiceDir`: the `.anyone`
 * address and the private key behind it. Removing it would rotate the
 * address on every run and silently invalidate every viewer's command — and
 * the driver could not remove it anyway, because the anon image's entrypoint
 * chowns it to the container's own unprivileged user, so an unconditional
 * `rmSync` here would make every LATER run fail on EACCES three layers from
 * the reason. So everything else goes, and that directory stays exactly
 * where it is, whichever mode the run is in.
 */
function clearWorkDir(): void {
  if (!existsSync(WORK_DIR)) return;
  for (const entry of readdirSync(WORK_DIR)) {
    if (entry === 'hub-anon') continue;
    rmSync(resolve(WORK_DIR, entry), { recursive: true, force: true });
  }
  if (!existsSync(HUB_ANON_DIR)) return;
  for (const entry of readdirSync(HUB_ANON_DIR)) {
    if (entry === 'hs' || entry === 'guide-hs') continue;
    rmSync(resolve(HUB_ANON_DIR, entry), { recursive: true, force: true });
  }
}

/**
 * Generate everything, from nothing.
 *
 * The working directory is REMOVED first (the hidden-service directory
 * excepted — see {@link clearWorkDir}). A run inherits nothing: a stale
 * `connector.toml` names contracts from a chain that no longer exists, and a
 * stale allowlist authorises a seed the slot app is no longer mounting — both
 * of which fail late and read like something else.
 */
export function generateCredentials(): DevnetCredentials {
  clearWorkDir();
  for (const directory of [WORK_DIR, HUB_DIR, STATION_DIR, HUB_ANON_DIR]) {
    // 0755, so the two container users can traverse to the files inside.
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  }
  // The daemon's two HiddenServiceDirs, pre-created so a first `--anyone` run
  // does not leave their creation to the docker daemon; the image's entrypoint
  // takes ownership and tightens each to 0700 at container start.
  mkdirSync(HS_DIR, { recursive: true, mode: 0o755 });
  mkdirSync(GUIDE_HS_DIR, { recursive: true, mode: 0o755 });

  const hubSettlement = settlementKeyPair();
  const stationSettlement = settlementKeyPair();

  const hub: HubCredentials = {
    signerKey: randomHex32(),
    settlementKey: hubSettlement.key,
    settlementAddress: hubSettlement.address,
    bearerToken: randomHex32(),
    operatorWriteKey: randomHex32(),
    operatorKeyid: '',
    relayNostrKey: randomHex32(),
  };
  // The app's own signer, so that what a run puts on the allowlist is what the
  // app's signatures are verified against — rather than a keyid learned some
  // other way and hoped to be the same one.
  hub.operatorKeyid = createWriteSigner(hub.operatorWriteKey).keyid;

  const station: StationCredentials = {
    signerKey: randomHex32(),
    settlementKey: stationSettlement.key,
    settlementAddress: stationSettlement.address,
    bearerToken: randomHex32(),
    operatorWriteKey: randomHex32(),
    streamKey: randomHex32(),
    nostrSecretKey: randomHex32(),
  };

  write(resolve(HUB_DIR, 'signer.key'), hub.signerKey);
  write(resolve(HUB_DIR, 'settlement.key'), hub.settlementKey);
  write(resolve(HUB_DIR, 'operator-bearer.token'), hub.bearerToken);
  write(resolve(HUB_DIR, 'operator-signing.key'), hub.operatorWriteKey);
  // The ALLOWLIST: public halves, one keyid per line. This is the file a hub
  // operator hand-edits to revoke the app's authority, and the reason the seed
  // beside it is called `operator-signing.key` rather than a name one
  // character from this one.
  write(resolve(HUB_DIR, 'operator-write.keys'), hub.operatorKeyid);
  // The relay's Nostr identity. Generated like everything else and mounted by
  // nothing: the relay image takes it as an environment value with no
  // file-valued form, so the driver reads this back and passes it in.
  write(resolve(HUB_DIR, 'relay-nostr.key'), hub.relayNostrKey);

  write(resolve(STATION_DIR, 'signer.key'), station.signerKey);
  write(resolve(STATION_DIR, 'settlement.key'), station.settlementKey);
  write(resolve(STATION_DIR, 'operator-bearer.token'), station.bearerToken);
  // A station's own allowlist — public halves, and the seed that matches it is
  // the broadcaster's, held above rather than mounted anywhere. The HUB never
  // writes here; it writes to its own table. What a run signs against this
  // node is the one write a broadcaster makes for themselves: redeeming what
  // their station was paid.
  write(
    resolve(STATION_DIR, 'operator-write.keys'),
    createWriteSigner(station.operatorWriteKey).keyid
  );
  write(resolve(STATION_DIR, 'stream.key'), station.streamKey);
  // The hub daemon's anonrc — configuration, not a credential, and the text
  // lives in anon.ts beside the fixed addresses it targets. Written on every
  // run so the manifest above stays unconditional; only an `--anyone` run
  // starts the service that mounts it.
  write(resolve(HUB_ANON_DIR, 'anonrc'), hubAnonrc().trimEnd());
  // The broadcaster's announcement keypair seed, beside their other
  // credentials and mounted into nothing — the driver is the broadcaster here,
  // and signs every announcement event from it (ADR 0004).
  write(resolve(STATION_DIR, 'nostr.key'), station.nostrSecretKey);

  return { hub, station };
}

/** Where a rendered `connector.toml` goes, for the two nodes that read one. */
export const HUB_CONNECTOR_TOML = resolve(HUB_DIR, 'connector.toml');
export const STATION_CONNECTOR_TOML = resolve(STATION_DIR, 'connector.toml');

/**
 * Where the relay's generated Nostr identity lands. `compose.ts` reads this
 * back to pass the value in as environment, because that image offers no
 * file-valued form — see {@link DRIVER_HELD_FILES}.
 */
export const RELAY_NOSTR_KEY_FILE = resolve(HUB_DIR, 'relay-nostr.key');
