# radio

**Audio you get paid to broadcast.** A stream origin that sits behind the
[TOON connector](https://github.com/toon-protocol/connector), so listeners pay
per request and the origin never sees a payment.

The radio server itself contains no payment code at all. It ingests audio and
serves segments; by the time a request reaches it, it is already paid for. That
separation is the entire design, and it is the same one the
[relay](https://github.com/toon-protocol/relay) uses — everything below the
dashed line changes per app, everything above it does not.

```
                          ╔═══════════════════════════════════╗
  listener ─ POST /ilp ──▶║  Caddy  ──▶  connector            ║  pays, verifies
   (paid segment)         ║   :443        :3000               ║  ─────────────
                          ║                 │                 ║
                          ║ ─ ─ ─ ─ ─ ─ ─ ─ │ ─ ─ ─ ─ ─ ─ ─ ─ ║
                          ║                 ▼                 ║
  broadcaster ─ ingest ──▶║  Caddy  ──▶  radio  :3100         ║  ingests, serves
   (authenticated)        ║   :443        │                   ║
                          ╚═══════════════════════════════════╝
                                          └── segments/
```

Only Caddy is reachable from the internet. The origin's segment port is not
published on any interface — the only route to it is a paid packet through the
connector.

> **Status: nothing is implemented yet.** This repository holds the design
> above and no code. The diagram is the intended shape, not a description of a
> running system. There is no devnet deployment, no published image, and no
> package to install.

## Why the connector does the paying

Metered audio is the case per-request payment is actually good at. A listener
pays for the segments they pull and stops paying when they stop listening —
no subscription, no account, no card on file, and no payment logic in the
origin. Pricing a route is a connector config change, not a code change.

Because the origin is a plain HTTP server, it can be anything that emits
segments: a live encoder, a file-backed archive, or a generated feed.

## Open design questions

These are unsettled, and the answers will shape the first implementation:

- **Which direction pays.** Paid listens with authenticated ingest is the
  default drawn above. Paid *ingest* — broadcasters pay for airtime, listening
  is free — inverts it and is the closer analogue to the relay's pay-to-write
  model. It may be that both are routes on the same node.
- **Unit of payment.** Per segment is the obvious granularity for HLS-style
  delivery, but it puts a payment on the hot path every few seconds. Prepaid
  windows are the alternative.
- **Discovery.** Whether a station announces itself over Nostr (as the rest of
  the network does) or through ArNS names.

## Context

TOON Protocol is pay-to-use infrastructure over Interledger, split into
per-team repos. Shared context, protocol docs, and the agent skills live in
[toon-meta](https://github.com/toon-protocol/toon-meta) — start at
[`context/context.md`](https://github.com/toon-protocol/toon-meta/blob/main/context/context.md).

The two repos worth reading before this one:

| Repo                                                        | Why                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| [connector](https://github.com/toon-protocol/connector)     | The paid reverse proxy every TOON app sits behind.         |
| [relay](https://github.com/toon-protocol/relay)             | The reference for putting an ordinary app behind it.       |

To *use* the network rather than run a node, start with the
[toon-client rig](https://github.com/toon-protocol/toon-client/blob/main/packages/rig/README.md).
