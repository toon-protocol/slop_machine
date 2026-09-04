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

Issues [#33](https://github.com/toon-protocol/slop_machine/issues/33) and
[#34](https://github.com/toon-protocol/slop_machine/issues/34): the app comes up from its bundled
entrypoint on a configured port, holds the hub's two operator credentials, answers liveness from
inside the node, and **quotes a slot**.

| Surface       | Port             | Paid                | What it is                                         |
| ------------- | ---------------- | ------------------- | -------------------------------------------------- |
| `GET /health` | `TOON_SLOT_PORT` | **never**           | Liveness, for a supervisor **inside** the node      |
| `GET /quote`  | `TOON_SLOT_PORT` | yes, a floor price  | What a slot costs, and which prefix you'd be granted |

`/health` is process liveness — "is the slot app up enough to answer". It is not a claim about the
roster, about the hub's capacity, or about whether anybody holds a slot. It sits outside every
prefix the hub's connector routes and **must never acquire one**: the app port is published on no
interface, so "unpriced" here means "in-node", never "free to the internet".

### `GET /quote`

What a broadcaster asks before they buy. It sits beneath **its own connector prefix** at a floor
price — never the buy's, so neither address is reachable at the other's price — and answers:

```json
{
  "prefix": "g.toon.slopmachine.7a1c93f0be42",
  "label": "7a1c93f0be42",
  "hubAddress": "g.toon.slopmachine",
  "slotPrice": 1000000,
  "slotPeriodSeconds": 2592000,
  "hasCapacity": true,
  "slotCap": 100,
  "slotsHeld": 0,
  "slot": null
}
```

`200 application/json`, `Cache-Control: no-store`. `slot` is the caller's own slot — `{ "lapsesAt":
<epoch ms> }` if they hold one, `null` if they do not, which is every caller until the buy (#35)
writes the first one.

**`prefix` is what the address exists for.** A broadcaster writes it into their own station's
`connector.toml`, brings the station up, and is ready to be pointed at *before* they have paid the
slot price — otherwise they would have to buy twice, once to learn the label and once after
configuring for it.

**The handle is the hub's to assign, derived from the payer the connector verified.** `X-TOON-Payer`
is the client channel key a terminating connector admitted a covering claim under, and it is the one
identity in the request that is not self-asserted
([connector ADR 0040](https://github.com/toon-protocol/connector/blob/main/docs/adr/0040-a-verified-payment-is-stated-to-the-app.md)).
The label is a hex digest of it, so the same broadcaster reads the same prefix for ever and nobody
else can take it. **There is therefore no "that handle is taken" refusal**: where two payers would
derive one label the app lengthens it deterministically until it is free rather than turning either
away. The cost is that nobody gets a vanity handle, and that is accepted — see
[ADR 0003's amendment](../../docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md#amendment-2026-09-04-a-refusal-is-paid-for-so-the-design-moves-refusals-rather-than-pricing-them-at-nothing)
for why a refusal at the buy address is one the broadcaster pays for.

**A hub at its cap is a `200`, not a refusal.** `hasCapacity: false` is the answer, at the cheap
address, so a broadcaster never pays the slot price to be turned away. That is the whole reason the
quote is priced apart from the buy.

**A request with no `X-TOON-Payer` is refused** with `403` and
`{"error": "no_paid_termination", "message": ...}`. Absent means the request did not arrive through
a paid termination this connector verified — a peer-wire arrival, an unclaimed request, or a route
priced at zero — and the message says so rather than blaming the caller's body. A caller's own
spelling of that header never survives the connector's strip, so there is nothing in their request
to fix.

The buy that establishes the peering, the roster's writer, the lapse and the boot reconciliation are
[#35](https://github.com/toon-protocol/slop_machine/issues/35) onward, under the spec in
[#32](https://github.com/toon-protocol/slop_machine/issues/32).

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

| Flag                             | Environment                        | Default              |
| -------------------------------- | ---------------------------------- | -------------------- |
| `--slot-port`                    | `TOON_SLOT_PORT`                   | `3200`               |
| `--host`                         | `TOON_SLOT_HOST`                   | `0.0.0.0`            |
| `--data-dir`                     | `TOON_DATA_DIR`                    | `./data`             |
| `--hub-address`                  | `TOON_HUB_ADDRESS`                 | `g.toon.slopmachine` |
| `--slot-price`                   | `TOON_SLOT_PRICE`                  | `1000000`            |
| `--slot-period-seconds`          | `TOON_SLOT_PERIOD_SECONDS`         | `2592000` (30 days)  |
| `--slot-cap`                     | `TOON_SLOT_CAP`                    | `100`                |
| `--operator-write-key-file`      | `TOON_OPERATOR_WRITE_KEY_FILE`     | none                 |
| `--operator-bearer-token-file`   | `TOON_OPERATOR_BEARER_TOKEN_FILE`  | none                 |

Port `0` binds an ephemeral port, which is how the suite boots apps side by side. The port is
configuration and not a constant for that reason — and because a hub operator moving it must not
need a code change.

**The last four before the credentials are the hub's admission policy**, and they are configuration
for the same reason: admission here is a price rather than a judgement, so those numbers *are* the
policy and changing one must never be a code change. `--slot-cap` of `0` is a legal setting and
means the hub is admitting nobody. `--slot-period-seconds` is in seconds because that is what makes
a lapse testable without a fake clock — the suite sets it to a second or two, exactly as the station
origin's `--ingest-idle-seconds` made a time rule ordinary configuration.

**`--slot-price` is not payment code.** It is the number the app *reports* at the quote so a
broadcaster learns what a slot costs before buying one, and (from the buy onward) the floor the app
checks the connector's own stated `X-TOON-Amount` against so an under-charging route cannot sell
slots below policy. Charging is the connector's job and pricing a route is connector configuration —
so this number and the hub's `connector.toml` buy route are **one pair**, to change in one commit.

Every one of them is validated **fail-closed at boot**: a price, period or cap nobody could have
meant is a `SlotPolicyError` and a non-zero exit, not a degraded run.

## Programmatically

```ts
import { startSlotApp } from '@toon-protocol/slot-app';

const app = await startSlotApp({
  slotPort: 0,
  dataDir: '/srv/hub/data',
  hubAddress: 'g.toon.slopmachine',
  slotPrice: 1_000_000,
  slotPeriodSeconds: 30 * 24 * 60 * 60,
  slotCap: 100,
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
