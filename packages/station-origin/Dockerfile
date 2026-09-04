# The station origin (slop_machine#5, #6)
#
# One broadcaster's node. It contains no payment code: no payment-header
# parsing, no settlement key, no operator write key. Payment is enforced
# upstream by the connector, which is the only thing that dials the segment
# port of this image.
#
# Entrypoint is the bundled CLI (dist/cli.js):
#   * GET /health   on TOON_SEGMENT_PORT (default 3100) — liveness, unpaid,
#                   reachable from inside the node only
#   * RTMP/RTMPS    on TOON_INGEST_PORT (default 1935) — a broadcaster's
#                   publish, gated on the station's stream key and never paid
#
# The two ports are not alike:
#   * TOON_SEGMENT_PORT is EXPOSEd on the compose network and must never be
#     host-published — the only route to a station's vibes is a paid packet
#     through its connector.
#   * TOON_INGEST_PORT IS host-published, straight to the internet. Stock Caddy
#     does not speak RTMP, so the origin fronts its own ingest.
#
# The stream key is NOT in this image and must never be. Mount it and point
# TOON_STREAM_KEY_FILE at it; the container refuses to start without one:
#
#   docker run -v /srv/station/station.key:/run/secrets/station.key:ro \
#     -e TOON_STREAM_KEY_FILE=/run/secrets/station.key -p 1935:1935 ...
#
# RTMPS likewise needs a certificate mounted (TOON_INGEST_TLS_CERT and
# TOON_INGEST_TLS_KEY). Without one the origin speaks plain RTMP and says so.
#
# Build from the repo root:
#   docker build -f packages/station-origin/Dockerfile -t ghcr.io/toon-protocol/station-origin:latest .

# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /app

# Workspace root files for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./

# Workspace package manifest
COPY packages/station-origin/package.json packages/station-origin/

RUN pnpm install --frozen-lockfile

# Source + build config. tsup.config.ts imports version-define.ts, which reads
# the version out of the package.json copied above — so both files must be here
# or the build fails on `Could not resolve "./version-define"`. This COPY list
# is explicit rather than a whole-directory copy (it keeps the layer small and
# the cache sharp), which means a new build-time file at the package root has
# to be added here too.
COPY packages/station-origin/src/ packages/station-origin/src/
COPY packages/station-origin/tsconfig.json packages/station-origin/tsup.config.ts packages/station-origin/version-define.ts packages/station-origin/

RUN pnpm --filter @toon-protocol/station-origin build

# Isolated production install. Deliberately NOT `pnpm deploy`: that bundles the
# workspace-root devDependencies into the deployment even though the origin does
# not use them. Installing the origin's own manifest in a clean directory pulls
# only its real production closure (hono, @hono/node-server).
RUN mkdir /prod \
    && cp packages/station-origin/package.json /prod/package.json \
    && cp -r packages/station-origin/dist /prod/dist
WORKDIR /prod
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

# ── Stage 2: Production ──────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /prod/dist ./dist
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./

ENV NODE_ENV=production
ENV TOON_SEGMENT_PORT=3100
ENV TOON_SEGMENT_HOST=0.0.0.0
ENV TOON_DATA_DIR=/data
ENV TOON_INGEST_PORT=1935
ENV TOON_INGEST_HOST=0.0.0.0

# No ENV for the stream key, deliberately: an ENV would bake a default into the
# image, and a default stream key is a station anybody can broadcast on.

# Exposed on the compose network only. A `ports:` publish of this is a free
# door onto a broadcaster's vibes; the deploy bundle's guard holds that still.
EXPOSE 3100

# The one port a station node does publish. It carries no vibes outward — only
# the broadcaster's own publish inward — and it is gated on the stream key.
EXPOSE 1935

VOLUME /data

# Run unprivileged; /data must be writable by the runtime user
RUN mkdir -p /data && chown node:node /data
USER node

# 127.0.0.1, not localhost: the bind host defaults to 0.0.0.0, which is
# IPv4-only, but "localhost" inside the container can resolve to ::1, where
# nothing is listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${TOON_SEGMENT_PORT:-3100}/health" || exit 1

CMD ["node", "dist/cli.js"]
