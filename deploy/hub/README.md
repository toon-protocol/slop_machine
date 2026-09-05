# deploy/hub

The files that run a slop machine **hub** node: the slot app that sells
admission, the relay that carries announcements, the connector that prices
both, and the TLS front. This page is the reference for what each file is and
how to bring a hub up.

A hub is not a station and this bundle is not `../`. A station takes one
broadcaster's vibes in and serves segments of them out; a hub carries no vibes
of its own. It sells the routing-table entries that make somebody else's
station **reachable**, and it carries the announcements that make one
**findable**. Nothing a viber watches passes through this box.

| File                            | What it is                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`            | The node: Caddy (TLS) → connector (payments) → slot app + relay. **Two published ports**, and no RTMP anywhere; the connector's `image:` is this bundle's pin of record. |
| `connector.toml`                | The connector's whole configuration — **the quote route at a floor price, the buy route at the slot price**, the two announcement routes, settlement, and what this hub says about itself. Mounted read-only into the stock connector image. |
| `Caddyfile`                     | TLS for the two public hostnames: the paid edge, and the free announcement reads.                                                                                     |
| `.env.example`                  | Copy to `.env`. Four required values; the rest have defaults.                                                                                                          |
| `docker-compose.local.yml`      | Local overlay: no TLS, slot app built from this checkout, plaintext station URLs allowed.                                                                              |
| `docker-compose.watchtower.yml` | Auto-redeploy overlay, scoped to the slot app's and the relay's moving tags.                                                                                           |
| `auto-apply.sh` + systemd units | The box half of following main: fast-forward, `compose up -d`, require the connector healthy.                                                                          |

## The ports story

**Exactly two published ports, and that is one fewer than a station's.** A
station publishes a third — its RTMPS ingest — because stock Caddy does not
speak RTMP and its origin must front its own uplink. A hub has no uplink, so
**no RTMP port, service or path appears anywhere in this bundle** and none may.

| Port      | Service     | Published as          | Why                                                                                              |
| --------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| 80, 443   | `caddy`     | `80:80`, `443:443`    | The paid HTTP path and the free announcement reads. Being reachable is Caddy's whole job.        |
| 3000      | `connector` | `127.0.0.1:3000:3000` | The client edge, on **loopback only** — for on-box operator calls. Broadcaster traffic reaches it through Caddy. Not reachable off-box. |
| **3200**  | `slot-app`  | **never**             | The admission desk. `expose:` on the compose network and nothing else.                            |
| **3100**  | `relay`     | **never**             | Paid announcement writes. `expose:` only; the connector is the only thing that dials it.          |
| **7100**  | `relay`     | **never** in production | Free announcement reads. `expose:` only, fronted by Caddy. The local overlay publishes it on `127.0.0.1` because with Caddy gone nothing else would reach it. |

The slot app's port is the payment-oblivious surface: `/quote`, `/buy`,
`/health` and `/roster` all answer on it with no notion of a payment at all.
`/health` and `/roster` have **no connector route** and never may — they are
the hub operator's own in-node diagnostics, and the only reason unpriced does
not mean free to the internet is that this port is published on no interface.
Published, it would give away two things at once: a free slot, and `/roster`'s
list of every broadcaster this hub admitted.

A docker `ports:` publish **without** a host-IP prefix is internet-reachable
even with `ufw` locked to 22/80/443 — Docker's iptables chain runs ahead of
ufw. So: never convert an `expose:` here into a `ports:`, not even on loopback,
and never drop the `127.0.0.1:` from the connector's. The invariant to hold is
that **Caddy holds the only unqualified publishes in every file set**, base and
overlays alike.

## The route table

`connector.toml` terminates four routes. Each one's `handler_url` is a path the
app behind it sits **strictly beneath**, so no address can be reached at
another address's price — an envelope's target resolves under the route's
handler path and can never replace any part of it
([connector ADR 0025](https://github.com/toon-protocol/connector/blob/main/docs/adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md)).

| ILP prefix                              | Price     | Handler URL                             | Declared `request`                                       |
| --------------------------------------- | --------- | --------------------------------------- | --------------------------------------------------------- |
| `g.toon.slopmachine.slot.quote`          | `50`      | `http://slot-app:3200/quote`            | `GET`, no body                                             |
| `g.toon.slopmachine.slot.buy`            | `1000000` | `http://slot-app:3200/buy`              | `POST` `application/json`, body `{ stationUrl }`           |
| `g.toon.slopmachine.announce`            | `1`       | `http://relay:3100/write`               | `POST` `application/json`, body `{ event }`                |
| `g.toon.slopmachine.announce.ephemeral`  | `0`       | `http://relay:3100/write-ephemeral`     | `POST` `application/json`, body `{ event }`, ephemeral kinds |

