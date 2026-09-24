# How can one Pull pay both the platform and the Creator?

Research for [#3](https://github.com/toon-protocol/slop_machine/issues/3), part of the map [#1](https://github.com/toon-protocol/slop_machine/issues/1).
Inputs for [#9](https://github.com/toon-protocol/slop_machine/issues/9) (price and split) and [#8](https://github.com/toon-protocol/slop_machine/issues/8) (how a Player pays).

Paths are relative to `~/Work/TOON-Protocol/`. Terms follow `slop_machine/CONTEXT.md` (Slop, Creator, Player, Pull, Feed).

## Answer

TOON can express a split of a single Pull. A Pull's packet is addressed to the Creator. The platform's connector sits in the path, and the platform keeps its per-packet **peering fee** from that packet. This is the vibe_station hub pattern. Its catch is that the Creator must run a node that is online and answers every Pull. A Creator who publishes a static bundle with `slop publish` has no such node.

The option that fits a CLI-first Creator of static Slop is different. The platform terminates every Pull itself, keeps a per-Creator ledger, and pays Creators out of band: batched on-chain USDC transfers, or later a platform-to-Creator payment channel. The Creator then needs only a wallet address, and a Pull costs one hop. The cost is trust in the platform, delayed payment, and payout code that lives outside the connector.

## Facts the split and payer decisions need

1. **A fee is flat per packet, never a percentage.** `connector/docs/adr/0010-flat-per-packet-fee-and-minimum-delivery.md` sets it as protocol law. `0071-a-forward-crosses-a-denomination-at-a-declared-rate.md` restates that "a fee is still never proportional". A hop earns the difference between what it receives and what it forwards (0010, "Consequences").
2. **A fee attaches to a peering, not to a route.** There is one number per peer, whatever the destination (`connector/docs/adr/0061-a-fee-attaches-to-a-peering-not-to-a-route.md`). So a platform hub cannot charge Creator A a different carriage fee from Creator B on one peering. It can only do that by giving each Creator their own peering, which is the case anyway (one peering per station in vibe_station).
3. **The Player pays the whole path at the first connector.** A forwarded route carries a `price` at the client edge. That price buys the whole path, and the hop forwards `price − fee` (`connector/docs/adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md`). vibe_station prices each hub route at "the station's own price plus the hub's carriage" (`vibe_station/packages/slot-app/src/buy/buy.ts`, around lines 39 and 345). Through a hub, **Creator share = price − fee** and **platform share = fee**, both flat amounts per Pull. For a fixed-price Pull, any ratio can be written as a (price, fee) pair.
4. **A forward charges only on FULFILL.** A forwarded route "charges on the forward's FULFILL, never on its REJECT" (0028 status line, issue #1012). An app that does not answer within the packet's deadline is refused `R00` (`0064-a-deadline-bounds-the-wait-for-an-app-not-the-answer.md`). If the Creator's node is down, the Pull fails. The Player is not charged.
5. **Value moves when the terminating app answers, whatever it answers** (`0020-a-price-is-flat-and-attaches-to-a-handler.md`; `vibe_station/docs/adr/0003-...md`, first amendment). A Creator-side app cannot refuse a Pull for free.
6. **The terminating app learns who paid.** A terminating connector gives the app `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain`, but only for a payment it verified itself (`0040-a-verified-payment-is-stated-to-the-app.md`). In the platform-terminates options, the platform app knows the payer and chooses which Slop the Pull lands on. That is everything a per-Creator ledger needs.
7. **The Player holds one channel, with the platform.** A channel is derived from its two participants (`0059-a-channel-is-derived-from-its-participants.md`). Paying a new counterparty directly would mean "an on-chain transaction, gas and locked capital *per broadcaster*". A hub exists to avoid that (`vibe_station/README.md`, "A hub", lines ~108–111). Whatever option #8 picks, the Player pays **the platform's connector** and no one else.
8. **Payout is never on the packet path.** An operator gets paid with an authenticated write, `POST /channels/:id/redeem-latest` (`toon-meta/context/architecture.md`, "Payment model"). The connector has **no** split, payout-to-third-party or revenue-share feature. The connector is "mechanism, not policy" (`connector/docs/adr/0006-...`), and a peering "cannot be bought, learned, earned or announced into existence" (`0043`; `toon-meta/context/architecture.md` invariant 3).
9. **The channel contract lets anyone holding a signed claim collect.** `TokenNetwork.claimFromChannel` transfers the delta to the participant who submits the counterparty's EIP-712 balance proof (`connector/packages/contracts/src/TokenNetwork.sol:307-381`). The contract is `ERC2771Context` (line 22), so a relayer such as the gas-station can submit the transaction in the Creator's place.
10. **Units.** Prices are whole base units of 6-decimal USDC; `1000` = 0.001 USDC (0010, "Why flat"). For scale, vibe_station's placeholder hub fee is `20` per packet, and it fronts `50000000` (about $50) of collateral per admitted station (`vibe_station/docs/placeholder-numbers.md`, "Hub carriage" and "Hub collateral").

## Options

### A. Route the Pull to the Creator through a platform hub that takes a peering fee

This is the vibe_station shape. The Creator runs a station: a connector plus an app with a public self-description URL. The platform's connector peers with it. The platform operator creates the peering with `POST /peers {id, url, fee, max_packet_amount}` (`0058-a-peering-is-established-from-a-url.md`), usually after the Creator pays for a slot (`vibe_station/docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md`). The Player's Pull packet goes to `g.<platform>.<creator>…`, and the platform keeps `fee`.

- **What the Creator runs:** a connector and an app that answers the Pull, on a public URL, online for every Pull. With a static Slop on Arweave there is nothing natural for that app to serve. It would be a stub that answers so the packet fulfils.
- **Creator's cost:** hosting, a slot price (vibe_station keeps it deliberately cheap), and a settlement address. The Creator collects with `redeem-latest` and pays gas for it.
- **Platform's cost:** collateral fronted per Creator. Opening a peering opens a channel, and the buy funds it with `TOON_PEERING_COLLATERAL`, which does not come back when the slot lapses (`vibe_station/docs/adr/0003-...md`, third amendment). At vibe_station's figure, 1,000 Creators means about $50k locked. It also needs the slot app and its operator key.
- **Pull latency:** one extra hop (platform connector → Creator connector → Creator app) and the Creator's own round trip, bounded by the packet deadline. **A Pull depends on the Creator's uptime.** Pulling onto an offline Creator's Slop fails (`R00`, or no route).
- **Split expressiveness:** flat. The platform gets `fee` and the Creator gets `price − fee`. The Creator could set their own price per route.
- **Fit:** poor for the MVP. It contradicts "Creator publishing is CLI/agent-first" with static bundles, and it puts every Creator's server on the Pull path.

#### A′. The Creator as a client destination (no node, but a live socket)

The connector can deliver a paid PREPARE to a **client session** bound to an ILP address ("the socket is the lease", `connector/crates/connector-client-edge/src/session_registry.rs:1-30`). It then credits that client and hands it a signed payout claim over the same session (`connector/crates/connector-client-edge/src/session_route.rs:60-68, 150-200`, issues #770/#779/#787). The client derives its own fulfilment (`connector/docs/adr/0032-a-client-destination-is-never-a-route-termination.md`). On the client side, toon-client has inbound BTP handlers (`toon-client/packages/client/src/btp/BtpRuntimeClient.ts:47-51`).

- **What the Creator runs:** a toon-client process holding a BTP session to the platform connector, plus a channel with it. No public server.
- **Creator's cost:** a channel open (gas plus a deposit) and an always-on process.
- **Pull latency:** same as A. The Pull still fails while the Creator is offline. The session lease backstop is 120 s.
- **Status:** the mechanism exists for mesh-compute sellers (toon-meta#265/#266). This research did not verify that a toon-client high-level API exposes "receive and earn", or which side must fund the payout channel. It still has A's fatal flaw: the Creator must be online.

### B. Two packets per Pull

Packet 1 goes to the platform (terminated, for example the Feed's "next Slop" handler). Packet 2 goes to the Creator's address.

- **What the Creator runs:** the same as A or A′. Packet 2 still needs a reachable, answering Creator destination. The Player's one channel is with the platform (fact 7), so packet 2 also crosses the platform connector and pays its fee.
- **Creator's cost:** as in A or A′.
- **Pull latency:** packet 2 can run in parallel or fire-and-forget, so the Pull no longer waits on the Creator. That is the only thing B gains over A.
- **Costs:** two claims and two round trips per Pull. The split is **client-enforced**: the Player's app chooses to send packet 2, and a modified client can skip it. The two packets are not atomic. Packet 2 can fail while packet 1 succeeds, and the Creator is simply not paid for that Pull.
- **Fit:** worse than A on integrity and no better on Creator burden.

### C. The platform receives everything and pays Creators later (recommended for the MVP)

Every Pull terminates at the platform's own app behind its connector. The app knows which Slop the Pull landed on, because it chose it, and who paid (`X-TOON-Payer`, fact 6). It credits the Creator's share to a ledger. A payout job later sends each Creator their balance.

Payout rails, in order of how much already exists:

1. **Batched on-chain USDC transfer** to the Creator's address on Base Sepolia or Solana devnet. This is a plain ERC-20/SPL transfer from the platform treasury, after the operator runs `redeem-latest` on Player channels. It needs no TOON-specific code. The platform pays roughly one transfer per Creator per batch, trivial on devnet.
2. **A platform→Creator payment channel.** The platform opens a channel toward the Creator's address (`openChannel(participant2, …)`, `TokenNetwork.sol:225`) and deposits. It then hands the Creator cumulative signed balance proofs out of band, for example over HTTP or a Nostr DM. The Creator redeems with `claimFromChannel` whenever they like, and can use a gas-station ERC-2771 relay (fact 9). Each claim costs the platform nothing. Collateral is locked per Creator, as in A. **Nothing ships this today.** toon-client's channel API assumes the counterparty is a connector known from its self-description (`toon-client/docs/channels.md`, "You open it, not the connector"; `docs/api.md` `ChannelFacade.counterparty` = "the connector's settlement address"). The platform would write its own EIP-712 claim signing.

- **What the Creator runs:** nothing. They need one wallet address in their Slop or Creator metadata.
- **Creator's cost:** nothing for rail 1. For rail 2, gas per redeem, or none through a relayer.
- **Pull latency:** the lowest of all options. One hop, platform only, and the Pull never depends on a Creator.
- **Split expressiveness:** anything, including percentages, per-Creator rates and caps. It is ledger policy, not connector config.
- **Costs and risks:** Creators trust the platform's ledger and wait for the payout batch. The platform holds Creator money between batches. The payout job is **payment code in the app tier**, which bends the TOON convention that "the connector handles pricing, so the app contains no payment code" (map #1). It lives off the Pull path, as a separate operator job, and the Pull itself stays connector-priced. Self-pull farming becomes the ledger's problem, which is a good place for it because the ledger sees `X-TOON-Payer`.

### D. Other shapes considered

- **Platform hub with a fee, terminating at a platform-run "Creator proxy" per Creator.** The platform would run the Creator-side app itself. The money still ends in a connector the platform controls, so this is C with extra hops.
- **Custodial Player balances.** If #8 chooses a custodial hosted payer, a Pull may never cross ILP per swipe, and the split is purely a ledger entry. That is C in its limit. It is recorded here because #8 and #9 interact: the payer choice can make the split question moot on the wire.

## Comparison

| Option | Creator runs | Creator cost | Pull latency | Pull depends on Creator uptime | Split shape | Exists today |
|---|---|---|---|---|---|---|
| A hub + peering fee | connector + app, public URL | hosting, slot, redeem gas | +1 hop + Creator app | yes | flat `fee` / `price − fee` | yes (vibe_station) |
| A′ client destination | toon-client socket + channel | channel open, always-on | +1 hop + Creator client | yes | flat | connector yes, client API unverified |
| B two packets | as A or A′ | as A or A′ | parallel, second not awaited | no, but Creator unpaid when down | flat, client-enforced | yes, but not atomic |
| C1 ledger + on-chain batch | nothing (address only) | none | 1 hop | no | any | transfers yes, ledger is new |
| C2 ledger + payout channel | nothing (address only) | redeem gas or relayer | 1 hop | no | any | contract yes, off-connector signing is new |

## Open questions surfaced

- **Creator payout identity.** What address does a Creator give (EVM, Solana, or both), and how is it bound to their Nostr key in Slop metadata? This feeds the "Creator identity and Slop metadata" fog.
- **Payout cadence and threshold** for C: per day, per balance threshold, or on Creator request. Also who pays gas.
- **Trust surface of the ledger.** Should Creators be able to audit their Pull count, for example with per-Pull Nostr receipts? This ties into the "Pull stats per Slop" nice-to-have.
- **Does "no payment code in the app" permit a payout job?** This is a convention call for the spec.
- **Self-pull farming** is easiest to police in C (the ledger sees payer and Slop). This feeds the "Abuse economics" fog.
- **Upgrade path.** Could a Creator who does run a node opt into A (direct, trustless settlement) later without changing the Player side? Since the Player always pays the platform connector, yes in principle: the platform's route for that Creator changes from terminated to forwarded.
