# The playback contract: the budget lives on the paying side of the loopback line

**Status:** Accepted.

**Scope:** the versioned loopback HTTP surface between **the guide** — a browser SPA that can
render anything and pay for nothing — and **whatever pays**: today the devnet player
(`deploy/devnet/player.ts`), which serves this contract, and eventually the toon-client daemon,
which implements it **from this record** rather than from archaeology against the player's source.
Epic [#72](https://github.com/toon-protocol/slop_machine/issues/72) is the design;
[#74](https://github.com/toon-protocol/slop_machine/issues/74) built it.

## The line, and why it is where it is

Two parties stand on one machine, and the line between them is loopback HTTP.

On one side is a **web page**. It can be beautiful, it can be hosted, and it can be lied to: a
browser runs whatever pages a person opens, side by side, and no part of this design may assume
the page asking is the page we wrote. The repo's oldest rules already fence this side — no part of
the paying client can be a web app, because toon-client's keystore is Node-only and browser key
management is out of scope for ever.

On the other side is a **process that pays**: it holds the viber's channel, signs claims, and owns
the budget. In the devnet that process is the demo driver with the player in front of it; on a real
viber's machine it is the client daemon. Everything that can spend money lives on this side, and
nothing on this side renders a pixel.

The contract is the whole of what crosses the line. The guide can:

- **initiate vibing** with a station,
- **stop** it,
- **select a rung**, and
- **read state** — the live flag, each rung's price and how it splits between the broadcaster and
  the hub, spend totals, and where the playlists are.

That is all. No key, no claim, no channel operation, no payment header and no price-setting ever
crosses it: the economics the guide shows are **derived, never declared** — it renders what the
state reports, and the state reports what the paying side learned from the two nodes' own published
prices.

## The invariant, by name

**The budget lives on the paying side of the loopback line, and no request across it can raise
it.** The guide chooses within the budget — a rung, a station, whether to vibe at all — and never
sets it. A viber's "the most I am willing to spend per unit of time" is configuration of the paying
process, on the same footing as which key it holds, and a surface that let a page adjust it would
let *any* page adjust it, because the browser is a shared room.

Enforcement is loud rather than lenient, in two rules:

- **`/contract/v1/budget` is a reserved path and every request to it is refused** —
  `403 {"error": "budget_is_not_yours"}`, whatever the method, whatever the body. Reserving the
  path is deliberate: a client that tries learns the rule by name, instead of a `404` that reads as
  "perhaps in v2".
- **A `budget` or `budgetPerSecond` key smuggled into any write's body is refused the same way**,
  `403 budget_is_not_yours`, rather than the field being quietly dropped. Silently ignoring it
  would leave a guide believing it had set what it had not.

Both rules are held by a literal in a test — the contract suite raises the budget across the line,
asserts the refusal, and asserts the budget stood.

The budget is *readable* in the state, because choosing within it requires knowing it. Read-only is
the whole point, not a limitation.

## The origin allowlist on the spend-initiating surface

Loopback binding does not fence the browser, because the browser is on loopback too. Any page a
person has open — this design's own guide or a malicious stranger — can make the browser send a
`POST` at `127.0.0.1`. Reading the answer is already denied cross-origin by the browser itself, but
*acting* does not require reading: a fire-and-forget `POST /contract/v1/vibe` from a hostile page
is a spend the viber never chose. So the writes — `/vibe`, `/stop`, `/rung` — check the request's
`Origin`:

- **No `Origin` header means the caller is not a web page** — curl, the paying side's own tooling,
  another local process. Those are the user's own machine, which the loopback binding is the fence
  for, and they are allowed.
- **An `Origin` present must be on the paying side's allowlist**, or the write is refused
  `403 {"error": "origin_not_allowed"}` before anything else is read. The allowlist is the paying
  side's own configuration: the devnet player allowlists its own page's origin by construction and
  takes further origins as an option; a daemon lists the origins its operator trusts the guide at.
- **CORS grants follow the same list.** `Access-Control-Allow-Origin` is emitted only for an
  allowlisted origin — on reads as well as writes, because spend totals are the viber's own
  business — and a preflight `OPTIONS` from any other origin is refused. A page not on the list can
  neither act nor read.

## The surface, versioned

The version is in the path — `/contract/v1/` — because the two sides ship separately: a hosted
guide meets whatever daemon a machine happens to run. A breaking change is a new prefix, never a
changed answer at the old one, and a version the paying side does not speak is answered
`404 {"error": "unknown_contract_version"}`, so a guide can say *which side is behind* instead of
rendering garbage.

| Method | Path                 | Body                  | What it does                                          |
| ------ | -------------------- | --------------------- | ----------------------------------------------------- |
| `GET`  | `/contract/v1/state` | —                     | the whole of what the guide may know (below)          |
| `POST` | `/contract/v1/vibe`  | `{"station": string}` | initiate vibing with that station                     |
| `POST` | `/contract/v1/stop`  | —                     | stop vibing                                           |
| `POST` | `/contract/v1/rung`  | `{"rung": string}`    | select the rung the viber is vibing at                |
| any    | `/contract/v1/budget`| any                   | **always refused** `403 budget_is_not_yours`          |

Every answer is `application/json` with `Cache-Control: no-store` — all of this is stale within
seconds. A write answers with the state, so the guide learns the result from the same shape it
learns everything else. A known path with the wrong method is `405 {"error":
"method_not_allowed"}`.

**The state:**

```json
{
  "contract": "v1",
  "station": "g.toon.slopmachine.<handle>",
  "vibing": false,
  "live": false,
  "rung": "480p" | null,
  "segmentSeconds": 2,
  "budgetPerSecond": "600",
  "rungs": [
    {
      "rung": "audio",
      "price": "220",
      "toStation": "200",
      "toHub": "20",
      "playlist": "http://127.0.0.1:<port>/hls/audio.m3u8",
      "edge": 41 | null,
      "bought": 12,
      "spent": "2640"
    }
  ],
  "spent": "2930",
  "toStation": "2690",
  "toHub": "240",
  "packets": 14
}
```

Every amount is a **decimal string of base units** — these are `bigint`s on the paying side, and a
`u64` through a double is a price that means something else. `live` is the station's own fact,
carried through from its paid *now*; `vibing` is this viber's, and the two are different questions.
`price` is what one segment costs the viber across the hop; `toStation` and `toHub` are how that
splits **at the two nodes' own published prices** — the station's termination price and the hub's
carriage — never a figure the guide or the contract invented. The totals are the paying side's
ledger, `now` pulls included, which is why they are carried rather than left for the guide to
multiply out of per-rung counts. `playlist` is where that rung's synthesized playlist is served, on
loopback, and it is a location rather than a promise — a rung nobody has bought at holds an empty
window.

**Refusals**, each a named error in a JSON body:

| Status | Error                      | What it is about                                                  |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| `400`  | `no_station` / `no_rung`   | the write's one required key is missing                           |
| `400`  | `unreadable_body`          | a body that is not JSON                                           |
| `403`  | `origin_not_allowed`       | a web page the paying side does not know tried to initiate spend  |
| `403`  | `budget_is_not_yours`      | the invariant, by name                                            |
| `404`  | `unknown_station`          | a station this payer holds no channel toward                      |
| `404`  | `unknown_rung`             | a rung the station does not offer — same name the origin uses     |
| `404`  | `unknown_contract_version` | a `/contract/…` path outside `v1`                                 |
| `404`  | `unknown_contract_path`    | a `v1` path this version does not define                          |
| `405`  | `method_not_allowed`       | a known path, the wrong method                                    |

None of these costs anybody anything — nothing on this surface is a paid address, which is exactly
the point of the line. A refusal here is free in the way a refusal at a connector-priced address
can never be.

## What the semantics leave to the paying side

- **`/vibe` and `/stop` are idempotent**, and the paying side may itself start or stop vibing — a
  budget exhausted, a channel closed, a demo that starts itself. The state is the record; the
  writes are requests, not the only cause.
- **Selecting a rung names the rung the viber is vibing at.** While vibing, the paying side buys at
  least that rung; it **may** hold others within the budget — the devnet driver buys its whole
  two-rung ladder so a person can flip without a gap, and a daemon on a tight budget buys one. What
  it may never do is exceed the budget, whatever was selected.
- **`unknown_station` is about channels, not directories.** The paying side vibes only with
  stations it can pay, and paying a station means holding a channel toward its hub. The devnet
  player knows exactly one station; a daemon knows the ones it was configured for. Discovery is the
  guide's business, over a relay's free reads, and is not this surface.

## Loopback, pinned

The paying side binds `127.0.0.1` and **takes no setting that could move it**. Two different things
are behind that, and both hold:

- The playlists and segments it serves were **bought** — every `.ts` file in the player's window
  arrived as the body of a fulfilled packet that spent a claim. Serving them off-box would be
  reselling them: an unpaid, unpriced copy of exactly what the station sells, standing outside
  every fence the connector provides.
- The contract surface initiates **spend**. Off-box it would let another machine spend this
  viber's money, with only the origin allowlist — a browser convention — in the way.

This is the same posture as the origin's segment port and the slot app's port, published on no
interface: the difference is only that here the interface that does exist is loopback, because a
browser on the same machine is the one client the surface is for.

## What this is not

- **Not a payment surface.** No claim, key, channel write or price crosses the line. The contract
  carries *facts about* money — prices read from the two nodes, totals from the paying side's own
  ledger — and no way to move any.
- **Not the demo page's whole API.** The devnet page also shows the broadcaster's side — claims
  banked, a redeem button — and those stay on the demo's own `/api/` paths, outside the contract:
  a viber's daemon has no broadcaster in it, and a contract that carried one would be specifying
  the demo rather than the product.
- **Not discovery.** Which stations exist, what they carry, what they cost before a channel is
  open — that is the announcement's business, read free off a relay. The contract begins where a
  viber has chosen.

## Consequences

- **The toon-client daemon implements this record.** A daemon that serves `/contract/v1/` as
  written here is a paying side the guide already works against, because the guide is developed
  against the devnet player serving the same thing.
- **The invariant is held by tests, not only by this prose.** The contract suite
  (`deploy/devnet/contract.test.ts`, in the ordinary run) boots the real player, attempts to raise
  the budget across the line, and asserts the refusal and that the budget stood; the devnet suite
  does the same in the full topology, with real money moving underneath.
- **A new capability is a new route under the current version, or a new version** — never a
  repurposed answer. The version string a state carries is what lets a guide degrade honestly.
- **The origin allowlist is configuration of the paying side**, like the budget: nothing across
  the line can extend it, for the same reason nothing across the line can raise the budget.
