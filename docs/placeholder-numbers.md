# Placeholder numbers

**These are scaffolding, not decisions.** Nothing here has been reasoned about economically — the
numbers exist so the first implementation has something to run with, and so that a reader can tell
a placeholder from a choice. None of them is an [ADR](adr/), and changing one needs no ceremony.

What they *are* is internally consistent: the ladder satisfies
[ADR 0001](adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)'s byte bound, and the
prices are roughly proportional to bitrate, since bandwidth is the broadcaster's cost.

All prices are in the settlement token's smallest unit. USDC has 6 decimals, so `1000` is
0.001 USDC — a tenth of a cent.

## Segment duration

**4 seconds.** Fifteen segments a minute, so a flat per-segment price is a per-minute rate divided
by fifteen.

## The rung ladder

The binding constraint is ADR 0001: worst-case bitrate × duration must stay under 2 MiB. At 4-second
segments that is a hard ceiling of **4.19 Mbit/s**, and the top rung sits at 3 Mbit/s to leave
headroom for VBR overshoot.

| Rung      | Bitrate    | Segment size | Price/segment | ≈ per hour |
| --------- | ---------- | ------------ | ------------- | ---------- |
| `audio`   | 128 kbit/s | ~64 KB       | `200`         | $0.18      |
| `480p`    | 800 kbit/s | ~400 KB      | `1000`        | $0.90      |
| `720p`    | 1.8 Mbit/s | ~900 KB      | `2000`        | $1.80      |
| `1080p`   | 3 Mbit/s   | ~1.4 MiB     | `3500`        | $3.15      |

The station origin ships this ladder as its default, written the way an operator writes it:

```
TOON_RUNGS="audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k"
```

`audio` carries no picture at all, which is what makes it the cheap rung. Changing a number here
needs no ceremony — but the origin recomputes bitrate × duration at every start and **refuses to
start, naming the rung**, if one exceeds the byte budget.

Do not add a rung above 3 Mbit/s without re-reading ADR 0001 — the ceiling is what keeps a station
working if the connector ever caps responses the way it caps requests.

Every one of these prices is **flat per segment**, and `per_kib` is never set on a station route —
a price is a schedule over the *inbound* payload, so a slope would bill the viber's few-hundred-byte
request and do nothing at all for the megabyte in the fulfill ([ADR 0002](adr/0002-bitrate-follows-the-vibers-budget.md)).
Bitrate is priced by address, which is what the four routes are for.

## The station's *now*

**`50` per pull.** The cheapest thing a station sells, and its own connector route — `/now` sits
outside `/segments` and beneath no rung, so it is priced on its own and no segment is ever reachable
at it.

Not proportional to bytes the way the ladder is: `/now` is a couple of hundred bytes of JSON, and
strictly proportional would round to nothing. It is a **floor** price — a quarter of the cheapest
rung — chosen so that re-syncing is never a meaningful fraction of watching, while still being
non-zero, because nothing free is served from a station node. A viber pulls it to join and to
recover from a gap, not once per segment.

## Retention

**60 segments per rung.** At the 4-second default that is a four-minute sliding window, evicted by
count — a segment past it is unlinked and a request for it is a clean `unknown_segment` the viber
re-syncs from.

Count rather than age or bytes is what makes the disk bound arithmetic an operator can do from the
two lines they wrote: the window times the ladder's worst-case segment. On the default ladder at
4-second segments that is 60 × (64 000 + 464 000 + 964 000 + 1 564 000) bytes ≈ **175 MiB**, and the
origin prints the number at boot.

```
TOON_RETAIN_SEGMENTS=60
```

Far more slack than a viber pulling at the live edge needs, and small enough that a station runs on
the cheapest box a broadcaster would rent. Raise it and re-read the arithmetic above; a window of
zero is refused at boot, because a station that kept nothing would look live and sell nothing.

## Viber defaults

**Default budget: `20000`/minute** (about $0.02/min, $1.20/hour), which settles a viber at `720p`
and drops them to `480p` under contention. Low enough that trying a station is not a decision.

## Slots

- **Price:** `1000000` (about $1.00) per period.
- **Period:** 30 days.
- **Cap:** `100` slots held at once.

Deliberately cheap. The slot exists to make admission self-service and to lapse dead stations, not
to be revenue — carriage is where a hub earns.

The cap is the hub's **collateral** bound rather than a performance one: every admission opens a
channel the hub fronts collateral toward, so at the placeholder collateral figure below a full
roster is about $5,000 committed. It is the number a hub operator is most likely to change first.
Zero is a legal setting and means the hub is admitting nobody — full, closed, or not yet funded —
and the quote says so at its own cheap address rather than the buy refusing at the expensive one.

The slot app resolves all three the way everything else here resolves: flags over environment over
defaults, `--slot-price`/`TOON_SLOT_PRICE`,
`--slot-period-seconds`/`TOON_SLOT_PERIOD_SECONDS` and `--slot-cap`/`TOON_SLOT_CAP`. The period is
in **seconds** because that is what makes a lapse testable without a fake clock.

## The slot quote

**`50` per pull.** What a broadcaster pays to ask what a slot costs, which prefix the hub would
grant them, and whether there is room — the same floor price, and for the same reason, as a
station's own *now*.

It is priced apart from the buy because it is where **every foreseeable refusal lives**. A
connector fulfills on any complete answer from an app whatever its status, so a refusal at the buy
address is a refusal the broadcaster paid `1000000` for
([ADR 0003](adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md)'s amendment). Moving "no
capacity" and "here is what you would be granted" onto a floor-priced address is what keeps the
expensive one for purchases that are already going to succeed. The two sit beneath **different
connector prefixes** and always must, or one is reachable at the other's price.

## Hub carriage

- **Fee:** `20` per packet, flat, retained per hop.

At fifteen segments a minute that is roughly $0.018/hour per viber, or a few percent of what the
viber pays the station.

## Hub collateral

- **Per broadcaster:** `50000000` (about $50) in the channel the hub opens toward them.
- **Settle at:** 50% drawn.

This is the number most likely to be wrong. Hub capital grows linearly with the roster, and the
right value depends on settlement frequency against per-station throughput — neither of which is
known until something runs.
