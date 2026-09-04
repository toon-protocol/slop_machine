# Bitrate follows the viber's budget, not the bandwidth

**Status:** Accepted.

**Scope:** slopmachine station origin (the rung ladder) and the client daemon (rung selection).

**Each rung is its own address with its own price, and a viber sets a budget the player climbs and
drops rungs to fit.** Ordinary adaptive bitrate adapts to available throughput. Here the scarce
resource is money, so the same machinery adapts to it: paying more buys better vibes, and a viber
who wants to spend less watches something smaller.

## Why not price the bytes directly

Because the connector cannot. A price is a schedule over the **inbound** packet's payload length —
the charge is computed from `prepare.data.len()`, the sealed gift wrap, because that is the one
length every hop already knows without opening anything
([connector ADR 0065](https://github.com/toon-protocol/connector/blob/main/docs/adr/0065-a-price-is-a-schedule-over-payload-length.md)).

A viber's request is a few hundred bytes asking for a segment; the megabytes are in the fulfill, and
the fulfill is charged nothing. So a `per_kib` slope prices *asking*, not *receiving*. Raising it
would charge more for a bigger request while the vibes stayed free. **For a station the slope is
always zero and the price is flat per segment.**

Quality therefore has to be priced by *which handler you address*, and a price attaches to a
handler. HLS already ships the abstraction — a master playlist of variants — so a rung is a variant
that also differs in price.

## Consequences

- **A rung's price is discoverable with no new surface**: the client's existing `price(destination)`
  answers it, and the budget logic only ever compares numbers it can already query.
- **The wallet's spend rate becomes a control rather than a readout**, which is what makes the bar
  plugin worth having.
- **A manual pin must exist.** Budget-first is the default, but someone will always want to fix the
  top rung, and refusing that is worse than supporting it.
- **A future reader will try to "fix" this** by setting `per_kib` on a station route and expecting
  bigger segments to cost more. It will silently do nothing, because the charge never sees them.
