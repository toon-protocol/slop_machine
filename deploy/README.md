# deploy

The files that run a slop machine **station** node: one broadcaster's origin,
the connector that prices it, and the TLS front. This page is the reference for
what each file is and how to bring a station up.

| File                            | What it is                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`            | The node: Caddy (TLS) → connector (payments) → origin. Three published ports and the segment port is not one of them; the connector's `image:` is the only place a connector build is pinned. |
| `connector.toml`                | The connector's whole configuration — **one route per rung at that rung's price, one for `/now` at its own low price**, settlement, and what this station says about itself. Mounted read-only into the stock connector image. |
| `Caddyfile`                     | TLS for the one public hostname. One line of actual routing, and no RTMP anywhere in it.                                                                                |
| `.env.example`                  | Copy to `.env`. Two required values; the rest have defaults.                                                                                                           |
| `docker-compose.local.yml`      | Local overlay: no TLS, origin built from this checkout, plain RTMP.                                                                                                    |
| `docker-compose.watchtower.yml` | Auto-redeploy overlay, scoped to the origin's moving tag.                                                                                                              |
| `auto-apply.sh` + systemd units | The box half of following main: fast-forward, `compose up -d`, require the connector healthy.                                                                          |
| `bundle.test.ts`                | The guard. Reads the real files above — never fixtures — and fails the build if the segment port is ever host-published, if `per_kib` is ever set on a route, if the ladder and the routes drift apart, if a route stops terminating strictly beneath the origin path it prices, if `/health` or `/encode` acquires a route, if the pin appears twice, or if a healthcheck goes back to `localhost`. Run by `pnpm test` from the repo root. |

## The ports story

**Exactly three published ports, and the segment port is not one of them.**

| Port      | Service  | Published as | Why                                                                                                         |
| --------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| 80, 443   | `caddy`  | `80:80`, `443:443` | The paid HTTP path. Being reachable is Caddy's whole job.                                             |
| 1935      | `origin` | `1935:1935`  | RTMPS ingest. Stock Caddy does not speak RTMP and a custom Caddy image would break the fleet's stock-TLS-front norm, so **the origin fronts its own ingest and terminates that TLS**. Caddy does not carry the RTMP path. |
| 3000      | `connector` | `127.0.0.1:3000:3000` | The client edge, on **loopback only** — for on-box operator calls (`/peers`, `/channels`). Viber traffic reaches it through Caddy. Not reachable off-box. |
| **3100**  | `origin` | **never**    | The segment port. `expose:` on the compose network and nothing else. |

The segment port is the payment-oblivious surface: `/segments/<rung>/<seq>.ts`,
`/now`, `/health` and `/encode` all answer on it with no notion of a payment at
all. `/health` and `/encode` have **no connector route** and never may — they
are the broadcaster-operator's own in-node diagnostics, and the only reason
unpriced does not mean free to the internet is that this port is published on
no interface. The only route to a broadcaster's vibes is a paid packet through
their connector.

A docker `ports:` publish **without** a host-IP prefix is internet-reachable
even with `ufw` locked to 22/80/443/1935 — Docker's iptables chain runs ahead
of ufw. So: never convert the origin's `expose: 3100` into a `ports:`, not even
on loopback, and never drop the `127.0.0.1:` from the connector's.

## The route table

`connector.toml` terminates five routes. Each one's `handler_url` is a path the
origin's own addresses sit **strictly beneath**, so no address can be reached at
another address's price — an envelope's target resolves under the route's
handler path and can never replace any part of it (connector ADR 0025).

| ILP prefix                       | Price  | Handler URL                          | Serves                          |
| -------------------------------- | ------ | ------------------------------------ | ------------------------------- |
| `g.toon.slopmachine.demo.now`    | `50`   | `http://origin:3100/now`             | the live edge                   |
| `g.toon.slopmachine.demo.audio`  | `200`  | `http://origin:3100/segments/audio`  | `/segments/audio/<seq>.ts`      |
| `g.toon.slopmachine.demo.480p`   | `1000` | `http://origin:3100/segments/480p`   | `/segments/480p/<seq>.ts`       |
| `g.toon.slopmachine.demo.720p`   | `2000` | `http://origin:3100/segments/720p`   | `/segments/720p/<seq>.ts`       |
| `g.toon.slopmachine.demo.1080p`  | `3500` | `http://origin:3100/segments/1080p`  | `/segments/1080p/<seq>.ts`      |

