/**
 * The hub's two operator credentials: the only secrets the slot app holds.
 *
 * A hub operator's connector keeps its operator surface behind two different
 * gates, and the slot app needs both:
 *
 *   - the **operator write key**, an ed25519 seed whose public half sits on
 *     the connector's `write_keys` allowlist. Every write the app makes is
 *     signature-gated with it, which is what makes an operator write
 *     attributable to the app rather than to the operator's own hand.
 *   - the **operator bearer token**, which gates the reads the app needs to
 *     see what the connector's routing table currently holds.
 *
 * **Both arrive as mounted files, named by path.** There is deliberately no
 * flag and no environment variable carrying either literal: a command line is
 * world-readable on the box (`ps` is enough), and an environment variable is
 * readable from a container's own metadata by anyone who can inspect it. A
 * path is not a secret; the file it names is.
 *
 * **The app refuses to start without either**, and the refusal says which one.
 * A hub that cannot admit anybody must look broken rather than look fine: an
 * app that came up holding no write key would answer liveness, pass every
 * supervisor check, and then fail the first broadcaster who paid for a slot.
 *
 * Neither value is ever logged, echoed, put in an error message, or reported
 * back on `SlotAppInstance.config`. The path is safe to name — and is named,
 * because an operator fixing a bad mount needs to know which file — while the
 * contents never leave this module's return value.
 *
 * On the shape of the files: both are what `deploy/connector.toml`'s own
 * provisioning comments tell a hub operator to generate, `openssl rand -hex 32`
 * into `operator-write.key` and `operator-bearer.token`. So both are read as
 * text and trimmed, exactly as the station origin reads its stream key —
 * a mounted credential is usually written by a human with an editor or an
 * `echo`, and the trailing newline is not part of it. Nothing here decodes the
 * write key or checks its length: what a seed becomes at signing time belongs
 * to the code that signs, not to the code that mounts.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

/**
 * An operator credential that could not be resolved.
 *
 * Named so the boot failure reads as the operator's mistake — an unset path or
 * a bad mount — rather than surfacing as a stack trace, and so the CLI can
 * tell it apart from a crash. Its message always names **which** credential
 * and, where there is one, the path it was looking at. It never carries a
 * credential's contents.
 */
export class OperatorCredentialError extends Error {
  override readonly name = 'OperatorCredentialError';
}

/** Where the slot app's operator credentials are mounted. Both are required. */
export interface OperatorCredentialSource {
  /**
   * Path to the mounted file holding the operator **write key** — the ed25519
   * seed the app signs operator writes with (env:
   * `TOON_OPERATOR_WRITE_KEY_FILE`).
   */
  operatorWriteKeyFile?: string | undefined;
  /**
   * Path to the mounted file holding the operator **bearer token** — what
   * gates the reads the app makes against the operator surface (env:
   * `TOON_OPERATOR_BEARER_TOKEN_FILE`).
   */
  operatorBearerTokenFile?: string | undefined;
}

/**
 * The two credentials, resolved, each beside the path it came from.
 *
 * The two **values** are held by the running app and by nothing else: this
 * object is never part of `SlotAppInstance.config`, never logged, and never
 * serialized. The two **paths** are ordinary configuration and are reported
 * back — an operator fixing a bad mount needs to know which file was read.
 */
export interface OperatorCredentials {
  /** The operator write key, as it was written in its mounted file. */
  writeKey: string;
  /** The path that key was read from. Safe to log; the key is not. */
  writeKeyFile: string;
  /** The operator bearer token, as it was written in its mounted file. */
  bearerToken: string;
  /** The path that token was read from. Safe to log; the token is not. */
  bearerTokenFile: string;
}

/**
 * Which credential a refusal is about. Used only to build the message, so that
 * an operator with two mounts to check is told which of them is wrong.
 */
interface CredentialKind {
  /** How the credential is described in prose. */
  what: string;
  /** The environment variable naming its file. */
  env: string;
  /** The flag naming its file. */
  flag: string;
}

const WRITE_KEY: CredentialKind = {
  what: 'operator write key',
  env: 'TOON_OPERATOR_WRITE_KEY_FILE',
  flag: '--operator-write-key-file',
};

const BEARER_TOKEN: CredentialKind = {
  what: 'operator bearer token',
  env: 'TOON_OPERATOR_BEARER_TOKEN_FILE',
  flag: '--operator-bearer-token-file',
};

/**
 * Resolve both operator credentials from the files they are mounted at, or
 * throw naming the one that is wrong.
 *
 * @throws OperatorCredentialError if either path is unset, or the file it
 * names is unreadable or empty. The message names the credential, the flag and
 * environment variable that set it, and the path it read — never the contents.
 */
export function resolveOperatorCredentials(
  source: OperatorCredentialSource
): OperatorCredentials {
  // The write key first: it is the credential that mutates a hub's routing
  // table, and it is the one CLAUDE.md names as this repo's own hazard.
  const writeKey = readCredential(source.operatorWriteKeyFile, WRITE_KEY);
  const bearerToken = readCredential(
    source.operatorBearerTokenFile,
    BEARER_TOKEN
  );

  return {
    writeKey: writeKey.credential,
    writeKeyFile: writeKey.path,
    bearerToken: bearerToken.credential,
    bearerTokenFile: bearerToken.path,
  };
}

/** One credential and the path it was read from, or a refusal naming both. */
function readCredential(
  path: string | undefined,
  kind: CredentialKind
): { credential: string; path: string } {
  if (path === undefined || path === '') {
    throw new OperatorCredentialError(
      `no ${kind.what} configured; mount the file and set ${kind.env} (or ${kind.flag}). There is no default and no literal form — a hub that cannot admit anybody must look broken rather than look fine`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // The path is safe to name; the contents are not, and are never logged.
    throw new OperatorCredentialError(
      `could not read the ${kind.what} file at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const credential = raw.trim();
  if (credential === '') {
    throw new OperatorCredentialError(
      `the ${kind.what} file at ${path} is empty`
    );
  }
  return { credential, path };
}
