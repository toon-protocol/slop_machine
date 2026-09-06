# slop_machine

Paid live broadcast over TOON. Vibers pay per segment as they watch or listen; the money lands with
the broadcaster. Two toon apps ship from this repo, both sitting behind the connector so neither
ever sees a payment:

- the **station origin** — ingests a broadcaster's vibes over RTMP and serves HLS segments of them;
- the **slot app** — sells the routing-table entries that make a station reachable from a hub.

A **hub** deployment is otherwise stock: the announcement surface is the **relay** toon app's
published image, and the router is the stock connector. Only the two apps above are new code.

Part of the **TOON Protocol** — pay-to-use infrastructure over Interledger (ILP), split into
per-team repos.

## Vocabulary is load-bearing here

Read [`CONTEXT.md`](./CONTEXT.md) before writing anything. The words are chosen, not incidental —
*vibes* are the media, a *viber* is who pays for them, a *rung* is a priced quality level, a *slot*
is what a broadcaster buys, and a *channel* always means a payment channel. Two collisions matter
enough to be called out in the glossary itself: **slot is not peering**
([ADR 0003](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md) depends on the
distinction) and **segment is not packet**.

## Status: the station origin ingests, encodes, serves and deploys; the slot app boots, quotes, sells, funds, routes, renews, lapses and reconciles

