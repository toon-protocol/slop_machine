#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see deploy/README.md.
#
# This is the box half of "the fleet follows what was reviewed". Its whole job
# is to notice that main moved and apply it.
#
# It is PULL-based on purpose. The alternative -- a CI job holding an SSH key
# into this box -- is the write path connector ADR 0068 deliberately removed,
# and putting it back in every broadcaster's box is a wider blast radius than
# the tedium it saves. Nothing outside this box can make this box deploy, which
# matters more here than anywhere else in the fleet: the box belongs to one
# broadcaster and holds their stream key and their settlement key.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset, so a box can
#     never end up on a tree nobody reviewed;
#   * after `up -d` the connector must reach `healthy`, or this exits non-zero
#     so `systemctl status` and the journal show it.
#
# One consequence worth knowing before enabling the timer: applying restarts
# the origin, which drops the broadcaster's publish. Ingest reconnects and the
# sequence continues rather than resetting, and the window is on a named volume
# that survives, so a viber sees a stall of a few seconds rather than a station
# that ended -- but it is still a stall, mid-broadcast, on someone else's
# schedule. A broadcaster who would rather choose their own moment should not
# install the timer and should run this script by hand.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_DIR="$REPO_DIR/deploy"
cd "$REPO_DIR"

# One apply at a time, and never one racing a human.
exec 9>/var/lock/toon-auto-apply.lock
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
# on both the HTTP edge and the RTMPS ingest, and it is for a laptop.
COMPOSE=(-f docker-compose.yml)
[ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)

docker compose "${COMPOSE[@]}" pull
docker compose "${COMPOSE[@]}" up -d

# The connector must come back healthy. Every node bundle defines a healthcheck
# on it (GET /ilp/identity), so this is a real answer rather than "the container
# exists". It also transitively proves the origin: the connector will not start
# until the origin's own /health check passes.
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
