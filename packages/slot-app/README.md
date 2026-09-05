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

Issues [#33](https://github.com/toon-protocol/slop_machine/issues/33),
[#34](https://github.com/toon-protocol/slop_machine/issues/34),
[#35](https://github.com/toon-protocol/slop_machine/issues/35),
[#36](https://github.com/toon-protocol/slop_machine/issues/36),
[#37](https://github.com/toon-protocol/slop_machine/issues/37),
[#38](https://github.com/toon-protocol/slop_machine/issues/38) and
[#39](https://github.com/toon-protocol/slop_machine/issues/39): the app comes up from its bundled
entrypoint on a configured port, holds the hub's two operator credentials, answers liveness from
inside the node, **quotes a slot**, and **sells one — establishing the peering and writing one
forwarded route per address the station sells, before it answers**. **Buying again is renewing**:
the same handle, one slot rather than two, the lapse extended, and the hub's routing table brought
back into line with what the station publishes today. **A slot nobody renews lapses**, and the hub
takes its routes and its peering back out on its own initiative. **At boot the app reconciles** its
own connector's tables against the roster, and shows the hub operator that roster at an unpriced
address.

| Surface        | Port             | Paid                | What it is                                          |
| -------------- | ---------------- | ------------------- | --------------------------------------------------- |
| `GET /health`  | `TOON_SLOT_PORT` | **never**           | Liveness, for a supervisor **inside** the node       |
| `GET /roster`  | `TOON_SLOT_PORT` | **never**           | Who holds a slot and when each lapses, for the operator |
| `GET /quote`   | `TOON_SLOT_PORT` | yes, a floor price  | What a slot costs, and which prefix you'd be granted |
| `POST /buy`    | `TOON_SLOT_PORT` | yes, the slot price | Buy a slot — or renew it: be peered, then be told so |

`/health` is process liveness — "is the slot app up enough to answer". It is not a claim about the
roster, about the hub's capacity, or about whether anybody holds a slot. It sits outside every
prefix the hub's connector routes and **must never acquire one**: the app port is published on no
interface, so "unpriced" here means "in-node", never "free to the internet". `/roster` sits beside
it on exactly those terms, and the same sentence applies to it word for word.

### `GET /roster`

Who holds a slot on this hub and when each one lapses, so a hub operator does not read their own
database by hand. It reads **no payment header and requires none** — there is no connector in front
of this address to state one — and it answers `200 application/json`, `Cache-Control: no-store`:

```json
{
  "hubAddress": "g.toon.slopmachine",
  "slotCap": 100,
  "slotsHeld": 1,
  "slots": [
    {
      "payer": "evm:0x…",
      "label": "9f2c1a4b7e05",
      "prefix": "g.toon.slopmachine.9f2c1a4b7e05",
      "lapsesAt": 1764547200000
    }
  ],
  "timestamp": 1761955200000
}
```

Soonest to lapse first, because the row an operator came to look at is usually the next one to go.
It is a view of the **roster** — what the hub sold — and not of the connector's routing table, which
is what the hub is carrying; the two are made to agree at boot, and where they disagree in between
it is this record that says which of them is right.

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
<epoch ms> }` if they hold one, `null` if they do not: a broadcaster who has never bought, or whose
slot has already lapsed and been taken back out.

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

### `POST /buy`

At the slot price, beneath **its own connector prefix** and never the quote's. The request body
carries one thing:

```json
{ "stationUrl": "https://station.example/ilp" }
```

Everything else is derived — the handle from the payer the connector verified, the carriage terms
from the hub's own configuration, the chain from `X-TOON-Chain`. The answer is `200
application/json`, `Cache-Control: no-store`:

```json
{
  "prefix": "g.toon.slopmachine.7a1c93f0be42",
  "label": "7a1c93f0be42",
  "hubAddress": "g.toon.slopmachine",
  "lapsesAt": 1793664000000,
  "slotPeriodSeconds": 2592000,
  "peering": {
    "localLabel": "7a1c93f0be42",
    "channel": { "id": "0x…", "status": "created", "chain": "evm" }
  },
  "routes": [
    { "prefix": "g.toon.slopmachine.7a1c93f0be42.now", "price": "60" },
    { "prefix": "g.toon.slopmachine.7a1c93f0be42.audio", "price": "210" },
    { "prefix": "g.toon.slopmachine.7a1c93f0be42.480p", "price": "1010" }
  ]
}
```

**The fulfill means you are peered.** Inside the request, in this order and all of it before the
answer: read the three attribution headers; refuse an absent payer **before the operator surface is
touched**; check the stated `X-TOON-Amount` covers the configured slot price — reading a fact the
connector stated, not validating a payment, so a route misconfigured to under-charge cannot sell
slots; derive the handle; **read the station connector's own self-description** at `stationUrl` and
derive one route per address it publishes; establish the peering with one signed `POST /peers`;
write those routes with one signed `POST /routes/peers` each; **take back out** any row beneath that
caller's granted prefix the station no longer publishes, with one signed
`DELETE /routes/peers/:prefix` each; **record the slot durably**; answer.

### The routes, and where their prices come from

Being peered is not yet being reachable: a hub carries only what its routing table names. So the
purchase writes **one forwarded route per prefix the station's own connector publishes** beneath the
prefix the hub granted — every rung on its ladder, and the station's *now* at its own cheap price, so
a viber can join at the live edge without paying a segment price to find it.

**Nothing about those prices is declared by the buyer**, which is why nothing can drift from the
station's real configuration. The hub `GET`s the station connector's self-description
([connector ADR 0050](https://github.com/toon-protocol/connector/blob/main/docs/adr/0050-a-connectors-url-resolves-to-its-self-description.md)),
which publishes that node's ILP addresses, its endpoints, its settlement facts and **its route
prices**, and derives each route from it:

```
hub route price  =  the station's own published price for that prefix
                 +  TOON_PEERING_FEE, the hub's carriage
```

That sum is not a policy choice, it is arithmetic. The hub's connector charges the route's price at
its client edge and retains the peering's `fee` for carrying the packet, so `price - fee` is what
reaches the station — and the station's own connector then checks, per packet, that a peer-wire
arrival covers the price of the termination it resolves to
([connector ADR 0029](https://github.com/toon-protocol/connector/blob/main/docs/adr/0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md)).
A hub route priced any lower is a route that forwards into a refusal: reachable, paid for, and dead.
A published slope (`pricePerKib`) crosses the hop untouched, because a *fee* is flat per packet and
does not gain one.

Prices are decimal strings on both wires, in the settlement asset's base units, because a price is a
`u64` and is not representable in a JSON number a reader can be trusted with.

**Only what sits beneath the granted prefix is routed.** A station publishing an address the hub
granted somebody else is not routed to — that address is not theirs to be pointed at — and a station
publishing *nothing* beneath its grant is refused before the operator surface is touched at all,
because the broadcaster has not yet written their granted prefix into their own `connector.toml`.

**The slot is on disk before the answer goes out.** Gas is spent inside a paid request here, so a
purchase whose answer arrived too late has to be found *already done* on the retry rather than
paying for the same peering twice. The peering write is retry-safe on the same reasoning: a repeat
against an established peering finds the same channel — `"status": "found"` — instead of opening a
second one.

**The peering carries the hub's own terms and nothing a broadcaster chose**: the derived handle as
the hub's local label, `TOON_PEERING_FEE`, `TOON_PEERING_MAX_PACKET_AMOUNT`, and the chain the
broadcaster demonstrably paid on, so the peering never settles on a guess between two shared chains.

**The write is RFC 9421 signature-gated, never bearer-gated.** A `Content-Digest` (RFC 9530) binds
the signature to the body, the base covers exactly `@method`, `@path` and `content-digest`, and an
accepted signature is never replayable — so every retry inside the request is signed afresh, with
`created` advancing rather than a spent signature being re-sent.

Its refusals are the ones that cannot be moved to the quote, and each is a **paid** answer:

| Status | `error`                   | Whose problem it is                                                  |
| ------ | ------------------------- | -------------------------------------------------------------------- |
| `403`  | `no_paid_termination`     | the hub's route: no verified payer, so no operator surface was touched |
| `403`  | `route_under_charges`     | the hub's route: it charged less than `TOON_SLOT_PRICE`                |
| `400`  | `no_station_url`          | the caller's request: no station connector URL in the body             |
| `502`  | `station_unreadable`      | **the caller's own node**: its self-description could not be read      |
| `502`  | `station_not_at_prefix`   | **the caller's own node**: it publishes nothing beneath the granted prefix |
| `409`  | `route_owned_by_config`   | the hub's own config file already owns one of those rows               |
| `503`  | `peering_not_established` | the hub's own operator surface                                         |
| `503`  | `routes_not_written`      | the hub's own operator surface: a route it would not write, would not remove, or a table it would not report |
| `503`  | `slot_not_recorded`       | the hub's own data directory — you *are* peered; retrying is safe      |

**A refusal never leaves a half-written slot.** The slot is recorded last and only once the peering
and every route are in place, so a purchase that was refused is a purchase the hub does not count:
the quote still says the caller holds nothing, and a restart finds nothing either. What can survive
is the peering and any route written before the refusal — both keyed by the caller's own derived
label, both rewritten to the same values by a retry rather than duplicated, and neither of them a
slot. Undoing them would be worse than leaving them: a purchase by a broadcaster who already holds a
slot writes the same rows, and a rollback could not tell a row it had just created from one it had
merely rewritten.

A hub **at its cap refuses a new slot here**, `503 {"error": "at_capacity"}`, before any operator
write — and it is the one refusal at this address that the quote could have foreseen. The cap is the
hub's capital bound: every admission opens a channel it fronts collateral toward, so a cap that were
only *reported* at the quote would bound nothing. Charging for that answer is not charging for
nothing — the quote said `hasCapacity: false` for a floor price and the buyer went past it — which
is the argument
[ADR 0003's second amendment](../../docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md#amendment-2026-09-04-the-cap-is-enforced-at-the-buy-because-a-warned-buyer-is-not-charged-for-nothing)
records in full. **A renewal is never refused for the cap**, at it or over it: renewing opens no
channel, so it adds nothing to what the cap bounds.

### Buying again is renewing

There is no second call to learn. A purchase by a payer who already holds a slot walks exactly the
path above and ends up with **one** slot, not two:

- **the same handle and the same granted prefix**, read off the roster rather than derived again, so
  the address a broadcaster printed on their page keeps working;
- **the established peering found, not a second channel opened** — `"status": "found"`, which is the
  retry-safety the write already had, put to its second use;
- **the lapse extended rather than reset**:

  ```
  lapsesAt = max(now, the lapse you already hold) + TOON_SLOT_PERIOD_SECONDS
  ```

  Resetting to `now + period` would take back every second you had already paid for, so renewing a
  fortnight early would cost you a fortnight and the safe move would be to renew at the last
  minute. Extending from the held lapse *alone* would do the opposite once a slot has lapsed: a
  station that went dark for a month and came back would have that month credited to it. `max` is
  the only reading that cheats nobody. The `/quote` answers the same number the renewal did.

**And the hub's routing table ends up matching what your station sells today.** The renewal re-reads
your self-description, so a rung you added since is routed — and **a rung you dropped is taken back
out**, because a route write is an upsert and rewriting the survivors removes nothing.

Removing a row is a destructive write against a table every broadcaster on the hub shares, and it is
fenced twice. The candidates are read off the hub's own bearer-gated `GET /routes/peers` and
filtered to **runtime** rows **at or beneath your own granted prefix** — a config row is the hub
operator's and the connector refuses it `409` — and the only function that issues the `DELETE`
re-checks that fence itself before sending anything. A grant is derived from a verified payer and
lengthened until it is free, so no two grants ever nest, and a renewal can never reach another
broadcaster's row. A `404` back is a success: the row is already gone, which is the state that was
asked for. Removal happens **after** the writes, so a rung is never briefly unreachable in the
middle of its own broadcaster's renewal.

A renewal the hub could not finish is a `503 routes_not_written` that leaves you holding the slot
and the lapse you already had — never a shortened one — and retrying is safe.

### A slot nobody renews lapses

Stop renewing and the hub takes it back out **by itself**. A ticker walks the roster every
`TOON_LAPSE_SWEEP_SECONDS` (default `60`) and tears down everything past its lapse time; no request
triggers it, because a teardown that waited for somebody else to buy would leave a hub carrying its
last dead station for ever.

Per lapsed slot, in this order and no other:

1. **every route out** — one signed `DELETE /routes/peers/:prefix` each;
2. **then the peering released** — one signed `DELETE /peers/:id`, which is what brings the hub's
   collateral back;
3. **then the slot off the roster.**

The first order is the connector's rule rather than a preference: it refuses to remove a runtime
peering while a runtime route still forwards to it (`PeerRouteTableError::PeerInUse`, a `409`), so
the other way round is a teardown that stops half-way through and leaves a hub carrying priced
addresses toward a station it no longer peers with. The rows taken out are every runtime row **at or
beneath the granted prefix** *or* **forwarding to that slot's own peering label** — the connector's
rule is keyed on the label, the fence a grant gives is keyed on the prefix, and a teardown has to
satisfy the first while staying inside the second.

The roster row goes **last** on purpose. A slot on the roster is the hub's claim that routes and a
peering behind it may still exist, so a teardown that failed leaves the slot standing, says so, and
the next sweep tries again — rather than leaving collateral committed toward a counterparty nothing
in the hub remembers.

**A lapsed handle is still yours.** Coming back is a re-buy at the same address, not starting over
at a new one — the handle is derived from your payer key, so it does not go anywhere.

The slot period and the sweep interval are both ordinary configuration, in **seconds**, which is
what makes a lapse testable in real time rather than against a fake clock — the same precedent
`--ingest-idle-seconds` set on the station side. There is deliberately no value that turns the sweep
off: a hub that never reclaims a dead station's peering only ever commits more collateral.

The **first sweep is one interval after boot, never at boot.** Tearing down what lapsed while the
process was down needs the connector's own tables read first, so the boot reconciliation below does
it — with those tables in hand, and through this same teardown.

### At boot, the roster and the routing table are made to agree

They are two records of one fact, and a crash between two writes — or a hub operator editing their
own table by hand — leaves them disagreeing. So before the port binds, and before the app can take
a purchase:

1. **read** the hub's own `GET /peers` and `GET /routes/peers`, bearer-gated;
2. **tear down what lapsed while the process was down**, through the lapse's own sweep and in the
   lapse's own order — **downtime does not extend anybody's slot**;
3. **write back** what a live slot bought and the connector is not carrying: the peering
   re-established first where it has gone, then every granted address the table is missing, points
   at the wrong peering, or holds at the wrong price;
4. **take back out** every row the roster does not hold — routes first, then the peering, exactly
   as a lapse does, because it is the same act: tearing down a slot that is not on the roster
   because a crash landed between the peering write and the roster write.

A removal here is a destructive write against a table every broadcaster on the hub shares and the
operator writes to by hand, so it is **fenced three times**, and each fence stands alone: the row
must be `source: "runtime"` (a config row is never even asked about — being refused a `409` is not
a fence); its label must be one this hub could itself have **derived**, and its prefix inside the
address space that label is granted (so `g.hub.demo` and a hand-written `apex-relay-2` are none of
the app's business); and no live slot may hold that label.

**It never refuses to boot.** A hub whose own connector is still coming up says so in its log and
carries on: the ticker still lapses what is past its time, a renewal still rewrites its own rows,
and the next boot reconciles.

An **accepted signature is spent**, and the connector's replay cache outlives this app — so a
restarted process treats the second it was born in as already spent, and its first write signs at
the next second onward. Without that, a reconciliation repeating a write its predecessor made
moments earlier would be refused as a replay.

## The two operator credentials

The app holds the hub's **operator write key** (an ed25519 seed whose public half sits on the
connector's `write_keys` allowlist, and which signature-gates every operator write the app makes)
and the hub's **operator bearer token** (which gates the reads — asking the connector who it peers
with and what its routing table already carries, so a renewal knows which rows to take back out and
a boot knows what it is missing).

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

**The write key file is that seed and nothing else: 64 hex characters.** The app wraps it in the
fixed Ed25519 PKCS8 DER prefix at signing time, so there is no second key file in a second format to
keep in step. The value that goes on the connector's `write_keys` allowlist is the **public** half,
which the app prints at boot beside its peering policy — the same value
`connector send --operator-key operator-write.key --print-keyid` derives. A write key file that is
not a seed is a **refusal to start**: a hub that cannot sign a write can admit nobody, and finding
out at the first broadcaster's purchase would cost them the slot price.

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
| `--lapse-sweep-seconds`          | `TOON_LAPSE_SWEEP_SECONDS`         | `60`                 |
| `--operator-url`                 | `TOON_OPERATOR_URL`                | none                 |
| `--peering-fee`                  | `TOON_PEERING_FEE`                 | `10`                 |
| `--peering-max-packet-amount`    | `TOON_PEERING_MAX_PACKET_AMOUNT`   | `10000000`           |
| `--operator-write-key-file`      | `TOON_OPERATOR_WRITE_KEY_FILE`     | none                 |
| `--operator-bearer-token-file`   | `TOON_OPERATOR_BEARER_TOKEN_FILE`  | none                 |

Port `0` binds an ephemeral port, which is how the suite boots apps side by side. The port is
configuration and not a constant for that reason — and because a hub operator moving it must not
need a code change.

**`--hub-address`, `--slot-price`, `--slot-period-seconds` and `--slot-cap` are the hub's admission
policy**, and they are configuration for the same reason: admission here is a price rather than a
judgement, so those numbers *are* the policy and changing one must never be a code change.
`--slot-cap` of `0` is a legal setting and means the hub is admitting nobody — and because a
renewal is never refused for the cap, lowering it closes the door without evicting the stations
behind it. `--slot-period-seconds` is in seconds because that is what makes a lapse testable without
a fake clock — the suite sets it to a second or two, exactly as the station origin's
`--ingest-idle-seconds` made a time rule ordinary configuration.

**`--lapse-sweep-seconds` is how often the roster is walked for lapsed slots** — the *granularity*
of the lapse, not its length. Seconds for the same reason the period is. There is deliberately no
value that turns the sweep off: `0` is refused at boot, because a hub that never reclaims a dead
station's peering only ever commits more collateral.

**`--operator-url` is required and has no default**, on exactly the terms the two credentials are:
an app that cannot reach an operator surface can admit nobody. In a hub bundle it is the connector
on the compose network, e.g. `http://connector:3000`. It is **configuration, not an injected port** —
the suite points it at a fake operator surface that verifies signatures for real, and the app's own
API is the same either way.

**`--peering-fee` and `--peering-max-packet-amount` are the hub's own terms about a counterparty**,
and are configuration precisely because no document a broadcaster serves could supply them. A
broadcaster never chooses how far the hub trusts them. Carriage is where a hub earns; the slot price
is not.

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
  operatorUrl: 'http://connector:3000',
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
