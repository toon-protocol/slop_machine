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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createWriteSigner } from '../../packages/slot-app/src/operator/write-signature.js';

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

/**
 * Every file a run generates, as the compose file names it: `run/`-relative,
 * forward-slashed, in no particular order.
 *
 * This is the manifest half of the pair above. It is exported rather than
 * inferred so that the guard can compare two lists rather than trust one.
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
}

/** The station's credentials, which include the one thing only a station has. */
export interface StationCredentials extends NodeCredentials {
  /**
   * The broadcaster's stream key, checked on the RTMP publish before a byte is
   * transcoded. A location and never a value: the origin reads it from a
   * mounted file, and a run pushes vibes with it.
   */
  streamKey: string;
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
 * Generate everything, from nothing.
 *
 * The working directory is REMOVED first. A run inherits nothing: a stale
 * `connector.toml` names contracts from a chain that no longer exists, and a
 * stale allowlist authorises a seed the slot app is no longer mounting — both
 * of which fail late and read like something else.
 */
export function generateCredentials(): DevnetCredentials {
  rmSync(WORK_DIR, { recursive: true, force: true });
  for (const directory of [WORK_DIR, HUB_DIR, STATION_DIR]) {
    // 0755, so the two container users can traverse to the files inside.
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  }

  const hubSettlement = settlementKeyPair();
  const stationSettlement = settlementKeyPair();

  const hub: HubCredentials = {
    signerKey: randomHex32(),
    settlementKey: hubSettlement.key,
    settlementAddress: hubSettlement.address,
    bearerToken: randomHex32(),
    operatorWriteKey: randomHex32(),
    operatorKeyid: '',
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
    streamKey: randomHex32(),
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

  write(resolve(STATION_DIR, 'signer.key'), station.signerKey);
  write(resolve(STATION_DIR, 'settlement.key'), station.settlementKey);
  write(resolve(STATION_DIR, 'operator-bearer.token'), station.bearerToken);
  // A station's own allowlist. Nothing in a run signs a write against this
  // node — the hub writes to its OWN table — but an `[operator]` section
  // naming a file that is missing or empty is a refuse-to-start, and the read
  // half of this surface is how a run asks the broadcaster's own connector
  // what it holds.
  write(
    resolve(STATION_DIR, 'operator-write.keys'),
    createWriteSigner(randomHex32()).keyid
  );
  write(resolve(STATION_DIR, 'stream.key'), station.streamKey);

  return { hub, station };
}

/** Where a rendered `connector.toml` goes, for the two nodes that read one. */
export const HUB_CONNECTOR_TOML = resolve(HUB_DIR, 'connector.toml');
export const STATION_CONNECTOR_TOML = resolve(STATION_DIR, 'connector.toml');
