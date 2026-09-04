# slop_machine

**Vibes you get paid to broadcast.** Listeners and viewers — *vibers* — pay per segment as they
watch or listen, and the money lands with the broadcaster. No subscription, no account, no card on
file, and no payment code in any app here.

slop_machine is two toon apps that ship together. Both sit behind the
[TOON connector](https://github.com/toon-protocol/connector), so by the time a request reaches
either one it is already paid for. That separation is the whole design, and it is the same one
[relay](https://github.com/toon-protocol/relay) uses.

- A **station** is one broadcaster's node: an **origin** that ingests their vibes and serves
  segments of it.
- A **hub** is the node broadcasters peer with and announce to. It routes vibers' packets on to
  stations and sells the **slots** that make a station reachable.

The vocabulary is not decoration — it is written down in [`CONTEXT.md`](./CONTEXT.md), and the
decisions behind the shape are in [`docs/adr/`](./docs/adr/).

> **Status: the station origin ingests, encodes, serves — and reports its *now*.** It accepts an
> RTMP or RTMPS publish carrying the station's stream key, supervises an `ffmpeg` per rung that cuts
> the vibes into fixed-duration segments, and serves them at `/segments/<rung>/<sequence>.ts` on its
> segment port. `GET /now` on that same port reports the station's *now* — every rung's current
> sequence number, the fixed segment duration, and whether ingest is live — so a viber starts at the
> live edge instead of at the beginning. The ladder is ordinary configuration (`TOON_RUNGS`),
> defaulting to the four-rung placeholder ladder, and a ladder that could break the 2 MiB segment
> budget is refused at boot. Segments are kept on a sliding window evicted by count
> (`TOON_RETAIN_SEGMENTS`), so a long broadcast does not fill the broadcaster's disk and a span past
> the window is a clean not-found rather than a stale body. `GET /encode`, unpriced and reachable
> only from inside the node, tells the broadcaster whether their box is actually keeping up with the
> ladder they chose. A **`deploy/` bundle** now runs the whole station — Caddy, the connector that
> prices one route per rung and one for `/now`, and the origin — on exactly three published ports,
> and the segment port is not one of them. Every merge to `main` publishes
> `ghcr.io/toon-protocol/station-origin`, so a fresh box brings a station up with `docker compose up
> -d` and no local build. There is still no devnet node.
> See [`CLAUDE.md`](./CLAUDE.md) for what exists and how to build and test it, and
> [`deploy/README.md`](./deploy/README.md) for how to bring a station up.

## A station

```
                        ╔═══════════════════════════════════════════════╗
  viber ── paid pull ─────▶ Caddy ────▶ connector ────▶ origin           ║
   (one per segment)    ║   :80 :443     :3000            :3100          ║
                        ║                one route per    segments,      ║
                        ║                rung, one /now   /now           ║
                        ║                                   ▲            ║
  broadcaster ── RTMPS ──────────────────────────────────────┘           ║
   (stream key)         ║   :1935                        segments/<rung>/║
                        ╚═══════════════════════════════════════════════╝

     published   80, 443  (Caddy)   ·   1935  (origin, RTMPS ingest)
     loopback    3000     (the connector's client edge, on-box operator calls)
     neither     3100     (the origin's segment port — reachable from nowhere)
```

**Exactly three published ports, and the segment port is not one of them:** Caddy's 80 and 443, and
the origin's RTMPS ingest port. Caddy does **not** carry the RTMP path — stock Caddy does not speak
RTMP and a custom Caddy image would break the fleet's stock-TLS-front norm, so the origin publishes
1935 itself and terminates that TLS. The connector's client edge is published to loopback only, for
on-box operator calls. The origin's **segment** port is exposed on the compose network and nowhere
else.

The broadcaster points OBS — or anything that speaks RTMP — at the origin over RTMPS with their
stream key, and the origin cuts the vibes into HLS segments with `ffmpeg`. A viber pulls one at a
time from `/segments/<rung>/<sequence>.ts`, through the connector, which prices one route per rung
prefix so that choosing a rung is choosing a price.

A viber finds the live edge first, from one cheap address of its own: `GET /now` reports every
rung's current sequence number, the fixed segment duration, and whether ingest is live. **No
playlist is served from a station** — nothing free is, and the client daemon already stands between
the station and the player, so it synthesizes whatever playlist its player needs over loopback.

Ingest is gated on the stream key — checked on the publish, before a byte is transcoded — and it is
never paid: supplying vibes costs a broadcaster nothing per second. The only route to a
broadcaster's vibes is a paid packet through the connector, because the segment port is reachable
from nowhere else. `/health` and `/encode` answer on that same port, unpriced and with **no
connector route at all**: they are the broadcaster-operator's own diagnostics, from inside the node.

The files that run all of this are in [`deploy/`](./deploy/).

The broadcaster **is** the operator. They own the origin and the connector in front of it, they hold
the settlement key, and vibers' payments accrue to them directly. Nobody collects on a broadcaster's
behalf and nobody owes them a payout.

## A hub

```
                     ╔════════════════════════════════════════╗
  viber ────────────▶║  Caddy ──▶ connector                   ║
   (one channel)     ║             │                          ║
                     ║             ├─▶ relay      announce    ║  stock image
                     ║             ├─▶ slot app   buy a slot  ║  this repo
                     ║             │                          ║
                     ║             └─▶ peers ────────────────────▶ g.toon.slopmachine.<broadcaster>
                     ╚════════════════════════════════════════╝
```

A viber holds **one** payment channel — with the hub — and reaches every station by ILP address.
Without this, a channel is derived from its two participants, so paying a station you just found
would mean an on-chain transaction, gas and locked capital *per broadcaster*. The hub is what makes
sampling a new broadcaster a packet instead of a commitment.

The hub is mostly not new software: the announcement surface is a stock deployment of the
**relay** toon app, and the router is the stock connector. The only new part is the **slot app**.

## What money does

- **Vibers pay per segment.** Metered vibes are the case per-request payment is actually good at:
  you pay for what you pull and stop paying when you stop. A price attaches to a handler, so each
  quality **rung** is its own address at its own price — and a viber sets a *budget* the player
  climbs and drops rungs to fit. Adaptive bitrate against money instead of bandwidth
  ([ADR 0002](docs/adr/0002-bitrate-follows-the-vibers-budget.md)).
- **Broadcasters buy slots.** Paying the hub gets a station into the routing table and the
  directory. The slot lapses unless renewed, so dead stations fall out on their own
  ([ADR 0003](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)).
- **The hub earns carriage.** A fee attaches to a peering, so the hub is paid per packet it carries
  — never by holding anyone's money.

Pricing any of this is connector config, not application code.

## Discovery

A broadcaster announces to the hub's relay. The announcement carries the station's address, its
rungs and their prices, and an Arweave URL for clips stored via
[store](https://github.com/toon-protocol/store). Reads are free, so a viber browses the
**broadcaster page** in the client app — clips, an about, a viber count — and decides before
spending anything. Nothing free is served from a station node, which is what keeps the only route to
an origin a paid packet.

## Vibing

The client is a daemon built on
[toon-client](https://github.com/toon-protocol/toon-client): it holds the keystore and the channel,
pays per segment, and serves the result to an ordinary player over loopback. Payment is the daemon's
job; playback is `mpv`'s.

## Context

TOON Protocol is pay-to-use infrastructure over Interledger, split into per-team repos. Shared
context, protocol docs, and the agent skills live in
[toon-meta](https://github.com/toon-protocol/toon-meta) — start at
[`context/context.md`](https://github.com/toon-protocol/toon-meta/blob/main/context/context.md).

| Repo                                                    | Why                                                      |
| ------------------------------------------------------- | -------------------------------------------------------- |
| [connector](https://github.com/toon-protocol/connector) | The paid reverse proxy every toon app sits behind.       |
| [relay](https://github.com/toon-protocol/relay)         | The reference for putting an app behind it — and the hub's announcement surface. |
| [toon-client](https://github.com/toon-protocol/toon-client) | The payer side, which the client daemon is built on.  |