`demo` is a placeholder for your station's handle — replace it in all five
prefixes and in `[node].addresses`. Prices are in the settlement token's
smallest unit (6-decimal USDC) and are the placeholders from
[`../docs/placeholder-numbers.md`](../docs/placeholder-numbers.md).

**`per_kib` is never set on a station route.** Every price above is flat per
segment and the slope is always zero. A price is a schedule over the *inbound*
payload, and a viber's request is a few hundred bytes while the vibes are in the
fulfill — so a per-KiB slope would bill the request and silently do nothing for
the megabyte it returns. Bitrate is priced by **address** instead, which is what
the four rung routes are for
([ADR 0002](../docs/adr/0002-bitrate-follows-the-vibers-budget.md)).

The route table and `TOON_RUNGS` in `docker-compose.yml` are **one pair**: a
rung with no route is unsellable, and a route naming a rung the origin does not
offer is a paid 404. Change one and change the other in the same commit.

## Bringing a station up

### 1. DNS

One `A`/`AAAA` record for `EDGE_HOST` pointing at the box, so Caddy can get a
certificate. The RTMPS ingest is reached at the same host on port 1935, or at
a name of your choosing — Caddy is not involved in it either way.

### 2. Secrets, all of them mounted files

Everything below is gitignored and none of it is ever baked into an image.

```bash
cd deploy

# The broadcaster's stream key. This is what stops anybody else broadcasting
# as this station, and OBS's "Stream Key" field is exactly this value.
openssl rand -hex 32 > stream.key
chmod 600 stream.key
sudo chown 1000:1000 stream.key          # uid 1000 = `node`, the origin's user

# The RTMPS certificate the origin terminates its own ingest TLS with. Use a
# real certificate for a station on the internet; a self-signed pair is only
# for a box you also control the publisher on.
sudo cp /path/to/fullchain.pem ingest-tls.crt
sudo cp /path/to/privkey.pem   ingest-tls.key
sudo chown 1000:1000 ingest-tls.crt ingest-tls.key
chmod 600 ingest-tls.key

# The connector's identities and operator credentials — see connector.toml's
# own comments for what each one is and how to derive it.
openssl rand -hex 32 > signer.key
#  settlement.key / settlement-solana.key: derived from a seed you can
#  reproduce, NOT from `openssl rand` — vibers open channels against them.
openssl rand -hex 32 > operator-bearer.token
#  operator-write.keys: the PUBLIC half of your operator write key
sudo chown 10001:10001 signer.key settlement.key settlement-solana.key \
  operator-bearer.token operator-write.keys
chmod 600 signer.key settlement.key settlement-solana.key operator-bearer.token
```

Two different uids, and it matters: a bind-mounted file keeps its **host**
ownership inside the container, so the connector's files must be readable by
uid 10001 and the origin's by uid 1000, or the container restart-loops on
"Permission denied". `chmod 644` is not the fix.

### 3. Config

```bash
cp .env.example .env    # EDGE_HOST and ACME_EMAIL are required
$EDITOR connector.toml  # replace `demo` with your handle, and the hostname
```

If you change `STATION_RUNGS`, change the routes in `connector.toml` to match.

### 4. Up

```bash
docker compose up -d
docker compose ps       # all three healthy
```

