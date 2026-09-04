# @toon-protocol/station-origin

The **station origin**: one broadcaster's node. It ingests their vibes and serves segments of them
over plain HTTP on a port nothing but its own connector can dial.

**It contains no payment code** — no payment-header parsing, no settlement key, no operator write
key. By the time a request reaches the origin, the connector in front of it has already proven the
request paid. See the repo's [`CLAUDE.md`](../../CLAUDE.md) for why that split is the whole design.

## What exists today

Issue #5 built the boot path and one address. Ingest, the rung ladder, segments and the station's
*now* are issues #6–#14.

| Address       | Port                 | Paid | What it is                                            |
| ------------- | -------------------- | ---- | ----------------------------------------------------- |
| `GET /health` | `TOON_SEGMENT_PORT`  | no   | Liveness, for a supervisor **inside** the node        |

`/health` is process liveness — "is the origin up enough to answer". It is not a claim about
ingest: whether a broadcaster is currently supplying vibes will be the station's *now* address,
which a viber pays for. `/health` sits outside every prefix the connector routes, so it is
reachable from inside the node and from nowhere else.

## Configuration

Flags override environment variables, which override defaults.

| Flag              | Environment variable  | Default  | Meaning                                     |
| ----------------- | --------------------- | -------- | ------------------------------------------- |
| `--segment-port`  | `TOON_SEGMENT_PORT`   | `3100`   | Port the origin serves on. `0` binds an ephemeral port |
| `--host`          | `TOON_SEGMENT_HOST`   | `0.0.0.0`| Bind host for that port                     |
| `--data-dir`      | `TOON_DATA_DIR`       | `./data` | Directory the origin owns on disk           |

The segment port is configuration, not a constant: the integration suite boots real instances on
fresh ports against temporary directories, and a broadcaster-operator moves it without a code
change. **Never host-publish it.** The only route to a station's vibes is a paid packet through its
connector.

## Running it

```bash
pnpm --filter @toon-protocol/station-origin build
node packages/station-origin/dist/cli.js --segment-port 3100 --data-dir ./data
```

Or as an image, built from the repo root:

```bash
docker build -f packages/station-origin/Dockerfile -t ghcr.io/toon-protocol/station-origin:latest .
```

## Programmatic use

```ts
import { startOrigin } from '@toon-protocol/station-origin';

const origin = await startOrigin({ segmentPort: 0, dataDir: '/tmp/station' });
await fetch(`http://127.0.0.1:${origin.config.segmentPort}/health`);
await origin.stop();
```

`segmentPort: 0` binds an ephemeral port; `origin.config.segmentPort` reports the one actually
bound. This is how the suite boots stations side by side.

## Tests

`src/origin/origin.test.ts` boots the real app and speaks plain HTTP at it. Nothing in it reaches
inside the app — the data directory's layout, and later the segmenter and the ffmpeg invocation,
must all be rewritable without touching a test.

```bash
pnpm test
```
