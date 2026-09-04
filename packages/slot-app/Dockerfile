# The slot app (slop_machine#33)
#
# The hub's admission desk. A broadcaster buys a SLOT and the hub's operator
# key creates the PEERING and the routes that make their station reachable —
# two words for two things (ADR 0003), and nothing in this image calls one by
# the other's name.
#
# It contains no payment code: no claim validation, no settlement key, no
# payment-header parsing, no pricing logic. Payment is enforced upstream by the
# connector, which is the only thing that dials the app port of this image.
#
# Entrypoint is the bundled CLI (dist/cli.js):
#   * GET /health   on TOON_SLOT_PORT (default 3200) — liveness, unpaid,
#                   reachable from inside the node only
#
# The paid surface a broadcaster buys at is slop_machine#34 onward.
#
# THE TWO OPERATOR CREDENTIALS ARE NOT IN THIS IMAGE AND MUST NEVER BE. Both
# are mounted files named by path, and the container refuses to start without
# either, saying which one:
#
#   docker run \
#     -v /srv/hub/operator-write.key:/run/secrets/operator-write.key:ro \
#     -v /srv/hub/operator-bearer.token:/run/secrets/operator-bearer.token:ro \
#     -e TOON_OPERATOR_WRITE_KEY_FILE=/run/secrets/operator-write.key \
#     -e TOON_OPERATOR_BEARER_TOKEN_FILE=/run/secrets/operator-bearer.token ...
#
# There is deliberately no ENV carrying either value: an ENV is baked into the
# image and readable from its metadata by anyone who pulls it, without ever
# running it.
#
# TOON_SLOT_PORT is EXPOSEd on the compose network and must never be
# host-published. A hub publishes exactly Caddy's 80 and 443; the app's port is
# `expose:` and nothing else, which is what makes /health unpriced-but-in-node
# rather than free to the internet.
#
# No ffmpeg here, unlike the station origin's image: a hub carries no vibes of
# its own and this app encodes nothing.
#
# Build from the repo root:
#   docker build -f packages/slot-app/Dockerfile -t ghcr.io/toon-protocol/slot-app:latest .

# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /app

# Workspace root files for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./

# This workspace package's manifest. The station origin's is deliberately NOT
# copied: pnpm resolves a frozen install against the importers the context
# actually contains, so a sibling package missing from it is simply not part of
# this workspace — and the origin's own Dockerfile leaves this one out for the
# same reason.
COPY packages/slot-app/package.json packages/slot-app/

RUN pnpm install --frozen-lockfile

# Source + build config. tsup.config.ts imports version-define.ts, which reads
# the version out of the package.json copied above — so both files must be here
# or the build fails on `Could not resolve "./version-define"`. This COPY list
# is explicit rather than a whole-directory copy (it keeps the layer small and
# the cache sharp), which means a new build-time file at the package root has
# to be added here too.
COPY packages/slot-app/src/ packages/slot-app/src/
COPY packages/slot-app/tsconfig.json packages/slot-app/tsup.config.ts packages/slot-app/version-define.ts packages/slot-app/

RUN pnpm --filter @toon-protocol/slot-app build

# Isolated production install. Deliberately NOT `pnpm deploy`: that bundles the
# workspace-root devDependencies into the deployment even though the app does
# not use them. Installing the app's own manifest in a clean directory pulls
# only its real production closure (hono, @hono/node-server).
RUN mkdir /prod \
    && cp packages/slot-app/package.json /prod/package.json \
    && cp -r packages/slot-app/dist /prod/dist
WORKDIR /prod
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

# ── Stage 2: Production ──────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /prod/dist ./dist
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./

ENV NODE_ENV=production
ENV TOON_SLOT_PORT=3200
ENV TOON_SLOT_HOST=0.0.0.0
ENV TOON_DATA_DIR=/data

# No ENV for either operator credential, deliberately: an ENV would bake a
# default into the image, and an image's environment is readable from its
# metadata without running it. Both are mounted files named by path, and the
# app refuses to start without either.

# Exposed on the compose network only. A `ports:` publish of this puts a hub
# operator's diagnostics on the internet and the routing table's own front door
# beside them.
EXPOSE 3200

# The hub's own state — the roster of who holds a slot — lives here from
# slop_machine#38 onward.
VOLUME /data

# Run unprivileged; /data must be writable by the runtime user
RUN mkdir -p /data && chown node:node /data
USER node

# 127.0.0.1, not localhost: the bind host defaults to 0.0.0.0, which is
# IPv4-only, but "localhost" inside the container can resolve to ::1, where
# nothing is listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${TOON_SLOT_PORT:-3200}/health" || exit 1

CMD ["node", "dist/cli.js"]
