# CONTEXT

Glossary for slopmachine — the hub and the station origin, which ship together.
Terms only — no implementation details.

This context does **not** redefine TOON Protocol vocabulary — that lives in
[`connector/CONTEXT.md`](https://github.com/toon-protocol/connector/blob/main/CONTEXT.md),
and where the two disagree, that one wins.

## Station

A single continuous, time-anchored broadcast, reached at its own address through
a hub. A station has a *now*: every viber
on it at the same moment is receiving the same vibes,
and vibes that have passed are past. One node carries one station.
_Avoid_: channel (a channel is a payment channel here, and the collision is
expensive), stream, feed

## Hub

The slopmachine node broadcasters peer with and announce to. It routes vibers'
packets on to stations, sells the slots that make a station reachable, and
carries discovery. A hub carries no vibes of its own — it is the one node in the
design that is never a station.
_Avoid_: server, platform, tracker, directory (it is not only a directory)

## Slot

What a broadcaster buys from a hub: the routing-table entry that makes their
station reachable at its address, bought with a paid request and lapsing unless
renewed. A slot is not a peering — the peering is what the hub's operator
creates in response to the purchase, and it remains the operator's act.
_Avoid_: peering (the connector owns that word, and conflating them is exactly
the confusion to avoid), listing, subscription, licence

## Broadcaster

The party that supplies a station's vibes and operates the node that carries it.
The broadcaster owns both the origin and the connector in front of it, holds the
settlement key vibers' payments accrue to, and buys a slot on a hub to be
reachable at all. Broadcaster and operator are the
same party — a station is not a slot on somebody else's node, and nobody
collects on a broadcaster's behalf.
_Avoid_: publisher, streamer, DJ, host

## Viber

The party that vibes with a station: consumes its vibes and pays for them,
segment by segment, as they play. May be a person with a player or a program; the station
does not distinguish them. Vibing is the paid direction; ingest is not. The term
is deliberately medium-neutral — a station carrying video has vibers, not
viewers.
_Avoid_: listener, viewer, audience, subscriber, client, consumer

## Vibe

To consume a station's vibes as they play, paying segment by segment. A viber
vibes *with* a station. The verb names the whole act — deciding, tuning in, and
paying are not separate things a viber does.
_Avoid_: listen, watch, stream, consume

## Vibes

A station's media: what a viber pays for, what a segment carries, and what comes
back in the fulfill. Audio, video, or both — the word is medium-neutral by
design, and it is a mass noun. A viber pays for vibes, not for a vibe.
_Avoid_: content, media, audio, video, airtime (the earlier name for this,
retired: airtime named a duration, and vibes are the thing itself)

## Viber count

How many vibers are on a station at a given moment. A station's live audience,
and the number a broadcaster page leads with. Named for the people, not the
vibes — "vibe count" would read as a count of media.
_Avoid_: vibe count, listener count, viewer count, concurrents, tune-ins

## Rung

One quality level a station offers its vibes at, priced separately from the
others. Choosing a rung is choosing a price: better vibes cost more per segment.
A station's rungs are announced with it, and change rarely.
_Avoid_: variant, bitrate, quality level, tier (a tier suggests a subscription)

## Budget

The most a viber is willing to spend per unit of time. The player climbs and
drops rungs to stay inside it, so a budget steers quality the way available
bandwidth does in ordinary streaming — the scarce resource is money, not
throughput. A viber may pin a rung by hand instead.
_Avoid_: spend limit, cap, price ceiling, allowance

## Broadcaster page

The free, public description of a station, which a viber reads to decide whether
to vibe: clips, an about, and whatever else carries the decision. Free to read,
hosted off the station node, and outside the paid path — it is what keeps trying a new broadcaster cheap,
because paying one at all means opening a payment channel with them.
_Avoid_: profile, landing page, station page, listing

## Segment

The unit in which a station's vibes are delivered — a short, self-contained span
of the broadcast, and the unit a viber pays for. Segments are the granularity a
viber pulls at, and on a live station they go stale. The same span exists as one
segment per rung.
_Avoid_: chunk, block, packet (a packet is what carries a segment, not the
segment itself)

## Ingest

The act of a broadcaster delivering vibes into a station. The counterpart to
vibing, and the other direction traffic can flow at a station. Ingest is
authenticated, never paid.
_Avoid_: upload, publish, push, feed

## Origin

The station's plain HTTP server: it ingests vibes and serves segments, and it
contains no payment code. By the time a request reaches the origin it is already
proven paid. The term is shared with the rest of the fleet, where it names the
same role behind the connector.
_Avoid_: backend, app server, upstream
