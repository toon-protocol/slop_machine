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

## Status: the station origin ingests, encodes, serves and deploys; the slot app boots

This repository is a pnpm workspace with two packages, one per toon app it ships —
`packages/station-origin` (`@toon-protocol/station-origin`) and `packages/slot-app`
(`@toon-protocol/slot-app`). Both take the fleet's house shape, the same one `relay` and `store`
use: TypeScript, Hono over the Node server adapter, bundled to a single entrypoint with
tsup/esbuild, tested with vitest, a `Dockerfile` beside it and an image published to GHCR on merge
to `main`. The slot app is the newer and by far the smaller of the two — see
[the slot app](#the-slot-app) below for exactly what it does today, which is boot.

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
[#33](https://github.com/toon-protocol/slop_machine/issues/33) is what exists, and it is **the boot
and only the boot**.

It takes the origin's shape rather than inventing one: it exports
`startSlotApp(config): Promise<SlotAppInstance>` mirroring `startOrigin`, resolves flags over
environment over defaults the same way, and bundles to `dist/cli.js` behind its own `Dockerfile`.

- `GET /health` on the app port (`TOON_SLOT_PORT`, default `3200`) — process liveness, for a hub
  operator's supervisor **inside** the node. `200 application/json` carrying `{"status": "healthy",
  "service": "slot-app", "version": string, "timestamp": number}`. It requires no payment header and
  reads none. It is **unpriced, has no route on the hub's connector and never may** — the app port is
  published on no interface, so unpriced never means free to the internet. It is not a claim about
  the roster or about the hub's capacity; those are separate addresses and are not written yet.
- Configuration: `--slot-port`/`TOON_SLOT_PORT`, `--host`/`TOON_SLOT_HOST`,
  `--data-dir`/`TOON_DATA_DIR`. Port `0` binds an ephemeral port, which is how the suite runs slot
  apps side by side. **The port is configuration, not a constant.**
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
  (`operator-write.key`, `operator-bearer.token`) are already covered by `.gitignore` and
  `.dockerignore` wildcards.

**The slot app contains no payment code**, and it does not become the exception to the invariant
below just because it is the app that reaches back into a connector's operator surface: no claim
validation, no settlement key, no payment-header parsing, no pricing logic.

The quote, the buy, the peering, the routes, the roster, the lapse, the boot reconciliation and the
hub deploy bundle are #34 onward and **do not exist**. There is no `deploy/hub/`.

### The deploy bundle

[`deploy/`](deploy/) is the fleet's house bundle shape, the same one `relay` and `store` ship:
`docker-compose.yml` (Caddy → connector → origin), a bind-mounted `connector.toml`, a `Caddyfile`, a
local overlay, a Watchtower overlay, and the `auto-apply.sh` + systemd pair that follows `main` on a
box. `deploy/README.md` walks a broadcaster from DNS to `docker compose up -d` to OBS.

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

The connector is the **stock GHCR image on an immutable pin**, and that pin appears in exactly one
place — `deploy/docker-compose.yml`'s `connector.image`. This repo publishes no connector image.
`connector.toml` is bind-mounted, never baked, so the pin and the config it was validated against
reach a box in one `git pull`. The stream key and the RTMPS private key are mounted files, gitignored
and never in an image. `.dockerignore` excludes them from the **build context** by the same wildcards
`.gitignore` uses — `docker-compose.local.yml` builds with `context: ..`, so a key beside the bundle
is otherwise one `COPY . .` away from a published image — and `pnpm test:image` proves it by building
with dummy keys planted and looking inside the result.

**CI and the published images.** `.github/workflows/ci.yml` is the gate — `pnpm lint`, `build`,
`typecheck`, `format:check` and `test` on every PR and every push to main, plus **one image-build
job per published image** (the origin's is where `pnpm test:image` also runs, because it is the job
with a Docker daemon and the planted key material) and the fleet's shared no-op merge guard, all
aggregated into one required `CI OK` check. An image-build job exists because its publish workflow
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

**What is still design:** the slot app boots and answers liveness, but the slot itself — the quote,
the buy, the peering, the routes, the roster and the lapse ([#32](https://github.com/toon-protocol/slop_machine/issues/32)'s
remaining slices, [#34](https://github.com/toon-protocol/slop_machine/issues/34) onward) — is not
written yet, there is no hub deploy bundle, and there is no devnet node. Do not infer other commands
from the sibling repos.

What does exist, all run from the repo root:

```
pnpm install
pnpm build       # bundles every package to its own dist/ (dist/cli.js is each entrypoint)
pnpm test        # vitest: boots the real origin on fresh ports, pushes real RTMP at it, and
                 # pulls the encoded segments back over HTTP, and boots the real slot app on
                 # fresh ports against a temporary directory. Deliberately slow — real encoding
                 # is the point, because ADR 0001 is a claim about bytes. The include list is
                 # packages/*/src/**/*.test.ts, so a new package's suites are picked up with
                 # no change here; it also covers deploy/*.test.ts, so deploy/bundle.test.ts
                 # runs beside the files it guards; smol-toml and yaml are there to read them
pnpm test:image  # vitest, opt-in and NOT part of `pnpm test`: plants dummy key material where
                 # deploy/README.md says to generate the real thing, then builds the build
                 # context and EVERY published image and proves none carries it. Needs a Docker
                 # daemon and takes minutes; deploy/bundle.test.ts holds the fast half of that
                 # guard. An image this repo publishes belongs in its PUBLISHED_IMAGES list
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier over packages/*/src/**/*.ts and deploy/*.ts
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

And from `deploy/`, once its keys and `.env` exist (see `deploy/README.md`):

```
docker compose config                                          # validate the bundle
docker compose up -d                                           # a real station
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d   # local, no TLS
```

`pnpm test` needs `ffmpeg`, `ffprobe` and `openssl` on PATH: ingest is a wire protocol, and a suite
that spoke it through a mock would be testing the mock. The **station origin's image** needs
`ffmpeg` too — the origin owns its encoder, so its runtime stage installs it. The slot app's suite
and image need none of the three: a hub carries no vibes of its own and that app encodes nothing.

Tests assert at the app's boundary only — they boot the real app and speak HTTP and real RTMP at it.
Nothing reaches into the data directory's layout, the RTMP chunk parser, the stream-key comparison,
the segmenter, the `ffmpeg` argument construction or the slot app's credential reading; all of them
must stay rewritable without touching a test. The suite's ladder is ordinary configuration — two
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
an operator **write key** and an operator **bearer token**, both of which the slot app reads.
`.gitignore` already covers these by wildcard (`*.key`, `*.secret`, `*.pem`, operator credentials)
before any of them exist — see its comments for the incidents that shaped those rules. Every one of
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

## Cross-repo dependencies

- **[connector](https://github.com/toon-protocol/connector)** — the paid reverse proxy both apps sit
  behind. Stock GHCR image on an immutable pin, with a bind-mounted `connector.toml`; this repo
  should publish no connector image. It is also the normative authority on vocabulary: where
  `CONTEXT.md` and [`connector/CONTEXT.md`](https://github.com/toon-protocol/connector/blob/main/CONTEXT.md)
  disagree, that one wins.
- **[relay](https://github.com/toon-protocol/relay)** — the reference for putting an ordinary app
  behind the connector, and the hub's announcement surface. Read its `deploy/` before writing one
  here.
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
