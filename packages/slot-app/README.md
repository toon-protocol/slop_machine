# @toon-protocol/slot-app

The **slot app**: a hub's admission desk. A broadcaster buys a **slot** with a paid request, and the
hub's operator key creates the **peering** and writes the routes that make their station reachable
at its address. Slot and peering are two words for two things
([ADR 0003](../../docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)) and no type,
field or log line here calls one by the other's name.

**It contains no payment code** — no claim validation, no settlement key, no payment-header parsing,
no pricing logic. By the time a request reaches the app, the connector in front of it has already
proven the request paid. Pricing a route is connector configuration. See the repo's
[`CLAUDE.md`](../../CLAUDE.md) for why that split is the whole design.

## What exists today

Issue [#33](https://github.com/toon-protocol/slop_machine/issues/33) is the boot, and only the boot:
the app comes up from its bundled entrypoint on a configured port, holds the hub's two operator
credentials, and answers liveness from inside the node.

| Surface       | Port            | Paid | What it is                                     |
| ------------- | --------------- | ---- | ---------------------------------------------- |
| `GET /health` | `TOON_SLOT_PORT` | no  | Liveness, for a supervisor **inside** the node |

`/health` is process liveness — "is the slot app up enough to answer". It is not a claim about the
roster, about the hub's capacity, or about whether anybody holds a slot. It sits outside every
prefix the hub's connector routes and **must never acquire one**: the app port is published on no
interface, so "unpriced" here means "in-node", never "free to the internet".

The paid surface a broadcaster actually buys at — a cheap quote and the buy that establishes the
peering — is [#34](https://github.com/toon-protocol/slop_machine/issues/34) onward, under the spec
in [#32](https://github.com/toon-protocol/slop_machine/issues/32).

## The two operator credentials

The app holds the hub's **operator write key** (an ed25519 seed whose public half sits on the
connector's `write_keys` allowlist, and which signature-gates every operator write the app makes)
and the hub's **operator bearer token** (which gates the reads).

Both arrive as **mounted files, named by path**:

| Environment variable                | Flag                            | What it names               |
| ----------------------------------- | ------------------------------- | --------------------------- |
| `TOON_OPERATOR_WRITE_KEY_FILE`      | `--operator-write-key-file`     | the operator write key      |
| `TOON_OPERATOR_BEARER_TOKEN_FILE`   | `--operator-bearer-token-file`  | the operator bearer token   |

There is deliberately **no flag and no environment variable carrying either literal**: a command
line is world-readable on the box, and an image's environment is readable from its metadata by
anyone who pulls it. A path is not a secret; the file it names is.

**The app refuses to start without either, and says which one.** A hub that cannot admit anybody
must look broken rather than look fine — an app that came up holding no write key would answer
liveness, satisfy every supervisor on the box, and then fail the first broadcaster who paid.
Neither value is ever logged, echoed, put in an error message, or present on
`SlotAppInstance.config`; the two *paths* are, because an operator fixing a bad mount needs to know
which file was read.

A hub operator generates both exactly as `deploy/connector.toml`'s own provisioning comments say:

```sh
openssl rand -hex 32 > operator-write.key    # the PRIVATE half, kept
openssl rand -hex 32 > operator-bearer.token
chmod 600 operator-write.key operator-bearer.token
```

Both filenames are covered by the repository's `.gitignore` (`*.key`, `operator-bearer.token`) and
excluded from every Docker build context by `.dockerignore`, before either exists.

## Configuration

Flags over environment over defaults, exactly as the station origin resolves its own:

| Flag                             | Environment                        | Default  |
| -------------------------------- | ---------------------------------- | -------- |
| `--slot-port`                    | `TOON_SLOT_PORT`                   | `3200`   |
| `--host`                         | `TOON_SLOT_HOST`                   | `0.0.0.0`|
| `--data-dir`                     | `TOON_DATA_DIR`                    | `./data` |
| `--operator-write-key-file`      | `TOON_OPERATOR_WRITE_KEY_FILE`     | none     |
| `--operator-bearer-token-file`   | `TOON_OPERATOR_BEARER_TOKEN_FILE`  | none     |

Port `0` binds an ephemeral port, which is how the suite boots apps side by side. The port is
configuration and not a constant for that reason — and because a hub operator moving it must not
need a code change.

## Programmatically

```ts
import { startSlotApp } from '@toon-protocol/slot-app';

const app = await startSlotApp({
  slotPort: 0,
  dataDir: '/srv/hub/data',
  operatorWriteKeyFile: '/run/secrets/operator-write.key',
  operatorBearerTokenFile: '/run/secrets/operator-bearer.token',
});

await fetch(`http://127.0.0.1:${app.config.slotPort}/health`);
await app.stop();
```

`startSlotApp(config): Promise<SlotAppInstance>` mirrors the station origin's `startOrigin`, and
resolves once the listener is accepting connections.

## Build, test, run

From the repo root:

```
pnpm --filter @toon-protocol/slot-app build   # bundles to dist/ (dist/cli.js is the entrypoint)
pnpm test                                     # boots the real app on fresh ports
docker build -f packages/slot-app/Dockerfile -t ghcr.io/toon-protocol/slot-app:latest .
```

The image build's context is the **repository root**, not this directory: the Dockerfile's first
`COPY` takes the workspace root's `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and
`tsconfig.json`, which is how the frozen install resolves. Unlike the station origin's image this
one installs no `ffmpeg` — a hub carries no vibes of its own and this app encodes nothing.