This repository is a pnpm workspace with two packages, one per toon app it ships —
`packages/station-origin` (`@toon-protocol/station-origin`) and `packages/slot-app`
(`@toon-protocol/slot-app`). Both take the fleet's house shape, the same one `relay` and `store`
use: TypeScript, Hono over the Node server adapter, bundled to a single entrypoint with
tsup/esbuild, tested with vitest, a `Dockerfile` beside it and an image published to GHCR on merge
to `main`. The slot app is the newer and by far the smaller of the two — see
[the slot app](#the-slot-app) below for exactly what it does today, which is boot, quote a slot,
and sell one — peering with the broadcaster's station, **funding the payment channel that peering
opened**, routing every address it sells, treating a
second purchase as a renewal of the first, **taking a slot nobody renewed back out on its own
initiative**, and **making its own connector's routing table agree with its roster at boot** so a
crash between two writes, or a hand-edit, is never a permanent disagreement.

What the station origin does today ([#5](https://github.com/toon-protocol/slop_machine/issues/5),
[#6](https://github.com/toon-protocol/slop_machine/issues/6),
[#7](https://github.com/toon-protocol/slop_machine/issues/7),
[#8](https://github.com/toon-protocol/slop_machine/issues/8),
[#9](https://github.com/toon-protocol/slop_machine/issues/9),
[#10](https://github.com/toon-protocol/slop_machine/issues/10),
[#11](https://github.com/toon-protocol/slop_machine/issues/11),
[#12](https://github.com/toon-protocol/slop_machine/issues/12),
[#13](https://github.com/toon-protocol/slop_machine/issues/13)) is the whole paid path across a
**configurable rung ladder** — boot, answer liveness, take a broadcaster's vibes in, encode and cut
them at every rung, serve the result by address, say where the live edge is, survive a dropped
uplink, drop what has fallen out of the window, and tell the broadcaster whether the box is keeping
up with the ladder:

- `GET /health` on the segment port (`TOON_SEGMENT_PORT`, default `3100`) — process liveness, for a
  broadcaster-operator's supervisor **inside** the node. It requires no payment header and reads
  none. It is not a claim about ingest; the station's *now* is a separate, paid address.
- `GET /encode` on the segment port — **whether the encode is keeping up with the ladder**, which
  is the broadcaster-operator's own diagnostic and not anything a viber buys. `200
  application/json`, `Cache-Control: no-store`, carrying `{"live": boolean, "segmentSeconds":
  number, "segmentByteBudget": number, "rungs": [{"rung", "encoding", "keepingUp", "behindSeconds",
  "encodedSeconds", "elapsedSeconds", "refusedOverBudget", "lastOverBudget",
  "largestSegmentBytes"}]}` in ladder order. It is **measured, not asserted**: seconds of vibes
  finished against seconds of real time since the encoder started, with one segment of slack for the
  span in flight and one more (at least two seconds) for start-up and flush. Per rung, because a
  cheap rung keeping pace while an expensive one falls behind **names the rung to drop** — which is
  the difference between "my ladder is too ambitious for this box" and "my uplink is bad", and the
  latter is `live` going false. `keepingUp` and `behindSeconds` are `null` before a station's first
  broadcast and freeze when one ends. A rung that starts falling behind also says so **in the logs**,
  on the transition and again on recovery. `refusedOverBudget`, `lastOverBudget` and
  `largestSegmentBytes` are the byte-budget alarm the boot-time arithmetic cannot raise: what the
  encoder *actually* produced, and which spans were thrown away rather than served. Like `/health`
  it is **unpriced, outside every prefix the connector routes, and reachable only from inside the
  node** — the segment port is published on no interface, so unpriced never means free to the
  internet. It is deliberately not `/now`, which is paid, viber-facing and about the live edge; no
  sequence number of the live edge appears here.
- **RTMP/RTMPS ingest** on the ingest port (`TOON_INGEST_PORT`, default `1935`) — a broadcaster
  publishes with their stream key as the stream name (`rtmps://<station>:1935/live/<stream key>`,
  which is exactly the Server/Stream Key pair OBS asks for). The key is checked on the RTMP
  `publish` command, before a byte is read or transcoded, and a wrong or absent key is answered with
  an RTMP error status and the socket closed, so it shows up in OBS at once. Ingest is
  authenticated and **never paid**. Accepted vibes go to the origin's own segmenter as an FLV
  stream; the `onIngest` callback sees the same stream as an extra observer. **A dropped uplink does
  not end the station**: the origin keeps serving the window it already holds, `/now` reports no
  ingest, and a reconnect with the right key **continues the sequence** rather than resetting it, so
  no address a viber already paid for is quietly re-let with different vibes. Because a dropped
  connection is usually a half-open one rather than a closed one, an accepted publish **supersedes**
  whatever publish was open and drops it — a station has one broadcaster, and a reconnect is not a
  second one. Superseding covers the broadcaster who comes back; the **idle rule** covers the one
  who does not (see below).
- `GET /segments/<rung>/<sequence>.ts` on the segment port — one MPEG-TS span of the broadcast at
  that rung, `200` with `Content-Type: video/mp2t`. A rung the station does not offer and a
  sequence it does not hold are both `404`, told apart by an `error` of `unknown_rung` or
  `unknown_segment`, because a player whose rung has gone falls back and a player whose sequence has
  gone re-syncs. **The rung comes before the sequence** so every path a viber can reach at one
  rung's price sits strictly beneath that rung's own prefix, `/segments/<rung>/` — one connector
  route per rung, and no address reachable at another address's price. Anything that is not a
  segment sits outside `/segments` entirely. The origin supervises a child `ffmpeg` that cuts the
  vibes into **fixed-duration** segments at a **hard bitrate cap** (constrained VBR — a maximum rate
  plus a short buffer, never average targeting), writes each span under a temporary name and renames
  it only once complete, and serves it whole with its length stated. A segment over the 2 MiB budget
  is logged loudly and never served. **No playlist is served** and nothing free is: the client
  daemon synthesizes whatever its player needs over loopback. **Which rungs exist is
  configuration** — `TOON_RUNGS`/`--rungs`, defaulting to the four-rung placeholder ladder — and one
  ingest is encoded at every rung on it, each into its own prefix.
- `GET /now` on the segment port — the **station's *now***: `200 application/json`,
  `Cache-Control: no-store`, always, carrying `{"live": boolean, "segmentSeconds": number, "rungs":
  [{"rung": string, "sequence": number | null}]}` with the rungs in ladder order and `sequence` the
  newest segment that rung is holding (`null` when it holds none — never `0`, which is a real
  segment somebody could pay for). This is what a viber pulls to **start at the live edge instead of
  at the beginning**, and having every rung in one answer is what lets a player climb and drop rungs
  mid-broadcast on a budget. `live` is the plain fact of an open publish, which is what tells a
  **stalled edge apart from a station that ended**. It is **paid**, like a segment, but it sits under
  its **own prefix, `/now`** — outside `/segments` and beneath no rung — so the connector prices it
  cheaply on its own and no address is reachable at another address's price. It is deliberately not
  `/health`: liveness is unpriced, in-node, and answers the same whether or not anybody is
  broadcasting. **This report is the whole of the origin's discovery surface** — sequence numbers and
  a duration, no URIs, no prices, and no playlist of any kind, per-rung or master.

### Ports, honestly

The origin binds two listeners and they are not alike:

- the **segment** port is published on no interface — the only route to a station's vibes is a paid
  packet through its connector;
- the **ingest** port *is* published by the station node, straight to the internet. Stock Caddy does
  not speak RTMP and a custom Caddy image would break the fleet's stock-TLS-front norm, so the
  origin fronts its own ingest and terminates its own TLS. "Only Caddy is reachable from the
  internet" was true before #6 and is not true now; the invariant is **exactly three published
  ports — Caddy's 80 and 443 plus the RTMPS ingest port — and the segment port is never one of
  them**.

`deploy/docker-compose.yml` is where that invariant is now written down, and it holds:

| Port     | Service     | Published as          | Why                                                       |
| -------- | ----------- | --------------------- | --------------------------------------------------------- |
| 80, 443  | `caddy`     | `80:80`, `443:443`    | the paid HTTP path — being reachable is Caddy's whole job |
| 1935     | `origin`    | `1935:1935`           | RTMPS ingest, terminated by the origin itself             |
| 3000     | `connector` | `127.0.0.1:3000:3000` | the client edge, **loopback only**, for on-box operator calls |
| **3100** | `origin`    | **never**             | the segment port: `expose:` on the compose network and nothing else |

A docker `ports:` publish **without** a host-IP prefix is internet-reachable even with `ufw` locked
to 22/80/443/1935 — Docker's iptables chain runs ahead of ufw. Never convert the origin's
`expose: 3100` into a `ports:`, not even on loopback, and never drop the `127.0.0.1:` from the
connector's. [`deploy/bundle.test.ts`](deploy/bundle.test.ts) is the guard that fails the build if
either happens — in **any** of the three compose files and in **any** file set an operator is told
to run, because a publish added to an overlay is as much a free door as one added to the base file.
It fails equally on a Caddy route to the origin, which is the same door reached through the front.

### The rung ladder

The ladder is one string, `--rungs`/`TOON_RUNGS`, because a station's rungs have to be readable
beside the connector routes that price them in the same compose file:

```
TOON_RUNGS="audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k"
```

Rungs are comma-separated, fields colon-separated: `<name>:<height>:<video bitrate>:<audio bitrate>`
for a rung with a picture, `<name>:<audio bitrate>` for one carrying only sound. Bitrates are
**caps, never targets**, in bits per second with the broadcast-conventional `k` and `M` suffixes.
That default is exactly the four-rung, four-second ladder of
[`docs/placeholder-numbers.md`](docs/placeholder-numbers.md), and the rung names are the address
prefixes the connector prices, one route each.

**The ladder is validated fail-closed at every start.** Worst-case bytes are computed as capped
bitrate × fixed segment duration, and the origin **refuses to start — non-zero exit, naming the
offending rung** — if any rung exceeds ADR 0001's 2 MiB budget. It refuses just as flatly on a
ladder it cannot read, a name that could not be addressed, or two rungs of one name. Same posture as
`connector.toml`: a bad config is a refuse-to-start, never a degraded run. Because it is arithmetic
over configuration, raising a bitrate re-runs the check at the next start rather than quietly
breaking the bound. At four-second segments the ceiling is 4.19 Mbit/s, which is why the top rung
sits at 3 Mbit/s.

### Retention

**A sliding window, evicted by count.** `--retain-segments`/`TOON_RETAIN_SEGMENTS` (default `60`) is
how many segments each rung keeps; older ones are unlinked as the broadcast runs, on the origin's
own initiative, so a broadcast that runs for days does not fill the broadcaster's disk. A request
for an evicted sequence is the same `404 {"error": "unknown_segment"}` as one that never existed —
the viber re-syncs from `/now` rather than paying for nothing, and it stays distinguishable from
`unknown_rung`, which calls for falling back to another rung instead.

Count, not age and not bytes: a segment covers a fixed duration, so a window of *n* is *n × duration*
seconds at every rung at once, and the disk bound is arithmetic an operator can do from the two
lines they wrote — the window times the ladder's worst-case segment, which the origin prints at
boot. **The newest segment is never evicted**, so the sequence `/now` names is always still there.
A window that would keep nothing refuses the start, naming the number, exactly like a ladder over
the byte budget. A restarted origin reads the window off its data directory rather than walking from
sequence 0, so eviction cannot make it renumber and serve different vibes at an address already
paid for.

### The idle rule

**No vibes for `N` seconds and the station is off the air.** `--ingest-idle-seconds`/
`TOON_INGEST_IDLE_SECONDS` (default `30`) bounds how long an accepted publish may go without
sending media before the origin takes it off the air on its own initiative.

This is the half-open death that `supersede()` cannot reach. An uplink that dies quietly sends no
FIN and no RST: the connection sits ESTABLISHED with nothing coming down it until TCP gives up,
which behind a NAT that has forgotten the flow is never, and nothing arrives to supersede anything
because the broadcaster never reconnects. Without the rule `/now` would report `live: true` beside
a sequence that never moves, for ever — which destroys both distinctions the *now* address exists
to draw, "nobody is vibing" from "I am not actually live" and a stalled edge from a station that
ended.

The clock counts **vibes, not socket activity**. A connection that is open, healthy, acknowledging
our window and sending no media is a stalled edge and the station says so. TCP keepalive would
answer a weaker question ("is the peer's kernel there") on a timescale of hours and would be
satisfied by exactly that publisher, so ingest sets none.

Going off the air changes nothing a viber can buy: the window already produced stays on disk and
stays servable at the sequences a viber already knows, and a broadcaster who returns is accepted
like any other publish and **continues the sequence**. There is deliberately **no value that
switches the rule off** — zero, a negative or a fractional interval is an `IngestIdleError` and a
non-zero exit, because a station reporting itself live for ever must not be reachable by a typo.

### Configuration

Flags over environment over defaults: `--segment-port`/`TOON_SEGMENT_PORT`,
`--host`/`TOON_SEGMENT_HOST`, `--data-dir`/`TOON_DATA_DIR`,
`--segment-seconds`/`TOON_SEGMENT_SECONDS`, `--rungs`/`TOON_RUNGS`,
`--retain-segments`/`TOON_RETAIN_SEGMENTS`,
`--ingest-port`/`TOON_INGEST_PORT`, `--ingest-host`/`TOON_INGEST_HOST`,
`--ingest-idle-seconds`/`TOON_INGEST_IDLE_SECONDS`,
`--ingest-tls-cert`/`TOON_INGEST_TLS_CERT`, `--ingest-tls-key`/`TOON_INGEST_TLS_KEY`. Port `0` binds
an ephemeral port, which is how the suite runs stations side by side. Segments land in
`<data dir>/segments/<rung>/`. Programmatically the ladder is `OriginConfig.rungs`, which takes
either that same spec string or the rungs already parsed — which is how the suite runs a
deliberately small two-rung ladder.

The **stream key** is the exception with no default: `--stream-key-file`/`TOON_STREAM_KEY_FILE`
names a mounted file, or `TOON_STREAM_KEY` carries the value. There is deliberately no flag for the
literal — a command line is world-readable on the box. **An origin with no stream key refuses to
start**, because a station anyone can broadcast on looks exactly like a working one. The key is
never logged, never echoed, and never appears in `OriginInstance.config`. Ingest without a mounted
certificate is plain RTMP and says so loudly at boot; a station on the internet mounts one.

### The slot app

[`packages/slot-app`](packages/slot-app/) (`@toon-protocol/slot-app`) is this repo's **second** toon
app and the hub's admission desk: a broadcaster buys a **slot** with a paid request and the hub's
operator key creates the **peering** and writes the routes that make their station reachable.
[#32](https://github.com/toon-protocol/slop_machine/issues/32) is the whole spec;
[#33](https://github.com/toon-protocol/slop_machine/issues/33),
[#34](https://github.com/toon-protocol/slop_machine/issues/34),
[#35](https://github.com/toon-protocol/slop_machine/issues/35),
[#36](https://github.com/toon-protocol/slop_machine/issues/36),
[#37](https://github.com/toon-protocol/slop_machine/issues/37),
[#38](https://github.com/toon-protocol/slop_machine/issues/38) and
[#39](https://github.com/toon-protocol/slop_machine/issues/39) are what exists, and they are **the
boot, the quote, the buy, the routes, the renewal, the lapse, the boot reconciliation and the
operator's roster address**; [#40](https://github.com/toon-protocol/slop_machine/issues/40) and
[#41](https://github.com/toon-protocol/slop_machine/issues/41) are the hub bundle that deploys it
and the guard that holds the bundle still. **That closes the epic** — nothing in #32 is outstanding.

It takes the origin's shape rather than inventing one: it exports
`startSlotApp(config): Promise<SlotAppInstance>` mirroring `startOrigin`, resolves flags over
environment over defaults the same way, and bundles to `dist/cli.js` behind its own `Dockerfile`.

- `GET /health` on the app port (`TOON_SLOT_PORT`, default `3200`) — process liveness, for a hub
  operator's supervisor **inside** the node. `200 application/json` carrying `{"status": "healthy",
  "service": "slot-app", "version": string, "timestamp": number}`. It requires no payment header and
  reads none. It is **unpriced, has no route on the hub's connector and never may** — the app port is
  published on no interface, so unpriced never means free to the internet. It is not a claim about
  the roster or about the hub's capacity; the roster is the address beneath it and the capacity is
  the quote's.
- `GET /roster` on the app port — **who holds a slot and when each lapses**, so a hub operator does
  not read their own database by hand. `200 application/json`, `Cache-Control: no-store`, carrying
  `{"hubAddress": string, "slotCap": number, "slotsHeld": number, "slots": [{"payer": string,
  "label": string, "prefix": string, "lapsesAt": number, "channelId": string | null, "collateral":
  string | null}], "timestamp": number}`, soonest to lapse first. **`channelId` and `collateral` are
  the hub's own money** — which channel it funded for that broadcaster and what was in it when the
  slot was last written — so the commitment `TOON_SLOT_CAP` bounds is a number an operator reads
  rather than computes, and the identifier they would need to close and settle a channel behind a
  station that went away. Both are `null` on a slot recorded before the buy funded anything. **Unpriced on exactly `/health`'s terms**: it reads no payment header and requires none —
  there is no connector in front of it to state one — and it **has no route on the hub's connector
  and never may**, which is what keeps a hub operator's diagnostics off the internet and off sale.
  It is a view of the **roster**, not of the connector's routing table: what the hub sold rather
  than what it is carrying, and where the two disagree it is this record that says which is right.
- `GET /quote` on the app port — **paid**, at a floor price, and beneath **its own connector
  prefix**, never the buy's, so neither address is ever reachable at the other's price. `200
  application/json`, `Cache-Control: no-store`, carrying `{"prefix": string, "label": string,
  "hubAddress": string, "slotPrice": number, "slotPeriodSeconds": number, "hasCapacity": boolean,
  "slotCap": number, "slotsHeld": number, "slot": {"lapsesAt": number} | null}`. This is what a
  broadcaster asks **before** they buy: `prefix` is the ILP address the hub would grant them, which
  they write into their own station's `connector.toml` and boot against, rather than buying twice.
  **The handle is the hub's to assign** — a hex digest of `X-TOON-Payer`, the client channel key a
  terminating connector states only where it verified a covering claim itself (connector ADR 0040).
  Same payer, same handle, for ever, and unavailable to anybody else; **there is no "that handle is
  taken" case**, because where two payers would derive one label the app lengthens it
  deterministically rather than refusing either. **A hub at its cap answers `200` with
  `hasCapacity: false`** — the refusal lives here, at the cheap address, so nobody pays the slot
  price to be turned away. **A request with no `X-TOON-Payer` is refused** `403 {"error":
  "no_paid_termination"}`, and the message names the missing paid termination rather than blaming
  the caller's body: absent means the packet did not arrive through a termination this connector
  verified, and a caller's own spelling of that header never survives the connector's strip.
- `POST /buy` on the app port — **paid**, at the slot price, beneath **its own connector prefix**,
  never the quote's. The body carries exactly one thing, `{"stationUrl": string}` — the station
  connector's own self-description URL — and everything else is derived. `200 application/json`,
  `Cache-Control: no-store`, carrying `{"prefix": string, "label": string, "hubAddress": string,
  "lapsesAt": number, "slotPeriodSeconds": number, "peering": {"localLabel": string, "channel":
  {"id": string, "status": string, "chain": string}}, "routes": [{"prefix": string, "price":
  string, "pricePerKib"?: string}]}`. **The fulfill means you are peered**: in
  order, inside the request and all of it before the answer — read the three attribution headers;
  refuse an absent payer **before the operator surface is touched at all**; check the stated
  `X-TOON-Amount` covers `TOON_SLOT_PRICE` (reading a fact the connector stated, never validating a
  payment, so a route misconfigured to under-charge cannot sell slots); derive the handle from the
  payer, or read it off the roster where they already hold a slot; **read the station connector's
  own self-description** and derive one route per address it publishes; establish the peering with
  one signed `POST /peers`; **fund the channel that write opened** with one signed
  `POST /channels/:id/fund`, before any route points at it; write those routes with one signed
  `POST /routes/peers` each; **take
  back out** any row beneath that caller's granted prefix the station no longer publishes, with one
  signed `DELETE /routes/peers/:prefix` each; **record the slot durably**; answer. The peering write carries the derived
  handle as the hub's **local label**, the station URL from the body, the hub's own `fee` and
  `max_packet_amount`, and `chain` from `X-TOON-Chain` — a broadcaster chooses none of them. It is
  **retry-safe**: a repeat against an established peering answers `"status": "found"` rather than
  opening a second channel. **The fulfill means peered *and payable***: establishing a peering opens
  a channel and does not fund one, so the buy makes the deposit too — `TOON_PEERING_COLLATERAL`, the
  hub's own figure, **after the peering and before any route**, because a route toward an empty
  channel is an address that is reachable, priced, paid for and answers `T00`. **That write is an
  increment, so it is made idempotent by reading first**: the app reads what its own side of the
  channel holds over the bearer-gated `GET /channels` and deposits only the shortfall, so a retry
  deposits nothing, a renewal is a **top-up** rather than a second deposit, and a retry after a write
  whose outcome is unknown re-reads rather than re-sends. It is the one write in this repo where
  repeating it spends real money.
  [ADR 0003's third amendment](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md) is
  the record. **The slot is on disk before the answer goes out**, which is what makes
  a purchase whose answer arrived too late findable by the retry instead of paid for twice. Its
  refusals are only the ones the quote cannot foresee, and every one is a **paid** answer: `403
  no_paid_termination` and `403 route_under_charges` (the hub's route), `400 no_station_url` (the
  caller's request), `502 station_unreadable` and `502 station_not_at_prefix` (**the caller's own
  node**, named as such), `409 route_owned_by_config` (a row the hub's own config file owns), `503
  peering_not_established`, `503 channel_not_funded` (the peering stands and its channel is empty, so
  the broadcaster is peered and not yet payable — a retry costs no second channel and no second
  deposit) and `503 routes_not_written` (the hub's own operator surface) and `503
  slot_not_recorded` (the hub's
  own data directory, after the peering already landed — said out loud rather than left as a bare
  `500`, because what the broadcaster needs to know is that they are peered and that a retry costs
  no second channel) — plus the one refusal the quote *could* have foreseen, `503 at_capacity`,
  which is [ADR 0003's second amendment](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)'s
  whole subject. **No refusal leaves a half-written slot**: the roster is written last
  and only once the peering and every route are in place, so a refused purchase is one the hub does
  not count. What can survive it is the peering and any route written before the refusal — both
  keyed by the caller's own derived label, both rewritten to the same values by a retry rather than
  duplicated, and neither of them a slot. Rolling them back would be worse: a purchase by a
  broadcaster who already holds a slot writes the same rows, and a rollback could not tell a row it
  had just created from one it had merely rewritten.
- **The cap is enforced at the buy, not merely reported at the quote.** A purchase that would be a
  **new** slot is refused `503 {"error": "at_capacity"}` once the roster is at `TOON_SLOT_CAP`,
  **before any operator write**, so a hub at its cap opens no channel it cannot cover. This is a
  deliberate exception to the first ADR 0003 amendment's rule that a new refusal at the buy charges
  a broadcaster for nothing: the quote answers `hasCapacity: false` at a floor price, so a buyer who
  went past it was charged for an answer rather than for nothing — and a cap that is only *reported*
  bounds nothing at all, while the hub's collateral grows linearly with the roster and is bounded by
  this number and no other. **A renewal is never refused for the cap, at it or over it**: renewing
  opens no channel, so it adds nothing to the commitment the cap bounds, and an operator who lowers
  their cap beneath their own roster closes the door without evicting the stations behind it. What
  stays unfair and is not pretended away: two broadcasters can quote the last free slot and both
  buy, and one of them pays for a refusal after being told yes. The
  [second amendment](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md) is the whole
  argument.
- **Buying again at `/buy` is renewing — there is no second call.** A purchase by a payer who
  already holds a slot walks exactly the same path: the handle is read off the roster rather than
  derived again, so the granted prefix and the handle are unchanged; the peering write finds the
  established peering (`"status": "found"`) rather than opening a second channel; the funding tops
  that channel back up to what the hub fronts rather than depositing it again, which is usually
  nothing at all; the routes are
  upserted by prefix rather than duplicated; and the roster holds **one** slot for that payer,
  never two. **The lapse is extended, not reset**: `lapsesAt = max(now, the lapse already held) +
  TOON_SLOT_PERIOD_SECONDS`. Resetting to `now + period` would take back time the broadcaster had
  already paid for and teach everybody to renew at the last minute; extending from the held lapse
  alone would credit a lapsed slot with the months nobody was broadcasting. The `/quote` answers
  the same number the renewal did.
- **A renewal re-reads the station's self-description, so the hub's table matches what the station
  sells today.** A rung added since is routed; **a rung dropped is removed**, with a signed
  `DELETE /routes/peers/:prefix`, because a write is an upsert and nothing about rewriting the
  survivors takes the leavers out. Removing a routing-table row is a **destructive write against a
  table every broadcaster shares** — the other one is the lapse's — and it is fenced twice: the candidates are read off the hub's own `GET /routes/peers` (bearer-gated,
  `source: "runtime"` only — a config row is the operator's and the connector answers `409`) and
  filtered to rows **at or beneath the caller's granted prefix**, and the only function that issues
  the `DELETE` re-checks that fence itself. A `404` is a success: the row is already gone, which is
  the state that was asked for. Removal happens **after** the writes, so a rung is never briefly
  unreachable mid-renewal. **This is the app's only use of the operator bearer token, and it is a
  read.**
- **Every route price is derived from the station's own connector, never declared by the buyer.**
  The hub `GET`s the station connector's self-description (connector ADR 0050) at the URL in the
  body — `ilpAddresses`, `httpEndpoint`, `settlements`, and **`routes`, each `{prefix, price,
  pricePerKib?}` with prices as decimal strings of base units** — and writes one forwarded route per
  published prefix at **that price plus `TOON_PEERING_FEE`**. That sum is arithmetic, not policy:
  the hub's connector charges the route price at its client edge and retains the peering's flat fee,
  so `price - fee` reaches the station, and the station's connector checks per packet that a
  peer-wire arrival covers its own termination price (connector ADR 0029). A hub route priced any
  lower forwards into an `F03`. A published `pricePerKib` crosses the hop untouched, because a fee
  is flat per packet and does not gain a slope. Prices are held as `bigint` end to end — a `u64` of
  base units rounded through a double is a route priced under the station's own termination.
  **Only prefixes at or beneath the granted one are routed**, so the app can never point somebody
  else's address at a station; a station publishing nothing beneath its grant has not written its
  quoted prefix into its own `connector.toml` and is refused before any operator write.
- **Operator writes are RFC 9421-signed, and this app holds the fleet's only TypeScript
  implementation of that.** `packages/slot-app/src/operator/write-signature.ts`, held to the
  verifier it targets (`crates/connector-operator/src/rfc9421.rs` in the connector, and
  `docs/operators/sign-write.sh` beside it): `Content-Digest: sha-256=:<base64 of SHA-256(body)>:`
  binding the signature to the body; a base over exactly `@method`, `@path`, `content-digest`, then
  `@signature-params` carrying `created`, `expires`, `keyid` and `alg="ed25519"`; signed as **one
  string with PureEdDSA**, since Ed25519 hashes its own input (so `crypto.sign(null, …)` — a named
  hash there is Ed25519ph and never verifies). **An accepted signature is spent**: the verifier
  keys its replay cache on the signature bytes and ed25519 is deterministic, so the signer **waits
  for the clock** rather than re-emitting a base it has already signed. `created` is never pushed
  into the future to dodge that wait — it is a claim about when a hub wrote to its own routing
  table, and the connector retains it as the audit record.
- **The operator write key file is a 32-byte ed25519 seed as 64 hex characters** — exactly what
  `openssl rand -hex 32` writes — wrapped at use time in the fixed Ed25519 PKCS8 DER prefix.
  `keyid` is its **public** half, hex, which is the value on the connector's `write_keys`
  allowlist and the one thing about that credential the app prints at boot. A file that is not a
  seed is a **refusal to start**, because finding out at the first purchase costs a broadcaster the
  slot price. `credentials.ts` still only reads and trims; decoding belongs to the code that signs.
- **A slot nobody renewed lapses, and the hub takes it back out itself.** A ticker walks the roster
  every `TOON_LAPSE_SWEEP_SECONDS` and tears down everything past its lapse time, **with no request
  needed to trigger it** — a teardown that only happened when somebody else bought would leave a hub
  carrying its last dead station for ever. Per lapsed slot, in this order and no other: **every
  route out first** (one signed `DELETE /routes/peers/:prefix` each), **then the peering released**
  (one signed `DELETE /peers/:id`), **then the slot off the roster**. The first ordering is the
  connector's rule, not a preference — it refuses to remove a runtime peering while a runtime route
  still forwards to it (`PeerRouteTableError::PeerInUse`, a `409`), so the other order is a teardown
  that stops half-way through. The rows selected are the union of both ownership proofs: **at or
  beneath the granted prefix**, or **forwarding to that slot's own peering label** — because the
  connector's referential rule is keyed on the label while the fence a grant provides is keyed on
  the prefix, and a teardown has to satisfy the first while staying inside the second. Releasing the
  peering **stops the carriage and does not bring the collateral back** — the deposit stays in the
  channel until somebody closes and settles it, and nothing in this app does either; a hub operator
  reclaims it by hand ([ADR 0003's third
  amendment](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)). The roster row goes **last**: a slot on the roster
  is the hub's claim that routes and a peering behind it may still exist, so a teardown that failed
  leaves the slot standing, logs it, and the next sweep tries again — never a peering the hub has
  forgotten it is funding. The **first sweep is one interval after boot, never at boot**: tearing
  down what lapsed while the process was down needs the connector's own tables read first, so it is
  the boot reconciliation below that does it, using this same `sweep()`.
- **The roster is durable and read back at boot.** It lives in `TOON_DATA_DIR`, is written whole
  through a temporary file that is flushed and renamed over, and `record` returns only once the
  slot is on disk. A roster the app cannot read is a `SlotRosterError` and a non-zero exit, never a
  silent start from empty: a hub that re-admitted everybody it already holds would front the
  collateral twice and lapse nothing it promised. A slot also records **what it was granted** — the
  station URL the purchase named, the chain the connector stated, and every address written with
  the price it was written at (decimal strings, because a `u64` through a double is a route priced
  under the station's own termination). That is not the connector's table restated: it is what the
  broadcaster *bought*, which is the only thing that can say whether what the hub is carrying is
  right. Without it, a boot that found a row missing could only re-read the broadcaster's own
  connector — and a station that happened to be down while its hub rebooted would lose the
  addresses it had already paid for. **It also records the payment channel the hub funded for that
  broadcaster and what is in it** (a decimal string, for the same reason a price is): the hub's own
  capital is in that channel, a lapse leaves the deposit where it is, and nothing else in the app
  remembers which one — so this is what a reclaim, and a hub operator reading their own roster,
  have to act on. The five fields are optional on disk, so a slot recorded
  before they existed still reads; such a slot is left alone until its next renewal records them.
- **At boot the app reconciles the connector's own tables against the roster**, before the port
  binds and before it can take a purchase (`packages/slot-app/src/reconcile/reconcile.ts`). In
  order: **read** the hub's own `GET /peers` and `GET /routes/peers` over the bearer-gated read
  surface; **tear down what lapsed while the process was down**, through the lapse's own `sweep()`
  and therefore in the lapse's own order, because *downtime must not extend anybody's slot*;
  **write back** what a live slot bought and the connector is not carrying — the peering
  re-established first where it is gone, since a route cannot forward to a peering the table does
  not hold, **and its channel funded on the buy's own terms** before any route points at it, then
  every granted address the table is missing, points at the wrong peering, or holds
  at the wrong price; and **take back out** every row the roster does not hold, routes before the
  peering, through the same `withdrawForwardedRoutes` and `releasePeering` a lapse uses. It
  **never throws**: a hub whose own connector is still coming up boots anyway, says so, and
  reconciles next time — the ticker still lapses what is past its time, and a renewal still
  rewrites its own rows.
- **The removals at boot are fenced three times, and each fence stands alone.** "The connector
  holds what the roster does not" is, read literally, an instruction to delete the hub operator's
  own rows, so: **source** — only a row the connector itself reports as `runtime` is ever a
  candidate, and a `config` row is never *asked* about, because a fence that consists of being
  refused a `409` is not a fence; **shape** — only a label this hub could itself have derived
  (`isHandleLabel`, twelve to sixty-four lower-case hex, the suffixed form included) and only a
  prefix inside the address space that label is granted, so `g.hub.demo` and a hand-written
  `apex-relay-2` are both none of this app's business; **the roster** — only a label no live slot
  holds. Both the source fence and the shape fence have a test that fails when it is removed.
- Configuration: `--slot-port`/`TOON_SLOT_PORT`, `--host`/`TOON_SLOT_HOST`,
  `--data-dir`/`TOON_DATA_DIR`. Port `0` binds an ephemeral port, which is how the suite runs slot
  apps side by side. **The port is configuration, not a constant.**
- **The hub's admission policy is configuration too, all of it**: `--hub-address`/`TOON_HUB_ADDRESS`
  (default `g.toon.slopmachine`), `--slot-price`/`TOON_SLOT_PRICE` (default `1000000`),
  `--slot-period-seconds`/`TOON_SLOT_PERIOD_SECONDS` (default `2592000`, thirty days) and
  `--slot-cap`/`TOON_SLOT_CAP` (default `100`). Admission is a price, not a judgement, so those
  numbers *are* the policy and changing one must never be a code change. A cap of `0` is a legal
  setting and means the hub is admitting nobody. The period is in **seconds** because that is what
  makes a lapse testable without a fake clock, the same way `--ingest-idle-seconds` is. Every one is
  validated fail-closed at boot — a `SlotPolicyError` and a non-zero exit, never a degraded run.
  **The cap is a hard bound**: the buy refuses a new slot at it, and a renewal never is.
  `--lapse-sweep-seconds`/`TOON_LAPSE_SWEEP_SECONDS` (default `60`) is how often the roster is
  walked for lapsed slots — the *granularity* of the lapse, not its length. There is deliberately no
  value that turns the sweep off, and `0` is a `LapseError` and a non-zero exit: a hub that never
  reclaims a dead station's peering only ever commits more collateral.
  **`--slot-price` is not payment code**: it is what the quote *reports* so a broadcaster learns the
  cost before buying, and it is the floor the buy will check the connector's own stated
  `X-TOON-Amount` against. Charging is the connector's job, so `TOON_SLOT_PRICE` and the hub's
  `connector.toml` buy route are **one pair**, changed in one commit.
- **The hub's peering policy is configuration too**: `--operator-url`/`TOON_OPERATOR_URL` (the hub
  connector's own base URL, where the peering is written — **required, no default**, on the same
  terms as the credentials, because an app that cannot reach an operator surface can admit nobody),
  `--peering-fee`/`TOON_PEERING_FEE` (default `20`),
  `--peering-max-packet-amount`/`TOON_PEERING_MAX_PACKET_AMOUNT` (default `10000000`) and
  `--peering-collateral`/`TOON_PEERING_COLLATERAL` (default `50000000`). The last three
  are the hub's own terms about a counterparty and are unreachable from any request — a broadcaster
  never chooses how far the hub trusts them, or how much capital a hub commits for them.
  **The collateral is the figure `TOON_SLOT_CAP` multiplies**, which is what makes the cap bound an
  amount rather than an intention: establishing a peering *opens* a payment channel and does not fund
  one, so a hub's balance-sheet commitment is those two numbers together. There is deliberately no
  value meaning "front nothing" — `0` is a `PeeringPolicyError` and a non-zero exit, because a
  channel holding nothing carries nothing, and a hub that means to commit no capital sets its cap to
  zero instead. The carriage fee is **one placeholder in three places** — the code default,
  `deploy/hub/`'s `HUB_PEERING_FEE`, and `docs/placeholder-numbers.md` — and they agree. **The operator URL is configuration, not an injected
  port**: the suite points it at a fake operator surface
  (`packages/slot-app/src/operator/fake-operator-surface.ts`) that verifies the RFC 9421 signature
  and the `Content-Digest` for real against an allowlisted public key, refuses an unsigned write,
  refuses a replayed signature and records what was written — so the buy's assertions are about
  what the hub's routing table holds, never about which function was called. **Do not add an
  injected port to `startSlotApp`'s own API for it.** The read side has the same shape and the same
  rule: the `stationUrl` a purchase carries is pointed at a **fake station connector**
  (`packages/slot-app/src/peering/fake-station-connector.ts`) serving a real self-description with a
  real ladder at real prices, so route prices are *derived from a document* in the suite exactly as
  they are on a hub — never stubbed.
- **The hub's two operator credentials are the exception with no default, and both are named by path
  only**: `--operator-write-key-file`/`TOON_OPERATOR_WRITE_KEY_FILE` for the ed25519 write key whose
  public half sits on the connector's `write_keys` allowlist, and
  `--operator-bearer-token-file`/`TOON_OPERATOR_BEARER_TOKEN_FILE` for the bearer token that gates
  reads. **There is no flag and no environment variable carrying either literal** — a command line is
  world-readable on the box and an image's environment is readable from its metadata. **The app
  refuses to start without either and says which one**, because a hub that cannot admit anybody must
  look broken rather than look fine. Neither value is ever logged, echoed, put in an error message,
  or present on `SlotAppInstance.config`; the two *paths* are, because an operator fixing a bad mount
  needs to know which file was read. Both filenames an operator is told to create
  (`operator-signing.key`, `operator-bearer.token`) are covered by `.gitignore` and `.dockerignore`
  — by wildcard and, since #40, **by name as well**.
  **The seed on the box is `operator-signing.key`, not `operator-write.key`.** On a hub both it and
  the connector's `operator-write.keys` — the allowlist of **public** halves that an operator
  hand-edits to revoke authority (connector ADR 0008) — live in one directory, and two files one
  character apart, one a secret and one an editor's file, is the affordance
  [this repo's own hazard section](#this-repo-is-public-and-will-hold-key-material-on-live-boxes)
  is about. The environment variable is still `TOON_OPERATOR_WRITE_KEY_FILE`: it names the path, and
  the path is what changed.
- **A station connector is read over `https` only, unless a hub says otherwise.** The buy's fetch of
  the URL a purchase named is the one request either app in this repo makes to a destination a
  stranger chose, so it is bounded on every axis: one attempt, a 10s whole-exchange budget, a 64 KiB
  cap, no redirect followed, and no plaintext.
  `--allow-plaintext-station-urls`/`TOON_ALLOW_PLAINTEXT_STATION_URLS` defaults **`false`** — the
  same name and the same default as the connector's own `peer_allow_plaintext_endpoints`, which is a
  loopback-and-test opt-in there too. A station configured the way `deploy/README.md` says publishes
  an `https` endpoint, so a public hub never meets the refusal; the suite and
  `deploy/hub/docker-compose.local.yml` turn it on, because neither has a certificate anywhere. It
  is **not a new refusal at a paid address**: a plaintext URL is answered with the `502
  station_unreadable` that address already has, which is what it is — the hub declining to read the
  caller's node — and it is decided before a socket is opened. Only `"true"` and `"false"` are read;
  anything else is a `PeeringPolicyError` and a non-zero exit.

**The slot app contains no payment code**, and it does not become the exception to the invariant
below just because it is the app that reaches back into a connector's operator surface: no claim
validation, no settlement key, no payment-header parsing, no pricing logic.

The hub deploy bundle is [`deploy/hub/`](deploy/hub/) (#40) — see
[the deploy bundles](#the-deploy-bundles) below. The **complete surface a hub's `connector.toml`
has to agree with** is four paths on the app port: `/quote` and `/buy` are **priced**, each strictly
beneath its own prefix and never the other's; `/health` and `/roster` are **unpriced and must never
be routed at all**. [`deploy/hub/bundle.test.ts`](deploy/hub/bundle.test.ts) (#41) is what holds
that still, and it is the one guard in this repo that does not compare two literals: connector ADR
0067 assigns the check that a declared `request` shape matches what the app serves to **the app's
own repository**, so the guard **boots the real slot app** and speaks HTTP at it — the declared
method reaches the declared path, no other method does, the declared body key is the one the buy
actually reads, and `/health` and `/roster` are addresses the app really serves, which is what makes
"give them no route" a rule about something rather than a rule about nothing.

**A signer that outlives its own process.** The connector's replay cache keys on the signature
bytes and ed25519 is deterministic, so an identical base is an identical, already-spent credential
— and that cache lives in the connector, which does not restart when the app does. Boot
reconciliation repeats exactly the writes the previous process may just have made, so
`write-signature.ts` treats **the second a signer was built in as already spent**: nothing the
predecessor signed can carry a `created` later than that, so the first write of a process signs at
the next second onward. The cost is bounded and paid once — at most one second, on the first write
only — and `write-signature.ts`'s own suite proves a chain of fresh signers never repeats a
signature.

**Vocabulary is enforced by a test, not only by prose.**
`packages/slot-app/src/slot-app/vocabulary.test.ts` reads the package's own source: `src/slot/` and
`src/quote/` name no peer and no channel in code — with **one named identifier exempt and no other**,
`channelId`, because a slot records the channel the hub funded for that broadcaster and the exemption
is pinned by a block of its own — `src/peering/` names no slot and no roster, and
**nothing anywhere fuses the two words** into a `slotPeering`, a `peer_slot` or a `slot-peering`.
`src/buy/`, `src/lapse/`, `src/reconcile/` and `src/slot-app/` are the only modules exempt from the
first two rules, because being the join between a slot and a peering is what they are for: the buy
makes them, the lapse ends one and releases the other, the reconciliation makes the record of the
first agree with the table of the second, and the app wires all of it up. **The exemption is named
rather than inferred**: a fifth block asserts the exact set of directories under `src/`, so a new
module cannot quietly become a fifth exemption by being new.

### The deploy bundles

**THREE bundles ship from this repository, and they are siblings, not variants.**
[`deploy/`](deploy/) runs a **station** node, [`deploy/hub/`](deploy/hub/) runs a **hub** node, and
[`deploy/devnet/`](deploy/devnet/) runs **both at once, on a local chain**. The first two take the
fleet's house bundle shape, the same one `relay` and `store` ship: a `docker-compose.yml`, a
bind-mounted `connector.toml`, a `Caddyfile`, a local overlay, a Watchtower overlay, and an
`auto-apply.sh` + systemd pair that follows `main` on a box. `deploy/README.md` walks a broadcaster
from DNS to `docker compose up -d` to OBS; `deploy/hub/README.md` walks a hub operator from DNS to
`docker compose up -d`, including the step everything else depends on — putting the slot app's own
public key on the connector's `write_keys` allowlist.

**The devnet is nobody's box**, which is why its shape differs: no Caddy, no overlays, no systemd,
one compose file, and every `connector.toml`, every key and the station's stream key **generated
per run** into `deploy/devnet/run/`, which git ignores. Nothing in `deploy/` or `deploy/hub/` is
edited or read to make it work — the station bundle's apex is frozen to the `demo` placeholder by
its own guard and both bundles publish the same connector edge port, so a devnet assembled out of
their local overlays would be fighting two guards to prove a third thing. The one thing it does not
write for itself is the connector build: `DEVNET_CONNECTOR_IMAGE` is a required variable with no
default, and the driver reads the pin of record out of `deploy/docker-compose.yml` and passes it
in, so there is no third copy to drift. It is driven by `pnpm test:devnet` and `pnpm demo` and by
nothing else — the run that proves the paid path and the one that lets a person watch it — see
[the devnet](#the-devnet) below.

Their **ports invariants are different numbers on purpose**, and the difference is the whole
distinction between the two nodes:

| Bundle           | Published ports                                                    | Why                                                                       |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `deploy/`        | **three** — Caddy's 80 and 443, plus the origin's RTMPS ingest 1935 | stock Caddy does not speak RTMP, so a station fronts its own uplink        |
| `deploy/hub/`    | **two** — Caddy's 80 and 443, and nothing else                      | **a hub carries no vibes of its own**, so it has no uplink to front        |
| `deploy/devnet/` | **none off-box** — four loopback publishes: three for the driver, one for the broadcaster's own OBS | there is no public name and no certificate on a laptop, so nothing is fronted |

**No RTMP port, service or path appears anywhere in the hub bundle**, and none may: a hub is never a
station. In both bundles the connector's client edge is published on `127.0.0.1` only, and every app
port is `expose:` and nothing else — the origin's 3100, the slot app's 3200, and the relay's 3100
and 7100. The rule that holds across all of it is **Caddy owns the only unqualified publishes, in
every file set an operator is told to run**; the hub's local overlay adds one loopback-qualified
publish (the relay's free reads, 7100) because with Caddy dropped nothing else would reach them.

**The hub's own routes.** `deploy/hub/connector.toml` terminates four, each declaring its `request`
shape (connector ADR 0067, which assigns the check that a declared shape matches what the app serves
to the app's own repository — this one):

| ILP prefix                              | Price     | Handler URL                         | Declared request                     |
| --------------------------------------- | --------- | ----------------------------------- | ------------------------------------- |
| `g.toon.slopmachine.slot.quote`          | `50`      | `http://slot-app:3200/quote`        | `GET`, no body                        |
| `g.toon.slopmachine.slot.buy`            | `1000000` | `http://slot-app:3200/buy`          | `POST` json, body `{ stationUrl }`    |
| `g.toon.slopmachine.announce`            | `1`       | `http://relay:3100/write`           | `POST` json, body `{ event }`         |
| `g.toon.slopmachine.announce.ephemeral`  | `0`       | `http://relay:3100/write-ephemeral` | `POST` json, ephemeral kinds only     |

The quote and the buy sit beneath **different** prefixes and always must, or one is reachable at the
other's price; `/health` and `/roster` have **no route there and never may**, which is what keeps a
hub operator's roster of every admitted broadcaster off the internet and off sale. `TOON_SLOT_PRICE`
and the buy route's price are **one pair**, and so are `TOON_HUB_ADDRESS` and the apex all four
prefixes are written beneath — the app grants prefixes under that address, so a hub whose app and
connector disagree about its own name writes routes nobody addresses. The **relay's published
image** is the announcement surface: a station being *reachable* is what the slot routes sell, and a
station being *found* is what the announcement carries. This repo publishes no relay image and only
pulls one.

**Each bundle has its own guard, and they are siblings.**
[`deploy/bundle.test.ts`](deploy/bundle.test.ts) guards the station's,
[`deploy/hub/bundle.test.ts`](deploy/hub/bundle.test.ts) the hub's, and
[`deploy/devnet/bundle.test.ts`](deploy/devnet/bundle.test.ts) the devnet's. All three read the
**real** committed files rather than fixtures, check **every file set a bundle is run with** rather
than only the base compose file, and keep **every expected value a literal in the test** — so a
reverted fix fails the suite instead of quietly agreeing with itself. `vitest.config.ts`'s include
list reaches `deploy/*.test.ts`, `deploy/hub/*.test.ts` and `deploy/devnet/bundle.test.ts`, so all
three run in `pnpm test` with no Docker daemon; the devnet's is named by FILE rather than by glob
because the devnet DRIVER lives in that same directory and does need one. The two things a hub
guard adds over a station's: it fails on **RTMP anywhere at all** — port, service, path, or a
directive naming the protocol — because a hub carries no vibes of its own and has no uplink to
front; and it boots the real slot app to check the declared `request` shapes against the surface
actually served. What the devnet's adds over both: the compose file's generated mounts and the
driver's own manifest are held **to each other**, because a bind mount with no file behind it is
created by the daemon as a *directory*; the only binary a run may execute is `docker`, structurally
(only `compose.ts` may import `node:child_process`), which is what makes "no Foundry, no Rust, no
submodules" a fact about the driver rather than about its current contents; and the payer is held
to being a devnet-only development dependency at an exact version, in neither package's manifest
and named by no file under `packages/`.

**Connector configuration is bundle work, not application code.** `deploy/connector.toml` terminates
**five routes** — one per rung at that rung's price, plus one for the station's *now* at its own low
price:

| ILP prefix                      | Price  | Handler URL                         |
| ------------------------------- | ------ | ----------------------------------- |
| `g.toon.slopmachine.demo.now`   | `50`   | `http://origin:3100/now`            |
| `g.toon.slopmachine.demo.audio` | `200`  | `http://origin:3100/segments/audio` |
| `g.toon.slopmachine.demo.480p`  | `1000` | `http://origin:3100/segments/480p`  |
| `g.toon.slopmachine.demo.720p`  | `2000` | `http://origin:3100/segments/720p`  |
| `g.toon.slopmachine.demo.1080p` | `3500` | `http://origin:3100/segments/1080p` |

`demo` is a placeholder for the broadcaster's own handle. Each `handler_url` is a path the origin's
addresses sit **strictly beneath** — an envelope's target resolves under the route's handler path and
can never replace any part of it (connector ADR 0025) — so no address is reachable at another
address's price, and `/health` and `/encode` are reachable at no price at all because they have **no
route here and never may**. Never point a route at the bare origin or at `/segments`: the first puts
the diagnostics on sale, the second makes every rung cost the same. **`per_kib` is never set on a
station route** (ADR 0002) — every station price is flat per segment and the slope is always zero.
[`deploy/bundle.test.ts`](deploy/bundle.test.ts) holds all of that still: it is the guard, it reads
these real files rather than fixtures, and every value it expects is a literal in the test.

`TOON_RUNGS` in `docker-compose.yml` and the routes in `connector.toml` are **one pair**: a rung with
no route is unsellable, and a route naming a rung the origin does not offer is a paid 404. Change one
and change the other in the same commit.

The connector is the **stock GHCR image on an immutable pin**, and that pin appears in exactly two
places, one per bundle: `deploy/docker-compose.yml`'s and `deploy/hub/docker-compose.yml`'s
`connector.image`. **Both must name the same build** — `deploy/bundle.test.ts` fails on a third site
and on a disagreement between the two, because two copies that drift are how an operator deploys one
connector while reading about another. This repo publishes no connector image.
`connector.toml` is bind-mounted, never baked, so the pin and the config it was validated against
reach a box in one `git pull`. The stream key and the RTMPS private key are mounted files, gitignored
and never in an image. `.dockerignore` excludes them from the **build context** by the same wildcards
`.gitignore` uses — `docker-compose.local.yml` builds with `context: ..`, so a key beside the bundle
is otherwise one `COPY . .` away from a published image — and `pnpm test:image` proves it by building
with dummy keys planted and looking inside the result.

### The devnet

[`deploy/devnet/`](deploy/devnet/) is the third bundle and the only place in this repository where
both node shapes are described together: one compose project holding **a chain, a hub connector with
its slot app, and a station connector with its origin**. It exists because both apps were finished
and neither had ever been paid, and because that gap was hiding a defect — establishing a peering
*opens* a payment channel and does not fund one, so a broadcaster who paid the slot price was peered,
routed, on the roster, and carrying nothing. `pnpm test:devnet` is the thing that would have caught
it on the first pull, and now does.

**Two commands, and no way to run it by hand.** There is no `docker compose up -d` recipe: the chain
has to be up and the settlement contracts deployed before either connector will boot — both are
fail-closed on their settlement configuration — and every credential and both `connector.toml` files
are generated per run. The prerequisite is **Docker and this repository's own toolchain, and nothing
else**: no account, no faucet, no testnet, no real money, and no Foundry, Rust or submodules. anvil
runs in a digest-pinned image, and the settlement contracts are **replayed with `viem`** from the
trimmed `{abi, bytecode}` artifacts in [`deploy/devnet/contracts/`](deploy/devnet/contracts/) — the
`swap` repo's approach, taken over a `forge script` (which needs a contracts tree and two submodules)
and over a vendored `anvil --dump-state` snapshot (coupled to the anvil version, and its mock token
has no `mint`, which a devnet that must fund a viber needs). The addresses are **asserted** against
the deterministic ones the fleet commits, so a configuration copied from a sibling repo is either
right here or loudly wrong.

**What a run walks, in order:** the chain and the contracts; every credential and both configurations
generated; both nodes up and each asserted to describe itself; a broadcaster's vibes going in over
RTMP, pushed by the ffmpeg inside the origin's own image so no image is introduced to encode with;
the documented broadcaster order **executed rather than described** — a paid quote, the station
re-rendered at the granted prefix, a restart — with the purchase attempted *before* that too, so the
`502 station_not_at_prefix` refusal is exercised and its cost is asserted; the buy, its answer
compared against what the hub's own routing table actually holds; **the funded channel asserted on
chain**; a viber's own channel, the station's *now* bought across the hop, and a segment at each of
two rungs compared **byte for byte** against what the station holds; the fee arithmetic nobody's code
enforces; and the money — the station's claim advanced by exactly its own price per pull, the
difference from what the viber paid being exactly the hub's carriage, and the claim **redeemed on
chain against a still-open channel**, with the token balance asserted to have moved.

**`pnpm demo` is the same topology with a person in it**, and it is the other half of why the devnet
exists: `pnpm test:devnet` is the *evidence* — every value it expects is a literal, it asserts the
money on chain, and it goes red — and it is not a thing anybody can watch. The demo asserts nothing.
It shares the setup, the credentials and the paid requests
([`deploy/devnet/paid.ts`](deploy/devnet/paid.ts), extracted so that "how a slot is bought" has one
implementation rather than two that drift silently), and differs in exactly two ways: **the vibes
come from the broadcaster's own OBS**, and nothing is torn down after the purchase. It walks the
same order, prints the Server and Stream Key pair OBS asks for, and then a **viber** — a different
party with its own channel — buys `/now` and every segment as it plays, at both rungs, for as long
as it is left running. A page on loopback shows the picture arriving, what each rung costs, how that
splits between the broadcaster and the hub **derived from the two nodes' own published prices**, and
a button that redeems the station's newest claim on chain while the channel stays open. Ctrl-C
prints what was paid and tears everything down. `--pattern` swaps OBS for the run's own ffmpeg test
pattern, so it still runs with nobody at the keyboard.

**No playlist is served from a station, so the demo synthesizes one.** Every `.ts` file
[`deploy/devnet/player.ts`](deploy/devnet/player.ts) writes into its rolling window arrived as the
body of a fulfilled packet that spent a claim — a file there is a receipt. That is the client
daemon's job on a real viber's machine, and the daemon is not in this repo and cannot be, so this is
the smallest thing that stands where it stands, bound to loopback and taking no setting that could
move it.

**The devnet publishes the station's ingest port on loopback, and that is the one publish that is
not the driver's.** It is what OBS connects to, on the same `rtmp://127.0.0.1:1935/live` plus stream
key pair the shipped station bundle offers the same party. It is **not** a fourth free door and the
distinction is the whole reason the other two ports stay unpublished: ingest is authenticated on the
stream key, checked before a byte is transcoded, and it is the unpaid direction by design, so there
is nothing behind it to get for free. **The slot app's 3200 and the origin's segment port 3100 are
still published on no interface, in any form, not even on loopback** — they hand out the very things
a viber and a broadcaster are supposed to pay for and have no key on them, and
[`deploy/devnet/bundle.test.ts`](deploy/devnet/bundle.test.ts) fails on either.

**The payer is [`toon-client`](https://github.com/toon-protocol/toon-client)**, pinned to an exact
release and a **development dependency of the devnet only** — a dependency of neither package, in no
published image, imported by nothing under `packages/`. Neither app here may hold payment code, which
is exactly why the payer comes from outside; and the connector's own `send` verb cannot stand in,
because it originates through a node's operator surface and bypasses the claim gate entirely. The
invariant is unchanged: **no app in this repo contains payment code, and the devnet is not an app.**

**No credential literal enters this repository, anvil's own included.** The chain's account zero is
derived from the mnemonic anvil prints on every start; everything else is fresh material per run in
`deploy/devnet/run/`. The one write a run signs is the broadcaster's own redemption, with the seed
whose public half is the only line in the station's allowlist — signed by the **slot app's own** RFC
9421 implementation, which is the fleet's only one in TypeScript, so a run never has a second
implementation to be wrong.

A failed run prints every node's logs before tearing anything down, and teardown removes containers,
networks **and volumes**, so a second run starts where the first did.

**CI and the published images.** `.github/workflows/ci.yml` is the gate — `pnpm lint`, `build`,
`typecheck`, `format:check` and `test` on every PR and every push to main, plus **one image-build
job per published image** (the origin's is where `pnpm test:image` also runs, because it is the job
with a Docker daemon and the planted key material), **a `devnet` job that runs `pnpm test:devnet`**,
and the fleet's shared no-op merge guard, all aggregated into one required `CI OK` check. An image-build job exists because its publish workflow
runs only on push to main: without it a Dockerfile that cannot build would be found after merge,
with `:release` left pointing at the previous build. **A job added to that workflow must be added to
`ci-ok`'s `needs:`** — the aggregate is the single required context, and a red non-required check is
only a warning on the merge button.
The suite encodes for real, so that workflow installs `ffmpeg` (which brings `ffprobe`) on the
runner; `openssl`, which the ingest-TLS suites shell out to, is already on the GitHub image.
`.github/workflows/publish-station-origin-image.yml` and
`.github/workflows/publish-slot-app-image.yml` publish `ghcr.io/toon-protocol/station-origin` and
`ghcr.io/toon-protocol/slot-app` on every merge to main, each moving `:latest` and `:release` and
keeping an immutable `:sha-<short>` tag. `:release` is what `deploy/docker-compose.yml` defaults to
and what the Watchtower overlay follows, so `docker compose up -d` on a fresh box pulls a real
image. This repo publishes those two app images and no others — never a connector.

**What is still design:** the slot app boots, quotes, sells a slot, peers, **funds the channel that
peering opened**, routes, renews, lapses,
reconciles at boot and shows the operator its roster; `deploy/hub/` deploys all of it
([#40](https://github.com/toon-protocol/slop_machine/issues/40)); and
[`deploy/hub/bundle.test.ts`](deploy/hub/bundle.test.ts)
([#41](https://github.com/toon-protocol/slop_machine/issues/41)) holds its ports, its routes and its
declared request shapes still, the way
[`deploy/bundle.test.ts`](deploy/bundle.test.ts) holds the station's. **Epic
[#32](https://github.com/toon-protocol/slop_machine/issues/32) is complete** — all nine of #33–#41
are merged. Epic [#51](https://github.com/toon-protocol/slop_machine/issues/51) then made the
hub's collateral configuration ([#52](https://github.com/toon-protocol/slop_machine/issues/52)),
made the buy **fund the channel it opened**
([#53](https://github.com/toon-protocol/slop_machine/issues/53)) — which is what the fulfill had
always claimed and never done — had the slot record that channel
([#54](https://github.com/toon-protocol/slop_machine/issues/54)), and built **the devnet node**
(#55–#61). **There is one now**, and it is what proved the rest: `pnpm test:devnet` brings a hub and
a station up on a local chain and ends with a viber having paid for a broadcaster's vibes across the
hop and the broadcaster having redeemed the money on chain. **`pnpm demo` is that same topology with
a person in it** — point OBS at the station, and a page on loopback plays your own broadcast back
one paid packet at a time. Do not infer other commands from the sibling repos.

What does exist, all run from the repo root:

```
pnpm install
pnpm build       # bundles every package to its own dist/ (dist/cli.js is each entrypoint)
pnpm test        # vitest: boots the real origin on fresh ports, pushes real RTMP at it, and
                 # pulls the encoded segments back over HTTP, and boots the real slot app on
                 # fresh ports against a temporary directory. Deliberately slow — real encoding
                 # is the point, because ADR 0001 is a claim about bytes. The include list is
                 # packages/*/src/**/*.test.ts, so a new package's suites are picked up with
                 # no change here; it also covers deploy/*.test.ts, deploy/hub/*.test.ts and
                 # deploy/devnet/bundle.test.ts, so each bundle's guard runs beside the files it
                 # guards; smol-toml and yaml are there to read them
pnpm test:devnet # vitest, opt-in and NOT part of `pnpm test`: brings up deploy/devnet/ — a chain,
                 # a hub and a station — replays the settlement contracts onto anvil, generates
                 # every credential and both connector.toml files, pushes real vibes in over RTMP,
                 # and drives the whole documented path: quote, configure, restart, buy, the funded
                 # channel asserted ON CHAIN, a viber paying for segments at two rungs, the fee
                 # arithmetic, and the broadcaster redeeming on chain. Needs a Docker daemon and no
                 # Foundry, Rust or submodules; tears everything down, volumes included, and dumps
                 # every node's logs on a failure. deploy/devnet/bundle.test.ts holds the topology
                 # still and runs in `pnpm test` with no daemon at all
pnpm demo        # NOT a test and asserts nothing: the same topology with a person in it. Brings
                 # deploy/devnet/ up, walks quote/configure/restart, buys the slot, prints the OBS
                 # Server and Stream Key pair, and then leaves a viber buying /now and every segment
                 # at both rungs while a page on 127.0.0.1:8088 plays them back — the spend, the
                 # split between broadcaster and hub, and a button that redeems on chain. Ctrl-C
                 # prints the receipt and tears it all down. `--pattern` uses the run's own ffmpeg
                 # test pattern instead of OBS, `--port` moves the page. Runs on vite-node, because
                 # the devnet's modules anchor on import.meta.dirname and a bundle has no directory
pnpm test:image  # vitest, opt-in and NOT part of `pnpm test`: plants dummy key material where
                 # deploy/README.md says to generate the real thing, then builds the build
                 # context and EVERY published image and proves none carries it. Needs a Docker
                 # daemon and takes minutes; deploy/bundle.test.ts holds the fast half of that
                 # guard. An image this repo publishes belongs in its PUBLISHED_IMAGES list
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier over packages/*/src/**/*.ts and deploy/**/*.ts — all three bundles
docker build -f packages/station-origin/Dockerfile -t ghcr.io/toon-protocol/station-origin:latest .
docker build -f packages/slot-app/Dockerfile -t ghcr.io/toon-protocol/slot-app:latest .
```

Both image builds take the **repository root** as their context, never the package directory: each
Dockerfile's first `COPY` takes the workspace root's `package.json`, `pnpm-workspace.yaml`,
`pnpm-lock.yaml` and `tsconfig.json`, which is how the frozen install resolves. Each copies only its
own package's manifest — a frozen install resolves against the importers the context actually holds,
so a sibling package missing from it is simply not part of that workspace.

The root `vitest.config.ts` applies **one `define` per package**, each substituting that package's
own version placeholder from its `version-define.ts`. A new package adds a line there rather than
replacing one; without it, that package's `VERSION` falls back to `0.0.0-dev` under the root suite
while its own config gets it right, and only the image's version assertion in CI would notice.

And from `deploy/` (a station) or `deploy/hub/` (a hub), once that bundle's keys and `.env` exist
(see the README beside each):

```
docker compose config                                          # validate the bundle
docker compose up -d                                           # a real node
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d   # local, no TLS
```

`pnpm test` needs `ffmpeg`, `ffprobe` and `openssl` on PATH: ingest is a wire protocol, and a suite
that spoke it through a mock would be testing the mock. The **station origin's image** needs
`ffmpeg` too — the origin owns its encoder, so its runtime stage installs it. The slot app's suite
and image need none of the three: a hub carries no vibes of its own and that app encodes nothing.

Tests assert at the app's boundary only — they boot the real app and speak HTTP and real RTMP at it.
Nothing reaches into the data directory's layout, the RTMP chunk parser, the stream-key comparison,
the segmenter, the `ffmpeg` argument construction, the slot app's credential reading or its roster;
all of them must stay rewritable without touching a test. The slot app's quote suite is the same
shape: a payer goes in as a header and a prefix comes back, and it never learns how one becomes the
other. There are **exactly two deliberate exceptions in the repo**, and each says
why in its own header. `packages/slot-app/src/slot/handle.test.ts`: the collision path it covers
cannot be reached over HTTP until a roster writer exists (#35), it is the path that decides whether
"there is no *that handle is taken* refusal" is true rather than intended, and it would otherwise
run for the first time on a real hub against a broadcaster who paid. It takes the narrowest seam
available — one pure function of a payer key and a predicate — and asserts no digest.
`packages/slot-app/src/operator/write-signature.test.ts`: the guarantee it holds is that a
**restarted** process never re-emits a signature its predecessor spent, and over HTTP that failure
appears only when a restart happens to land inside one second of the write it repeats — a test that
usually passed for the wrong reason. It asserts over the three header values a signer hands out and
nothing else, and `reconcile.test.ts` still covers the same rule end to end by restarting the real
app with no pause at all. The suite's ladder is ordinary configuration — two
small rungs, one of them sound only — so a broadcaster's four real rungs never have to be encoded to
prove the ladder works. **No credential literal belongs in this repository, not even a test's**: the
slot app's suite mints throwaway credentials per boot and mounts them at real files in a temporary
directory, exactly as the origin's suite mints a throwaway stream key.
Replace this section in the same commit that invalidates it.

The design is settled and written down; the open questions the README used to list — which
direction pays, the unit of payment, and how discovery works — are all answered. Vibers pay, per
segment, and stations announce to a hub's relay.

The numbers — slot price, renewal period, hub collateral, the rung ladder — are **placeholders**,
not decisions, and live in [`docs/placeholder-numbers.md`](docs/placeholder-numbers.md). They are
internally consistent and safe to build against; none has been reasoned about economically. Change
one freely, but keep the ladder under ADR 0001's byte bound.

## The invariant that outlives everything else

**No app in this repo contains payment code.** Payment is enforced upstream by the connector; a
request that reaches an app is already proven paid, and the app serves it. This is the same split
`relay` uses, and it is what makes an ordinary HTTP app monetizable without knowing ILP exists.

**All payment-claim validation lives ONLY in the
[connector](https://github.com/toon-protocol/connector) — never re-implement it here.** Pricing a
route is connector config, not application code.

## Two hazards specific to this repo

**The slot app holds an operator write key.** It is the one app in the fleet that reaches back into
its own connector's operator surface, so compromising it means mutating the hub's routing table.
Scope the credential to the writes it needs. Writes are RFC 9421 signature-gated, never
bearer-gated — the app's bearer token is for **reads only**, and do not add a bearer path for a
write for convenience. Both credentials are mounted files named by path, both are required at boot,
and neither value may reach a log line, an error message or `SlotAppInstance.config`.

**A refusal at a paid address is paid for.** The connector fulfills on any complete answer from an
app whatever its HTTP status — a status is envelope content, never a packet outcome — so an app in
this repo cannot decline payment by refusing. Every foreseeable refusal therefore belongs at the
slot app's cheap `/quote`, never at the buy, and adding a new refusal at a paid address is adding a
new way to charge a broadcaster for nothing. This corrected
[ADR 0003](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md), which used to claim a
refusal was free; read its amendment before adding one.

**A segment is bounded to 2 MiB on purpose.** Nothing enforces this: the connector's 2 MiB body
limit is request-only and the response direction has no cap at all. That absence is an open question
upstream, not a guarantee — see
[ADR 0001](docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md) before raising a
bitrate or lengthening a segment.

Related: **do not set `per_kib` on a station route.** A price is a schedule over the *inbound*
payload, so it charges for the request, not the vibes in the fulfill. It will silently do nothing,
and `deploy/bundle.test.ts` fails the build for it rather than letting the symptom show up on a live
box as "revenue is flat and nobody knows why".
Quality is priced per rung, by address ([ADR 0002](docs/adr/0002-bitrate-follows-the-vibers-budget.md)).

## This repo is public, and will hold key material on live boxes

A slopmachine node deploys the standard connector bundle and so generates an ILP signer key,
settlement keys that hold real value, and peering secrets. A station additionally holds its
broadcaster's **stream key** and the private key of its RTMPS certificate; a hub additionally holds
an operator **write key** (`operator-signing.key` on the box) and an operator **bearer token**, both
of which the slot app reads. `.gitignore` already covers these by wildcard (`*.key`, `*.secret`,
`*.pem`) and the operator credentials **by name** before any of them exist — see its comments for
the incidents that shaped those rules.

- **`deploy/hub/` is the one directory where a secret and a hand-edited file have near-identical
  names, so they were made not to.** `operator-signing.key` (singular) is the slot app's private
  seed; `operator-write.keys` (plural) is the connector's allowlist of public halves, which an
  operator opens in an editor to revoke that seed's authority. Naming the seed `operator-write.key`
  would put those two one tab-completion apart. Do not rename it back, and do not add a third file
  in that family without asking what a tired operator at 3am would do with it. Every one of
them is provisioned as a mounted value: never baked into an image, never a default in code, never a
literal in a test. `pnpm test:image` proves that for every image this repo publishes.

- Never commit key material, and never weaken those rules to make a file visible. An ignore rule
  does not protect an already-tracked file: if one lands, `git rm --cached` it **and rotate the
  key** — the rotation is what closes the exposure.
- Do not add a `*.ts` ignore rule. HLS segments are MPEG-TS `.ts` files, which collides with the
  TypeScript extension; generated media is ignored by directory (`segments/`, `recordings/`) for
  that reason. The corollary: `segments/` matches a directory of that name anywhere, so **no source
  directory may be called `segments`** — the origin's segmenter is `src/segmenter/`. Rename the
  source, never the rule.
- **The same collision reaches the toolchain, not only git, and `deploy/devnet/run/` is where it
  bites.** `pnpm demo` writes the segments a viber bought into that directory, and the format
  scripts glob `deploy/**/*.ts` — so `tsc`, `eslint` and `prettier` all tried to parse a broadcast
  as source, and `pnpm format:check` failed by printing binary video into the terminal. That
  directory is generated all the way down (both `connector.toml`s, every credential, and now the
  media), so **it is excluded from all three by directory**: `.prettierignore`, `eslint.config.js`'s
  `ignores`, and `tsconfig.json`'s `exclude`. CI never caught it because CI never runs the demo —
  only a person who had. Add the exclusion in all three or in none; two out of three is a toolchain
  that breaks for whoever ran the demo last.

## Cross-repo dependencies

- **[connector](https://github.com/toon-protocol/connector)** — the paid reverse proxy both apps sit
  behind. Stock GHCR image on an immutable pin, with a bind-mounted `connector.toml`; this repo
  should publish no connector image. It is also the normative authority on vocabulary: where
  `CONTEXT.md` and [`connector/CONTEXT.md`](https://github.com/toon-protocol/connector/blob/main/CONTEXT.md)
  disagree, that one wins.
- **[relay](https://github.com/toon-protocol/relay)** — the reference for putting an ordinary app
  behind the connector, and the hub's announcement surface. `deploy/hub/` runs
  `ghcr.io/toon-protocol/relay:release` unmodified: `TOON_BLS_PORT` 3100 takes paid writes and
  `TOON_RELAY_PORT` 7100 serves free NIP-01 reads, and `NOSTR_SECRET_KEY` — the one environment
  secret in either bundle, because that image offers no file-valued form — is its identity. This
  repo publishes no relay image.
- **[toon-client](https://github.com/toon-protocol/toon-client)** — the payer side. The client
  daemon is built on it, and its keystore is Node-only: there is no browser key management, so no
  part of the client can be a web app.
- **[store](https://github.com/toon-protocol/store)** — where a broadcaster's clips live, so that a
  broadcaster page costs a station node nothing to serve.

## Shared skills, docs & project context → toon-protocol/toon-meta

Cross-cutting agent skills, docs, and the canonical project context live in
**[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**:

```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```

Canonical rules/decisions: `toon-meta` → [`context/context.md`](https://github.com/toon-protocol/toon-meta/blob/main/context/context.md),
with `architecture.md`, `repos.md`, `decisions.md` and `glossary.md` beside it.

## Agent skills

### Issue tracker

GitHub Issues on `toon-protocol/slop_machine`, via the `gh` CLI. See
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).
