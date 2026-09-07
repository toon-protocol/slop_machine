# A station announces itself in four events

**Status:** Accepted (2026-09-07).

**Scope:** the announcement schema — what a broadcaster publishes to a hub's relay to be found, and
what a discovery surface (the guide, or any Nostr client) reads back. Feeds
[#72](https://github.com/toon-protocol/slop_machine/issues/72); made real by
[#73](https://github.com/toon-protocol/slop_machine/issues/73), whose devnet emits every event below
and reads each one back off the relay's free NIP-01 surface.

A station being **reachable** is what a slot buys (ADR 0003). A station being **found** is this
record: the events a broadcaster signs and pays the hub's relay to carry. Reading them is free —
NIP-01 over the relay's read port — and publishing them is paid, one ordinary write through the
hub's `announce` route at that route's price. An announcement is a **claim by the broadcaster, not a
fact checked by the hub**, and the last section of this record says exactly how far that claim can
be trusted.

## One keypair, the broadcaster's own

Every event below is signed by a **per-broadcaster Nostr keypair** — an ordinary secp256k1 schnorr
key, distinct from every key the money touches: not the station's ILP signer, not its settlement
key, not the stream key, not any operator seed. It is the broadcaster's *public voice*, and keeping
it apart from the keys that hold value means a leaked announcement key costs a broadcaster their
byline and nothing else.

The devnet mints one per run into its ignored working directory, beside every other credential and
under the same rule: **no credential literal enters this repository, not even a test's.**

## The four events

### 1. The profile — kind `0`, standard

A plain [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) metadata event:
`content` is a JSON object carrying `name` (the display name), `about`, and `picture` (the avatar
URL). Nothing TOON-specific in it, deliberately: **any Nostr client on earth can render and follow
a broadcaster** without the guide existing, which is free interop nothing custom could buy back.
Kind 0 is replaceable by definition, so a profile edit is one write and stale profiles never
linger.

### 2. The station announcement — kind `11750`, replaceable

The claim that the station exists, where it is reachable, what it carries, and what vibing with it
costs. Tags:

| Tag                              | Meaning                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `["ilp", "<prefix>"]`            | the station's ILP address — the prefix its hub granted it          |
| `["segment", "<seconds>"]`       | the fixed segment duration, so a per-segment price is a rate       |
| `["rung", "<name>", "<price>"]`  | one per rung, **in ladder order**; price a decimal string of base units |
| `["t", "<category>"]`            | one per category, free-form — the broadcaster describes their own vibes |

`content` is free text — an about for the station itself, distinct from the broadcaster's.

**The price is the station's own per-segment termination price** — the number in the station
connector's own published routes, which is the one price the broadcaster is authoritative about. A
viber's all-in price is that plus the hub's carriage, and the hub prices its own carried route; a
broadcaster cannot speak for a hub's fee and this schema does not let them try. The emitting code
**derives** these tags from the station connector's self-description rather than restating them, so
the announcement and the routes cannot drift.

**Simple replaceable (the `10000`–`19999` range), nothing parameterized.** One node carries one
station and one broadcaster operates one node — one station per broadcaster is a domain fact — so
there is no second station for a `d` tag to tell apart. Republishing replaces: a rung or price
change is one write, and stale ladders never linger. `11750` itself is an unassigned kind chosen
high in the simple-replaceable range, clear of the NIP-51 list block that grows upward from
`10000`; the heartbeat sits at the adjacent number because the two are one schema.

Categories are free-form `t` tags because a broadcaster describes their own vibes rather than
fitting a list somebody else curated — and `t` is the tag every Nostr relay and client already
indexes, so browsing by category is a stock filter, not a custom protocol.

### 3. The heartbeat — kind `11751`, replaceable, with a NIP-40 expiry

**Liveness is the existence of an unexpired heartbeat, and nothing else.** While on the air, the
broadcaster republishes a kind `11751` event carrying a short
[NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md) `["expiration", "<unix
seconds>"]` tag — expiry a small multiple of the republish interval, so one missed beat is not a
false death. A consumer reads the station as live exactly when it can read a heartbeat whose
expiration is still in the future, and as off the air otherwise.

This is **crash-safe by construction, and there is deliberately no sign-off event.** A sign-off is
published by exactly the process that just died, so a design that needed one would show every
crashed station as live for ever — the same falsehood the origin's idle rule exists to kill, one
layer up. Here the false claim expires on its own: the relay enforces NIP-40 and stops serving an
expired event, and a consumer must apply the same rule itself regardless, so a relay that does not
prune still yields the truth. Replaceable, so a relay holds at most one heartbeat per broadcaster
rather than a growing trail of them.

**The heartbeat goes through the paid `announce` route, not the free ephemeral lane**, and the
choice is the point of the lane split. An ephemeral kind (`20000`–`29999`) is forwarded to current
subscribers and never stored, so a consumer who arrives a minute later would read no liveness at
all — liveness has to be a *stored fact that decays*, which is exactly what NIP-40 on a stored
event is and what an ephemeral event is not. The relay's `/write-ephemeral` refuses non-ephemeral
kinds anyway, and the free lane's only admission control is a rate limit — a heartbeat every few
seconds from every station on a hub is precisely the sustained write load that lane must not carry
for nothing. One base unit per beat is the announce route doing its job.

### 4. The clip — kind `1063`, NIP-94-style, one event per clip

Each clip is its own event, in the shape of
[NIP-94](https://github.com/nostr-protocol/nips/blob/master/94.md) file metadata: `["url", "<the
Arweave URL>"]`, `["title", "<title>"]`, `["duration", "<seconds>"]`, with `content` free for a
description and the event's own `created_at` as the posted-at. Kind `1063` is the standard
file-metadata kind, so generic clients render a clip without knowing what a station is; a consumer
finds a broadcaster's clips by querying their pubkey for that kind.

One event per clip — **never a list on the announcement** — so publishing a new clip touches
nothing else: the announcement is replaceable and a clip list on it would make every new clip a
rewrite of the ladder. Clips are free to read (an Arweave gateway fetch) and were paid to write
once, at the store; the announcement layer only ever points at them.

## The tie between a handle and a pubkey is an unverified claim in v1

Said out loud, because nothing in this schema checks it: **nothing attests that the pubkey signing
an announcement owns the station address it names.** A squatter can announce somebody else's
prefix. What bounds the damage today:

- every write is **paid**, so squatting costs money per event and scales against the squatter;
- the address a squatter claims still routes to the real station — an announcement confers no
  reachability, only findability — so the lie is about the byline, not the vibes;
- consumers **dedupe first-mover-wins per station address**: where two pubkeys announce one ILP
  prefix, the earlier `created_at` wins and the later announcement is dropped. First-mover is the
  honest name for what this is — a heuristic, not an authority.

The fix is named and deliberately not built here: **hub attestation at slot purchase, belonging to
the slot app.** The hub is the one party that verifiably knows which payer bought which prefix, so
the buy is where a broadcaster's announcement pubkey could be bound to their granted prefix — an
attestation event signed by the hub, or a signed roster the guide reads. That is future slot-app
work; v1 accepts the claim and dedupes.

## Consequences

- **The devnet lives this schema.** Its broadcaster publishes all four events through the hub's
  paid announce route, and its suite reads each one back off the relay's free NIP-01 surface — the
  seam the guide will stand at — including the heartbeat actually expiring and the station reading
  as off the air.
- **Kind numbers `11750` and `11751` are this repository's to keep stable.** They are unassigned
  upstream; if a NIP ever lands on either, migrating is a schema change with its own record.
- **The announcement carries the station's price, not the viber's.** Any surface that shows an
  all-in price derives it from the hub's own priced route, never by guessing a fee.
- **A discovery surface must apply NIP-40 itself.** The relay enforcing expiry is a courtesy, not
  the contract; a consumer that trusted a non-pruning relay would show dead stations live.
- **The signing dependency stays out of the apps.** Announcing is the broadcaster's client-side
  act; in this repository the only signer of these events is the devnet, and `nostr-tools` is a
  devnet-only development dependency on exactly the payer's terms — in neither package's manifest,
  imported by nothing under `packages/`, pinned exact.