**The quote is priced apart from the buy on purpose, and the two are never
beneath one prefix.** A connector fulfils on any complete answer from an app
whatever its HTTP status, so a refusal at a paid address is a refusal the
caller paid for
([ADR 0003's amendment](../../docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)).
Every foreseeable refusal therefore lives at the quote, at a floor price — no
capacity, and the caller's own current slot — so the expensive address is only
reached when the answer is already yes.

**`/health` and `/roster` appear in no route above and never may.** Pointing a
route at the bare app (`http://slot-app:3200`) instead of at `/quote` and
`/buy` would do exactly that, and would additionally make the buy reachable at
the quote's price.

**Each route declares its `request` shape**
([connector ADR 0067](https://github.com/toon-protocol/connector/blob/main/docs/adr/0067-a-route-declares-its-request-shape-and-the-connector-never-reads-it.md)),
which the connector publishes verbatim on that route's self-description entry
and on the x402 greeting for it, and never reads. ADR 0067 assigns the check
that a declared shape matches what the app really serves to **the app's own
repository** — which is this one, so that check belongs to this bundle's guard.

The route table and the `TOON_*` variables in `docker-compose.yml` are **one
pair**: `TOON_SLOT_PRICE` and the buy route's price, and `TOON_HUB_ADDRESS` and
the apex all four prefixes are written beneath. Change one and change the other
in the same commit. The connector is what charges; the app's number is what the
quote reports and the floor the buy checks the connector's own stated
`X-TOON-Amount` against, so a route misconfigured to under-charge cannot sell
slots below policy.

`per_kib` is set on no route here. A price is a schedule over the *inbound*
payload, and everything this hub terminates is a small request — a quote with
no body, a purchase carrying one URL, an announcement carrying one event.

## Bringing a hub up

### 1. DNS

Two records pointing at the box, so Caddy can get a certificate for each:

- `EDGE_HOST` — the connector's client edge, where a broadcaster's paid quote
  and paid buy land;
- `READ_HOST` — the relay's WebSocket, where a viber reads announcements for
  free.

### 2. Secrets, all of them mounted files

Everything below is gitignored and none of it is ever baked into an image.

```bash
cd deploy/hub

# The connector's own ILP signing identity. It holds no money, so it is fresh
# random material per box.
openssl rand -hex 32 > signer.key

# The hub's SETTLEMENT keys. Unlike a station's, these are working capital:
# they are what broadcasters open channels against AND what this hub funds the
# other side of every peering from. Derive them from a seed you can reproduce,
# NOT from `openssl rand` — see connector.toml's own comments for the
# derivation paths, and verify the derived address before the first `up -d`.

# The operator surface's THREE files. Read this block rather than skimming it:
# two of them look alike and are opposites.
openssl rand -hex 32 > operator-bearer.token   # secret. Gates the READS.
openssl rand -hex 32 > operator-signing.key    # secret. The slot app's PRIVATE
                                               # ed25519 seed — the credential
                                               # that mutates this hub's
                                               # routing table.
connector send --operator-key operator-signing.key --print-keyid \
  > operator-write.keys                        # NOT secret. The ALLOWLIST of
                                               # public halves, one keyid per
                                               # line. This is step 3.

chmod 600 signer.key settlement.key settlement-solana.key \
  operator-bearer.token operator-signing.key
sudo chown 10001:10001 signer.key settlement.key settlement-solana.key \
  operator-bearer.token operator-write.keys
sudo chown 1000:1000 operator-signing.key      # uid 1000 = `node`, the slot
                                               # app's user
```

Two different uids, and it matters: a bind-mounted file keeps its **host**
ownership inside the container, so the connector's files must be readable by
uid 10001 and the slot app's by uid 1000, or the container restart-loops on
"Permission denied". `chmod 644` is not the fix.

**`operator-signing.key` is singular and is a secret. `operator-write.keys` is
plural and is not.** They are the only two files in the fleet whose names are
close, they live in this one directory, and they are opposites: the first is
the private seed the slot app signs every operator write with, and the second
is the public-half allowlist you open in an editor to **revoke** that
authority. The seed is deliberately not called `operator-write.key` for exactly
that reason — a secret should not be one tab-completion from the file that
takes its power away.

### 3. Put the slot app's public key on the connector's allowlist

**This is the step that makes the hub work at all, and skipping it produces a
hub that looks healthy and refuses every purchase.** Every operator write the
slot app makes is RFC 9421 signature-gated, and the connector accepts a
signature only from a key on `write_keys_file` — which is
`operator-write.keys`, one keyid (the public half, hex) per line.

The command in step 2 writes it. If you would rather read it off the app, it
prints the same value at boot:

```bash
docker compose up -d slot-app
docker compose logs slot-app | grep 'signing as'
#   [slot-app] peering policy: peerings written at http://connector:3000 …, signing as <keyid>
```

Put that keyid in `operator-write.keys`, one per line, and restart the
connector. Adding a line grants authority; deleting one revokes it. That file
is per box and hand-edited, which is why it is gitignored rather than
committed — a committed allowlist would put revocation behind a pull request.

### 4. Config

```bash
cp .env.example .env    # EDGE_HOST, READ_HOST, ACME_EMAIL and
                        # RELAY_NOSTR_SECRET_KEY are required
$EDITOR connector.toml  # your own apex and both hostnames
```

If you change `HUB_ADDRESS`, change `connector.toml`'s `[node].addresses` and
all four route prefixes to match. If you change `HUB_SLOT_PRICE`, change the
buy route's `price` to match.

### 5. Up

```bash
docker compose up -d
docker compose ps       # all four healthy
```

The slot app refuses to start without either operator credential, and says
which one — a hub that cannot admit anybody must look broken rather than look
fine. It also refuses a write key file that is not a 32-byte seed, because
finding that out at the first purchase would cost a broadcaster the slot price.
The connector refuses to start on a missing key file or a settlement chain it
cannot reach. A bad config is a refuse-to-start here, never a degraded run.

### 6. Check it from inside the node

```bash
docker compose exec slot-app wget -qO- http://127.0.0.1:3200/roster
```

Who holds a slot and when each lapses, soonest first. It is a view of the
**roster** — what this hub sold — rather than of the connector's routing table,
which is what it is carrying; the two are made to agree at boot, and where they
disagree in between it is the roster that says which is right.

Both that address and `/health` are unpriced and in-node. Neither has a
connector route and neither may acquire one.

## What a broadcaster does with it

Worth knowing, because it is the other half of the two-bundle story and the
order matters:

1. They pull a **quote** from `g.toon.slopmachine.slot.quote`, at a floor
   price. It answers what a slot costs, how long it lasts, whether this hub has
   capacity — and **the prefix this hub would grant them**.
2. They write that prefix into their own station's `connector.toml` — all five
   route prefixes and `[node].addresses` — and bring their station up. See
   [`../README.md`](../README.md)'s step 3.
3. They **buy**, at `g.toon.slopmachine.slot.buy`, naming their station
   connector's own self-description URL. The hub reads it, learns which
   addresses that node terminates and what each costs, establishes the peering,
   and writes one forwarded route per address at that price plus this hub's
   carriage — synchronously, before it answers. The fulfill means they are
   peered.

The order is why the quote exists: a broadcaster who bought first would have to
buy again after configuring for the prefix they were granted.

**The hub reads that URL over `https` only.** A purchase names a URL of the
buyer's choosing and this hub then fetches it from inside its own network, so
the fetch is bounded — one attempt, a ten-second budget, a 64 KiB cap, no
redirect followed — and plaintext is the last of those bounds:
`TOON_ALLOW_PLAINTEXT_STATION_URLS` is `false` in `docker-compose.yml` and
should stay that way on any box with a public name. It is the same switch, the
same name and the same default as the connector's own
`peer_allow_plaintext_endpoints`. The local overlay turns it back on, because a
laptop topology has no certificate anywhere.

## Overlays

```bash
# Local, no TLS: Caddy drops out, the slot app is built from this checkout,
# plaintext station URLs are allowed, and the relay's free reads are published
# on 127.0.0.1:7100. Never on a box reachable from the internet.
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

# Auto-redeploy: Watchtower follows the slot app's and the relay's :release
# tags. Never touches Caddy, and has nothing to follow for the pinned
# connector.
docker compose -f docker-compose.yml -f docker-compose.watchtower.yml up -d
```

## Images

| Image                                | Built by                      | Contents                                                                                |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `ghcr.io/toon-protocol/slot-app`     | this repo, on merge to `main` | the slot app (`packages/slot-app`), no ffmpeg — a hub encodes nothing                     |
| `ghcr.io/toon-protocol/relay`        | the relay repo                | the stock TOON relay — **this repo publishes no relay image and only pulls one**          |
| `ghcr.io/toon-protocol/connector`    | the connector repo            | the stock TOON connector — **this repo publishes no connector image and only pins one**   |

`ghcr.io/toon-protocol/slot-app` is published by
[`.github/workflows/publish-slot-app-image.yml`](../../.github/workflows/publish-slot-app-image.yml)
on every merge to `main`. Each build moves `:latest` and `:release` and keeps an
immutable `:sha-<short>` tag; `:release` is what `docker-compose.yml` defaults
`SLOT_APP_IMAGE` to and the one Watchtower follows, so a plain `docker compose
up -d` on a fresh box pulls it and needs no local build. To roll back, point
`SLOT_APP_IMAGE` (or `RELAY_IMAGE`) in `.env` at a `sha-` tag you trust and run
`up -d`.

The connector pin lives in `docker-compose.yml`'s `connector.image`, an
immutable tag — one of exactly two places in this repository a connector build
may be named, the other being the station bundle's. Bumping it is a reviewed
commit that carries any `connector.toml` change alongside it, and the box takes
both with one `git pull`. **A consequence worth stating: the connector does not
auto-deploy.** Watchtower cannot move an immutable tag, so a connector or config
change — and therefore any price change — is `git pull && docker compose up -d`
on the box.

## Following what was merged

| File                                             | What it is                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `auto-apply.sh`                                  | On the box: fast-forwards `main`, `compose up -d`, and requires the connector to come back healthy.              |
| `toon-hub-auto-apply.service` / `.timer`         | The systemd pair that runs it every five minutes. Install once; `ExecStart` assumes the checkout is at `/root/slop_machine`. |

The unit names carry `hub`, and the lock file is
`/var/lock/toon-hub-auto-apply.lock`, so a box that also holds a station
checkout does not have two timers fighting over one unit name and one lock.

**Applying costs a hub much less than it costs a station.** It restarts the
slot app, which is a few seconds in which a purchase in flight is a
connector-side `T01` — the app was unreachable, one of the only two outcomes
that escapes payment, so nobody is charged for it. No slot lapses early: the
roster is on a named volume, and the restarted app reconciles the connector's
own tables against it before it binds its port. And **nothing a viber is
watching passes through the slot app at all** — the forwarded routes it wrote
live in the connector, which is not restarted unless its pin changed. A hub can
apply mid-broadcast; a station cannot.

`auto-apply.sh` lives in the repository it applies, which has one consequence
worth knowing: a box sitting on a commit from **before** the script existed
cannot pull itself forward — `systemd` would be pointing `ExecStart` at a file
that is not there yet. Fast-forward that box by hand once and it takes over
from there.

## Secrets

`.env`, `*.key`, `*.pem`, `*.secret`, `operator-bearer.token`,
`operator-signing.key` and `operator-write.keys` in this directory are
gitignored, and the repository root ignores the same wildcards **and the two
operator files by name**. `connector.toml` is committed and holds nothing
secret: it names key _paths_, and the files themselves are mounted read-only at
runtime.

They are excluded from the **Docker build context** by the same patterns:
`docker-compose.local.yml` builds the slot app with `context: ../..`, so every
key in this directory is inside the directory handed to the daemon, and
`.dockerignore` is what keeps it out of the image. `pnpm test:image` builds with
dummy keys planted here and proves neither the context nor the image carries
them.

The two a hub holds that no other node in the fleet does are the **operator
signing key** and the **operator bearer token**, and the first of them is this
repository's own named hazard: it is the credential that mutates a hub's
routing table, so compromising the slot app means mutating what every station
this hub carries is reachable at. An ignore rule does not protect an
already-tracked file: if one lands, `git rm --cached` it **and rotate it** —
and rotating this one means deleting the old keyid from `operator-write.keys`
too, because the rotation is what closes the exposure and the allowlist is what
closes the door.