The origin refuses to start without a stream key, and refuses to start on a
ladder that could produce a segment over ADR 0001's 2 MiB budget — naming the
rung. The connector refuses to start on a missing key file or a settlement
chain it cannot reach. A bad config is a refuse-to-start here, never a degraded
run.

### 5. Go live

Point OBS at it. Server `rtmps://<your host>:1935/live`, Stream Key the
contents of `stream.key`. The key is checked on the RTMP `publish` command,
before a byte is transcoded, so a wrong one shows up in OBS immediately rather
than after broadcasting to nobody. Ingest is authenticated and **never paid**.

Then, from inside the node:

```bash
docker compose exec origin wget -qO- http://127.0.0.1:3100/encode
```

which says whether the box is keeping up with the ladder, per rung. A cheap
rung keeping pace while an expensive one falls behind names the rung to drop.

## Overlays

```bash
# Local, no TLS: Caddy drops out, the origin is built from this checkout, and
# ingest is plain RTMP on 1935. Never on a box reachable from the internet.
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

# Auto-redeploy: Watchtower follows the origin's :release tag. Never touches
# Caddy, and has nothing to follow for the pinned connector.
docker compose -f docker-compose.yml -f docker-compose.watchtower.yml up -d
```

## Images

| Image                                     | Built by           | Contents                                                                             |
| ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `ghcr.io/toon-protocol/station-origin`    | this repo          | the station origin (`packages/station-origin`), ffmpeg included                       |
| `ghcr.io/toon-protocol/connector`         | the connector repo | the stock TOON connector — **this repo publishes no connector image and only pins one** |

There is no image-publishing workflow in this repository yet, so
`ghcr.io/toon-protocol/station-origin:release` does not exist to pull. Until it
does, run the local overlay, which builds the origin from this checkout, or
build and tag it yourself:

```bash
docker build -f ../packages/station-origin/Dockerfile \
  -t ghcr.io/toon-protocol/station-origin:release ..
```

The connector pin lives in exactly one place: `docker-compose.yml`'s
`connector.image`, an immutable tag. Bumping it is a reviewed commit that
carries any `connector.toml` change alongside it, and the box takes both with
one `git pull` — so a connector can never reach a box ahead of the config it
needs. **A consequence worth stating: the connector does not auto-deploy.**
Watchtower cannot move an immutable tag, so a connector or config change — and
therefore any price change — is `git pull && docker compose up -d` on the box.

## Following what was merged

| File                                 | What it is                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `auto-apply.sh`                      | On the box: fast-forwards `main`, `compose up -d`, and requires the connector to come back healthy.           |
| `toon-auto-apply.service` / `.timer` | The systemd pair that runs it every five minutes. Install once; `ExecStart` assumes the checkout is at `/root/slop_machine`. |

Applying restarts the origin, which drops the broadcaster's publish. Ingest
reconnects and the sequence continues rather than resetting, and the window is
on a named volume that survives, so a viber sees a stall of a few seconds
rather than a station that ended — but it is a stall on someone else's
schedule. A broadcaster who would rather pick their own moment should skip the
timer and run the script by hand.

`auto-apply.sh` lives in the repository it applies, which has one consequence
worth knowing: a box sitting on a commit from **before** the script existed
cannot pull itself forward — `systemd` would be pointing `ExecStart` at a file
that is not there yet. Fast-forward that box by hand once and it takes over
from there.

## Secrets

`.env`, `*.key`, `*.pem`, `*.secret`, `ingest-tls.crt`, `operator-bearer.token`
and `operator-write.keys` in this directory are gitignored, and the repository
root ignores the same wildcards. `connector.toml` is committed and holds
nothing secret: it names key _paths_, and the files themselves are mounted
read-only at runtime.

The two a station holds that no other node in the fleet does are the
broadcaster's **stream key** and the private half of the **RTMPS certificate**.
Both are mounted values. An ignore rule does not protect an already-tracked
file: if one lands, `git rm --cached` it **and rotate it** — the rotation is
what closes the exposure.
