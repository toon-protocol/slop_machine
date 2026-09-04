# @toon-protocol/station-origin

The **station origin**: one broadcaster's node. It ingests their vibes and serves segments of them
over plain HTTP on a port nothing but its own connector can dial.

**It contains no payment code** — no payment-header parsing, no settlement key, no operator write
key. By the time a request reaches the origin, the connector in front of it has already proven the
request paid. See the repo's [`CLAUDE.md`](../../CLAUDE.md) for why that split is the whole design.

## What exists today

Issues #5 and #6 built the boot path, one address, and the door a broadcaster's vibes come in
through. The rung ladder, segments, retention and the station's *now* are issues #7–#14.

| Surface       | Port                | Paid | What it is                                          |
| ------------- | ------------------- | ---- | --------------------------------------------------- |
| `GET /health` | `TOON_SEGMENT_PORT` | no   | Liveness, for a supervisor **inside** the node      |
| RTMP / RTMPS  | `TOON_INGEST_PORT`  | no   | A broadcaster's publish, gated on the stream key    |

`/health` is process liveness — "is the origin up enough to answer". It is not a claim about
ingest: whether a broadcaster is currently supplying vibes will be the station's *now* address,
which a viber pays for. `/health` sits outside every prefix the connector routes, so it is
reachable from inside the node and from nowhere else.

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

Accepted vibes are handed to the `onIngest` callback as an FLV stream — an FLV header followed by
one tag per audio, video or metadata message, which is what `ffmpeg -i pipe:0` reads. Nothing in
this repo consumes it yet; the segmenter is issue #7.

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
| `--data-dir`         | `TOON_DATA_DIR`         | `./data`  | Directory the origin owns on disk                       |
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
  onIngest: (session) => session.vibes.pipe(somewhere),
});
await fetch(`http://127.0.0.1:${origin.config.segmentPort}/health`);
await origin.stop();
```

`segmentPort: 0` and `ingestPort: 0` bind ephemeral ports; `origin.config` reports the ones
actually bound (and never the stream key). This is how the suite boots stations side by side.

## Tests

`src/origin/origin.test.ts` boots the real app and speaks plain HTTP at it.
`src/ingest/ingest.test.ts` points real `ffmpeg` at the real ingest port over real RTMP and RTMPS,
and asserts only on what the publishing client sees — because "OBS says it worked" and "OBS says the
key is wrong" are the only two outcomes a broadcaster ever has.

Nothing in either reaches inside the app: the data directory's layout, the RTMP chunk parser, the
stream-key comparison, and later the segmenter and the ffmpeg invocation, must all be rewritable
without touching a test.

`ffmpeg`, `ffprobe` and `openssl` must be on PATH — ingest is a wire protocol, and a suite that
spoke it through a mock would be testing the mock. The RTMPS certificate is generated per run into a
temporary directory and never committed.

```bash
pnpm test
```
