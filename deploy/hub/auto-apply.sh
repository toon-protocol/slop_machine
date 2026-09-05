#!/usr/bin/env bash
#
# Apply what was merged, on a HUB box. Run by systemd on a timer; see
# deploy/hub/README.md.
#
# This is the box half of "the fleet follows what was reviewed". Its whole job
# is to notice that main moved and apply it. It is the station bundle's script
# with one directory changed and one consequence that is entirely different --
# see below.
#
# It is PULL-based on purpose. The alternative -- a CI job holding an SSH key
# into this box -- is the write path connector ADR 0068 deliberately removed,
# and here the blast radius is the worst in the fleet: this box holds the
# hub's settlement key, which funds the collateral behind every peering, and
# the slot app's operator signing key, which mutates the routing table every
# admitted station depends on. Nothing outside this box can make this box
# deploy.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset, so a box can
#     never end up on a tree nobody reviewed;
#   * after `up -d` the connector must reach `healthy`, or this exits non-zero
#     so `systemctl status` and the journal show it.
#
# WHAT APPLYING COSTS ON A HUB, and it is not what it costs on a station.
# Applying restarts the slot app, which is a few seconds where a purchase in
# flight is a connector-side T01 -- the app was unreachable, one of the two
# outcomes that escapes payment, so a broadcaster is not charged for it. No
# slot lapses early: the roster is on a named volume and the restarted app
# RECONCILES the connector's own tables against it before it binds its port,
# tearing down what lapsed while it was down and writing back what a live slot
# bought. NOTHING A VIBER IS WATCHING PASSES THROUGH THE SLOT APP: the
# forwarded routes it wrote live in the connector, which is not restarted
# unless its pin changed. A hub can therefore apply mid-broadcast in a way a
# station cannot.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
DEPLOY_DIR="$REPO_DIR/deploy/hub"
cd "$REPO_DIR"

# One apply at a time, and never one racing a human.
exec 9>/var/lock/toon-hub-auto-apply.lock
flock -n 9 || { echo "another apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the box. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # nothing merged since last time; the quiet, common case
fi

echo "applying ${LOCAL:0:7} -> ${REMOTE:0:7}"
git merge --ff-only origin/main

cd "$DEPLOY_DIR"

# The overlay set this box actually runs. Keep in step with README.md.
# docker-compose.local.yml is deliberately never picked up here: it drops TLS
# and allows plaintext station URLs, and it is for a laptop.
COMPOSE=(-f docker-compose.yml)
[ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# The connector must come back healthy. Every node bundle defines a healthcheck
# on it (GET /ilp/identity), so this is a real answer rather than "the container
# exists". It also transitively proves the slot app and the relay: the connector
# will not start until both of their own /health checks pass.
CONNECTOR=$(docker compose "${COMPOSE[@]}" ps -q connector)
for _ in $(seq 1 40); do
  STATUS=$(docker inspect "$CONNECTOR" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "$STATUS" = healthy ] && break
  sleep 3
done

if [ "${STATUS:-unknown}" != healthy ]; then
  echo "FAILED: the connector is '$STATUS' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  exit 1
fi

echo "applied ${REMOTE:0:7}; connector healthy."
