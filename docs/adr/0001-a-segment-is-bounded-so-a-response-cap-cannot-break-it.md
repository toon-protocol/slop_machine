# A segment is bounded, so a response cap cannot break it

**Status:** Accepted.

**Scope:** slopmachine station origin — the encoder ladder and the segmenter.

A station's vibes come back to a viber as the **response** to a paid request, and nothing in the
connector bounds that response. The request side has a hard **2 MiB** ceiling — axum's
`DefaultBodyLimit`, which the client-edge router does not override and which the ILP-over-HTTP
profile calls "deliberately not a config knob". The response side has no equivalent: the fulfill's
data is an unbounded OER var-octet-string, BTP's length fields are `u32`, and no size check exists
anywhere on the return path.

**A segment is nevertheless bounded to 2 MiB, by fixing its duration and capping the bitrate of
every rung so that worst-case bitrate × duration stays under the budget.**

## Why bound something nothing is enforcing

Because the absence is an accident of nobody having asked. No ADR, spec, or comment in the connector
mentions streaming, video, HLS, segments, or large responses at all — the download direction has
never been designed for. [Connector ADR 0065](https://github.com/toon-protocol/connector/blob/main/docs/adr/0065-a-price-is-a-schedule-over-payload-length.md)
lists a per-route payload ceiling as explicitly *"not decided here"*, so the ceiling that does not
exist today is a known open question upstream rather than a settled guarantee.

If that question is ever answered by mirroring the request cap onto responses, a station whose
segments already fit under 2 MiB keeps working and one that does not goes dark. Choosing the number
now costs nothing and converts a silent dependency on someone else's missing check into a stated
constraint of our own.

## Consequences

- **Duration is fixed and bitrate is the variable.** A rung's ladder is sized against the byte
  budget, not chosen for image quality alone. High-bitrate video needs shorter segments, which means
  more requests and more payments per minute.
- **Flat pricing stays honest.** Because duration is fixed, a flat per-segment price is a per-second
  rate, which is what makes a [budget](../../CONTEXT.md) a meaningful control.
- **The upstream question should be asked.** slopmachine is the reason large responses now have a
  first user. Whether the connector intends to support them belongs in that repo, not this one.
