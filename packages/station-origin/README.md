# @toon-protocol/station-origin

The **station origin**: one broadcaster's node. It ingests their vibes and serves segments of them
over plain HTTP on a port nothing but its own connector can dial.

**It contains no payment code** — no payment-header parsing, no settlement key, no operator write
key. By the time a request reaches the origin, the connector in front of it has already proven the
request paid. See the repo's [`CLAUDE.md`](../../CLAUDE.md) for why that split is the whole design.

## What exists today

Issues #5, #6, #7 and #8 built the whole paid path across a **configurable rung ladder**: a
broadcaster publishes, the origin encodes and cuts at every rung they configured, and a viber pulls
segments by address at the rung — and so the price — they chose. The station's *now* (#9),
retention (#10), reconnect (#11) and the deploy bundle (#13/#14) are still to come.

| Surface                              | Port                | Paid | What it is                                       |
| ------------------------------------ | ------------------- | ---- | ------------------------------------------------ |
| `GET /health`                        | `TOON_SEGMENT_PORT` | no   | Liveness, for a supervisor **inside** the node   |
| `GET /segments/<rung>/<seq>.ts`      | `TOON_SEGMENT_PORT` | yes  | One span of the broadcaster's vibes at that rung |
| RTMP / RTMPS                         | `TOON_INGEST_PORT`  | no   | A broadcaster's publish, gated on the stream key |

`/health` is process liveness — "is the origin up enough to answer". It is not a claim about
ingest: whether a broadcaster is currently supplying vibes will be the station's *now* address,
which a viber pays for. `/health` sits outside every prefix the connector routes, so it is
reachable from inside the node and from nowhere else.

## Segments

```
GET /segments/<rung>/<sequence>.ts   →  200  video/mp2t, Cache-Control: no-store
                                     →  404  {"error":"unknown_rung",    "message": "…"}
                                     →  404  {"error":"unknown_segment", "message": "…"}
```

One MPEG-TS span of the broadcast, encoded at `<rung>` and numbered from zero. The two misses are
told apart on purpose: a player whose rung has gone falls back to one that exists, and a player
whose sequence has gone re-syncs to the live edge.

- **The rung comes before the sequence** so that every path a viber can reach at one rung's price
  sits strictly beneath that rung's own prefix, `/segments/<rung>/`. That is what lets the connector
  terminate one route per rung at that rung's price, and it is why no address can be reached at
  another address's price. Anything that is not a segment — `/health` today, the station's *now*
  tomorrow — sits outside `/segments` entirely.
- **A segment arrives whole or not at all.** `ffmpeg` writes each span under a temporary name and
  renames it only once the span is complete; nothing is servable before that rename, and a segment
  is read whole and sent with its length stated up front. A viber pays once for a span they can
  actually play.
- **A segment is bounded to 2 MiB** ([ADR 0001](../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)).
  The bound is arithmetic — a hard bitrate cap times a fixed duration — and the origin measures what
  it produced as well: a segment over the budget is logged loudly and never served.
- **The bitrate is a hard cap, not a target.** The encoder runs constrained VBR (a maximum rate plus
  a short buffer), never average targeting, because average targeting overshoots exactly when the
  picture gets busy.
- **Duration is fixed.** A flat per-segment price is only honestly a per-second rate — and a viber's
  budget only a meaningful control — when every segment covers the same span.
- **No playlist is served, and nothing free is.** The client daemon stands between the station and
  the player and synthesizes whatever playlist its player wants over loopback.

Segments are written to `$TOON_DATA_DIR/segments/<rung>/`. Generated media is ignored by
**directory**, never by extension — an HLS segment is an MPEG-TS `.ts` file, which collides with the
TypeScript extension. The corollary is that the code lives in `src/segmenter/`, not `src/segments/`:
`.gitignore`'s `segments/` rule matches a directory of that name anywhere, source included.

## The rung ladder

Which rungs a station offers is ordinary configuration — one string, `--rungs`/`TOON_RUNGS`, so
that a broadcaster trades bandwidth cost against quality without a code change, and so that the
rungs are readable beside the connector routes that price them in the same compose file:

```
TOON_RUNGS="audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k"
```

Rungs are separated by commas and their fields by colons; whitespace around either is ignored:

```
<name>:<height>:<video bitrate>:<audio bitrate>    a rung with a picture
<name>:<audio bitrate>                             a rung carrying only sound
```

A bitrate is bits per second with the broadcast-conventional `k` and `M` suffixes (`1800k` is
1.8 Mbit/s), and it is a **cap, never a target**. One ingest is encoded at every rung on the ladder,
each into its own prefix, and the rung names are exactly the routes the connector in front needs.

The default is the four-rung, four-second ladder of
[`docs/placeholder-numbers.md`](../../docs/placeholder-numbers.md) — placeholders, not decisions,
and safe to change:

| Rung    | Cap                          | Worst case per 4s segment |
| ------- | ---------------------------- | ------------------------- |
| `audio` | 128 kbit/s, sound only       | 64 000 bytes              |
| `480p`  | 800 kbit/s + 128 kbit/s      | 464 000 bytes             |
| `720p`  | 1.8 Mbit/s + 128 kbit/s      | 964 000 bytes             |
| `1080p` | 3 Mbit/s + 128 kbit/s        | 1 564 000 bytes           |

### It is validated fail-closed, at every start

Worst-case bytes are computed as **capped bitrate × fixed segment duration**, and the origin
**refuses to start — non-zero exit, naming the offending rung** — if any rung exceeds the 2 MiB
budget of [ADR 0001](../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md):

```
[station-origin] RungError: rung "4k" would produce segments of up to 8064000 bytes
(16128000 bit/s × 4s), over the 2097152-byte budget of ADR 0001 — cap rung "4k" below
4194304 bit/s in total, or shorten the segment
```

Same posture as `connector.toml`: a bad config is a refuse-to-start, never a degraded run. It
refuses just as flatly on a ladder it cannot read, a rung name it could not address, or two rungs of
one name — the last would be two prices at one address. Because the check is arithmetic over
configuration it re-runs on **every** start, so raising a rung's bitrate and restarting is refused
rather than quietly breaking the bound. At four-second segments the ceiling is 4.19 Mbit/s, which is
why the top rung sits at 3 Mbit/s: the headroom is for VBR overshoot. Do not add a rung above it
without re-reading ADR 0001.

## Ingest

A broadcaster publishes with their stream key as the stream name:

```
rtmps://<station>:1935/live/<stream key>
```

which is exactly the Server / Stream Key pair OBS asks for — nothing slop_machine-specific is
installed on the broadcaster's box.

- **Authenticated, never paid.** The key is checked on the RTMP `publish` command, before a byte of
  media is read and long before anything is transcoded. A wrong or absent key is answered with an
  RTMP error status (`NetStream.Publish.Denied`) and the socket is closed, so it surfaces in OBS
  immediately rather than after a broadcast to nobody. Nothing on this path parses a payment header,
  holds a settlement key, or knows ILP exists.
- **The origin fronts its own ingest.** Stock Caddy does not speak RTMP and a custom Caddy image
  would break the fleet's stock-TLS-front norm, so the station node publishes this port itself and
  the origin terminates its own TLS. It is the *only* other port a station publishes; the segment
  port is published on no interface at all.
- **RTMPS when a certificate is mounted.** Without `TOON_INGEST_TLS_CERT`/`TOON_INGEST_TLS_KEY` the
  listener speaks plain RTMP and says so loudly at boot. A station reachable from the internet
  mounts one.

Accepted vibes are handed to the origin's segmenter as an FLV stream — an FLV header followed by one
tag per audio, video or metadata message, which is what `ffmpeg -i pipe:0` reads. The `onIngest`
callback sees the same stream, as an extra observer rather than the consumer.

## The stream key

The one secret the origin holds. It is **provisioned**, never generated here: mount a file onto the
box and point `TOON_STREAM_KEY_FILE` at it, or set `TOON_STREAM_KEY`. There is deliberately no flag
carrying the literal, because a command line is world-readable on the box.

There is no default and no "unset means open": **an origin with no stream key refuses to start**,
because a station anyone can broadcast on looks exactly like a working one. It is never logged,
never echoed, and never appears in `OriginInstance.config`. `.gitignore` already covers `*.key`,
`*.secret` and `*.pem`.

## Configuration

Flags override environment variables, which override defaults.

| Flag                 | Environment variable    | Default   | Meaning                                                 |
| -------------------- | ----------------------- | --------- | ------------------------------------------------------- |
| `--segment-port`     | `TOON_SEGMENT_PORT`     | `3100`    | Port the origin serves on. `0` binds an ephemeral port  |
| `--host`             | `TOON_SEGMENT_HOST`     | `0.0.0.0` | Bind host for that port                                 |
| `--data-dir`         | `TOON_DATA_DIR`         | `./data`  | Directory the origin owns on disk; segments land in `<path>/segments/<rung>/` |
| `--segment-seconds`  | `TOON_SEGMENT_SECONDS`  | `4`       | How long each segment is, in whole seconds              |
| `--rungs`            | `TOON_RUNGS`            | the four-rung placeholder ladder | The rung ladder; a rung over the byte budget is a refusal to start |
| `--ingest-port`      | `TOON_INGEST_PORT`      | `1935`    | Port a broadcaster publishes to. `0` binds an ephemeral port |
| `--ingest-host`      | `TOON_INGEST_HOST`      | `0.0.0.0` | Bind host for the ingest port                           |
| `--stream-key-file`  | `TOON_STREAM_KEY_FILE`  | —         | Mounted file holding the stream key                     |
| —                    | `TOON_STREAM_KEY`       | —         | The stream key itself, for a compose file that keeps secrets in the environment |
| `--ingest-tls-cert`  | `TOON_INGEST_TLS_CERT`  | —         | Certificate chain for the ingest port, in PEM           |
| `--ingest-tls-key`   | `TOON_INGEST_TLS_KEY`   | —         | Private key for that certificate, in PEM                |

Exactly one of `TOON_STREAM_KEY_FILE` and `TOON_STREAM_KEY` must be set; both, neither, or an empty
key is a refusal to start. So is half a TLS configuration — the alternative would be a silent
downgrade to plain RTMP, which is the one outcome an operator setting either flag did not want.

Both ports are configuration, not constants: the integration suite boots real instances on fresh
ports against temporary directories, and a broadcaster-operator moves either without a code change.
**Never host-publish the segment port.** The only route to a station's vibes is a paid packet
through its connector. The ingest port is the one that *is* published.

## Running it

```bash
pnpm --filter @toon-protocol/station-origin build
node packages/station-origin/dist/cli.js \
  --segment-port 3100 --data-dir ./data \
  --ingest-port 1935 --stream-key-file /run/secrets/station.key
```

Or as an image, built from the repo root:

```bash
docker build -f packages/station-origin/Dockerfile -t ghcr.io/toon-protocol/station-origin:latest .
```

## Programmatic use

```ts
import { startOrigin } from '@toon-protocol/station-origin';

const origin = await startOrigin({
  segmentPort: 0,
  ingestPort: 0,
  dataDir: '/tmp/station',
  streamKeyFile: '/run/secrets/station.key',
  // The ladder, as ordinary configuration. Omitted, it is the four-rung
  // placeholder. Rungs already parsed are accepted here too.
  rungs: 'audio:96k,480p:480:800k:96k',
  segmentSeconds: 4,
});

// Every rung the station offers, in ladder order — and so every prefix the
// connector in front prices, one route each.
const [rung] = origin.config.rungs;
await fetch(
  `http://127.0.0.1:${origin.config.segmentPort}/segments/${rung}/0.ts`
);
await origin.stop();
```

`segmentPort: 0` and `ingestPort: 0` bind ephemeral ports; `origin.config` reports the ones
actually bound (and never the stream key). This is how the suite boots stations side by side.

## Tests

`src/origin/origin.test.ts` boots the real app and speaks plain HTTP at it.
`src/ingest/ingest.test.ts` points real `ffmpeg` at the real ingest port over real RTMP and RTMPS,
and asserts only on what the publishing client sees — because "OBS says it worked" and "OBS says the
key is wrong" are the only two outcomes a broadcaster ever has.

`src/segmenter/segments.test.ts` is the one real seam: it boots the real app on fresh ports against a
temporary directory, pushes a few seconds of synthetic RTMP — a generated picture and a tone — at
the real ingest port, and then asserts **entirely over plain HTTP** on what a viber could observe.
It is deliberately slow, because real encoding is the point: ADR 0001 is a claim about bytes, and a
mocked segmenter cannot falsify it. Every expected value is a literal in the test rather than read
back out of the code under test, and the byte bound is asserted against actual encoded bytes.

Its ladder is ordinary configuration — two deliberately small rungs, one of them sound only — so
the suite pulls the same span at two rungs and watches the sizes differ the way the ladder says
they should, without ever encoding a broadcaster's four real ones. The refusal is asserted the same
way round: a ladder over the byte budget must not boot, and must name the rung.

Nothing in any of them reaches inside the app: the data directory's layout, the RTMP chunk parser,
the stream-key comparison, the segmenter and the `ffmpeg` argument construction must all be
rewritable without touching a test.

`ffmpeg`, `ffprobe` and `openssl` must be on PATH — ingest is a wire protocol, and a suite that
spoke it through a mock would be testing the mock. The RTMPS certificate is generated per run into a
temporary directory and never committed.

```bash
pnpm test
```
