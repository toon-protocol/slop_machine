# Can the treasury service credit a Creator from a counted claim it never saw?

Research for [#30](https://github.com/toon-protocol/slop_machine/issues/30), part of the map [#1](https://github.com/toon-protocol/slop_machine/issues/1).
Follows from [#22](https://github.com/toon-protocol/slop_machine/issues/22) (a charged Purchase is `paid`) and [#19](https://github.com/toon-protocol/slop_machine/issues/19) (a Purchase packet names the listing; the treasury keeps a SQLite ledger).

Paths are relative to `~/Work/TOON-Protocol/`. Line numbers are for the checkouts read on 2026-09-24. Terms follow `slop_machine/CONTEXT.md`.

## Answer

**Not with the connector as it is.** For each counted client claim, the connector keeps exactly four facts: the channel, the nonce, the cumulative amount and the signature. It keeps no destination, no packet data or hash, no timestamp and no route. So a counted claim can't say *which route* it paid for. That means it can't say whether it was a Pull or a Purchase, which tier it was, or which listing it named. The listing exists only inside a gift wrap sealed to the connector, which is opened only when the packet is delivered. The treasury also can't tie a Purchase it *did* receive to a nonce, because the delivery headers name the channel and the charge but not the nonce. So any "reconcile from counted claims" route built today opens a double-credit hole.

**Recommendation: for the devnet MVP, take the fallback (the platform keeps that Purchase), and make the treasury's own path robust enough that the case stays rare.** If Creators later need that Purchase back, the smallest change that makes it both possible and safe is in the connector: (1) add the claim's nonce to the delivery's attribution headers, and (2) record the destination of each accepted client claim and expose it on the operator read surface. With those two, a free reconcile route that the Feed calls with `{purchaseId, listing, tier, channel, nonce}` becomes sound.

## Facts

### What the connector records per counted claim

1. **The claim is admitted, journalled and made durable before routing.** On HTTP, `extract_and_validate_claim` runs, then `session_route::route_prepare` (`connector/crates/connector-client-edge/src/lib.rs:1297-1320`; `ingest` has already returned durable by `lib.rs:943-946`). On BTP, `finish_frame` awaits `durability.durable()` before `route_prepare` (`connector/crates/connector-client-edge/src/btp.rs:878-900`). A counted claim is rolled back only for a *forwarded* route whose next hop terminally rejects (`lib.rs:1311-1318`, `roll_back_uncarried_forward`). The treasury's tier routes are terminated local routes, so their claims are never rolled back.
2. **The journal entry is `InboundClaimAccepted { channel_id, nonce, cumulative_amount, signature }` and nothing else** (`connector/crates/connector-client-edge/src/claim_gate.rs:941-950`). On disk it is one tab-separated line: `inbound_claim_accepted\t{channel_id}\t{nonce}\t{cumulative_amount}\t{hex sig}` (`connector/crates/connector-runtime/src/journal.rs:115-145`). The other client-edge entries are `inbound_claim_rolled_back` and `inbound_claim_watermark_reset` (`journal.rs:137-144`). It has **no** destination, amount-charged, packet data or hash, payer identity beyond the channel key, or timestamp. ADR 0005 limits the journal to "only what is signed or otherwise irreversible" (`connector/docs/adr/0005-claims-are-truth-balances-are-a-projection.md:7`).
3. **Where it lives:** `state_dir/client-edge-claims.log`, an append-only file (`connector/crates/connector-cli/src/runtime.rs:1064`). It is private state that the connector replays on start, with no subscription, hook or event. `read_all` is an in-process API, not a network one (`journal.rs:52-55`).
4. **The claim's signature doesn't bind the packet.** An EVM client claim is a balance proof: `channelId`, `nonce`, `transferredAmount`, `lockedAmount`, `locksRoot`, `signature` (`connector/crates/connector-domain/src/client_claim.rs:562-580`, test fixture). Nothing in it names the destination or the data. Since the Player writes both the claim and the packet, anything the Player could put in it proves nothing against the Player.
5. **Nonces may skip, and a claim may overpay.** Freshness only needs `nonce > watermark.nonce` and a non-decreasing cumulative amount (`connector/crates/connector-domain/src/claim.rs:52-73`). Value only needs the advance to be at least the route price (`claim_gate.rs:1442-1464`). So the size of an advance says how much was paid, not what it paid for.

### What can be read, and by whom

6. **Operator `GET /claims`** (bearer token) returns only each client channel's *current* watermark `{nonce, cumulative_amount}`, not the history (`connector/crates/connector-operator/src/lib.rs:327-341`). A watermark past nonce N doesn't prove that N itself was counted, because nonces may skip (fact 5).
7. **`POST /ilp/claim-state`** needs a signature proving control of each channel (`connector/crates/connector-client-edge/src/claim_state.rs:1-40`). The Feed can call it for the Player's channel, but the treasury can't.
8. **The `"packet"` tracing span** logs `correlation_id`, `destination` and `client_channel_id` (`connector/crates/connector-runtime/src/connector.rs:1975-1983`). It has no nonce, and it is a log, not an interface.

### What the treasury sees when a Purchase is delivered

9. **Three attribution headers:** `X-TOON-Payer` (the channel key), `X-TOON-Amount` (what the route charged) and `X-TOON-Chain`. They are stated only for a claim this connector admitted (`connector/crates/connector-runtime/src/attribution.rs:38-60, 97-125`; ADR 0040). They carry no nonce and no cumulative amount.
10. **The listing is in the sealed body.** `prepare.data` is a gift wrap sealed to the connector's identity, and it is opened only at termination (`connector.rs:3196-3203, 3237`). Before that, nothing in the connector can read it.
11. **A treasury error is still a FULFILL.** Any complete HTTP answer, including a 5xx, rides home as a FULFILL (`connector.rs:3426-3438`, ADR 0020). If the treasury can't be reached, the packet gets `T01` (`connector.rs:3439-3445`). If it is too slow, the packet gets `R00`, the work is abandoned, and the claim stays counted (`connector.rs:3393-3420`, ADR 0064).

### What the Feed knows

12. **Every non-throwing send gives the Feed `claim: {channelId, chain, nonce, cumulative, amount}`** (`toon-client/packages/client/src/client/send.ts:274-282, 327-330`). On a timeout the send throws, so the Feed has no summary (`send.ts:296-310`). It would have to read the nonce from the channel manager or from `claimState`.
13. **The Feed can't put the nonce in the Purchase body today.** The sealed exchange (the body) is built before `signBalanceProof` assigns the nonce (`send.ts:240-247, 273-274`).

## Can {listing, tier, payer} be rebuilt from a counted claim?

| Field | From the journal? | Notes |
|---|---|---|
| payer | Yes, as the channel key | Same key as `X-TOON-Payer` |
| amount | Yes, as the difference from the previous entry on the channel | But overpaying is allowed (fact 5) |
| tier | No | Only from the amount, and a 1¢ tier has the same amount as a 1¢ Pull (ADR 0002). An overpaid Pull looks like any tier. |
| Pull or Purchase at all | No | No destination is recorded |
| listing | No | It is inside the sealed body, which is never journalled |

## Options

### 0. Fallback: the platform keeps that Purchase (recommended for the MVP)

This covers the cases where the claim is counted but the treasury doesn't record the Purchase: `T01` (treasury down), `R00` (treasury slower than the packet's deadline), and the treasury answering without having recorded it.

- **How to keep it rare, at no protocol cost:**
  - The treasury writes the credit to SQLite (committed) **before** it answers 2xx, and answers fast. It should never do chain or relay work inline: the gift-wrapped proof, the top-up and `openChannel` from #19 run after the answer, from the ledger.
  - It dedupes by a Feed-chosen `purchaseId` in the body, so a retried or duplicated delivery credits once.
  - It runs next to the connector (ADR 0002), so `T01` means the treasury process is down.
- **Cost:**
  - A Creator occasionally misses a Purchase of at most 25¢ of minted devnet USDC.
  - The Player is unaffected: they get `paid` and the item, per #22.
  - The Feed can report the charged-but-undelivered Purchase in its own `slop.purchases()` history. The platform can later credit it by hand from the operator's view, if anyone cares.
- **Why it's acceptable:** it is the same class of devnet loss as ADR 0002's accepted "a receipt can be forged from devtools".

### 1. A free reconcile route over the journal as it is (no connector change): unsafe

The Feed would call a zero-priced treasury route with `{purchaseId, listing, tier, channel, nonce}`. The treasury would read `client-edge-claims.log` (same host, read-only) and check that `nonce` is counted on `channel`, isn't rolled back, and that its amount equals the tier price.

- **Double credit.** A delivered Purchase can't be tied to its nonce (facts 9 and 13). So a devtools Player who is also the Creator can reconcile the nonce of an already-credited Purchase under a new `purchaseId` and be credited twice. That is an unbounded drain of treasury money.
- **Pulls turned into Purchases.** An overpaid Pull, or any 1¢ Pull, can be reconciled as a Purchase, so the Pull is effectively free.
- **Fragile coupling.** It also ties the treasury to a private file format.

Rejected.

### 2. The same route with the nonce known at delivery, but no destination: still leaky

With the nonce known at delivery, the treasury keys every credit by `(channel, nonce)`, so double credit is closed. The nonce could come from a toon-client change that lets the body be built after signing, or from the connector header in option 3.

- **What still leaks:** a devtools Player can still name a counted *Pull* nonce, either an overpaid one or a 1¢ one, and turn a Pull into a self-credit.
- **Bound on the loss:** one Pull price per Pull. The Player must already have paid at least the tier price, which comes back to them as the Creator.
- **Also needed:** the treasury still reads the journal file (fact 3), or an operator read has to be added.

### 3. Smallest change that makes it sound (connector)

1. **Add the nonce to attribution.** Add `X-TOON-Claim-Nonce`, and optionally the cumulative amount, beside `X-TOON-Payer` (`attribution.rs:38-60`). Thread the admitted watermark (already held as `admitted_claim_watermark`, `lib.rs:1281`, and at `btp.rs:872-875`) through `route_prepare` → `deliver_to_app`, as `client_channel_id` already is. This amends ADR 0040's "three headers".
2. **Record which route each claim paid.** Record the destination of each accepted client claim, and serve it through an operator read such as `GET /claims/:channel/:nonce` → `{cumulative_amount, delta, destination, rolled_back}`. The destination isn't signed, so under ADR 0005 it belongs in a side log or index next to the journal, not in `InboundClaimAccepted` itself.
3. **Treasury side:**
   - Every credit is keyed by `(channel, nonce)`.
   - A free reconcile route takes `{purchaseId, listing, tier, channel, nonce}`. It credits only if the operator read says that nonce was counted on a **tier route whose price is `tier`** and that it hasn't been credited yet.
   - The listing is still the Player's assertion, which #19 already accepts.
4. **Feed side:** when `claimState` or `settleWatermarkDoubt` settles a Purchase as "charged, not delivered", the Feed calls the reconcile route with the claim summary (fact 12).

Cost: two connector issues and two ADR amendments (0040, and a note against 0005) in a repo Slop Machine doesn't own, for a path that runs only when the treasury was down or too slow.

## Weighing

| | Creator paid in the failure case | Exploitable | Cross-repo work |
|---|---|---|---|
| 0 fallback + robust treasury | No | No | None |
| 1 reconcile over the journal | Yes | Yes, unbounded double credit | None, but couples to a private file |
| 2 plus the nonce at delivery | Yes | Yes, bounded (a Pull becomes a self-credit) | toon-client or connector |
| 3 nonce header + destination read | Yes | No | connector (2 changes, 2 ADR touches) |

Take **0** now. Log each charged-but-undelivered Purchase so its frequency is measured. File **3** upstream only if that number, or Creators, say it matters.

## Uncertain

- Whether the Feed could keep Pulls and Purchases on separate channels. It wouldn't help: the channel is the Player's choice, so a forger can pay a Pull from the "Purchase" channel.
- How often `T01`/`R00` really happens against a co-located treasury. It hasn't been measured.
- On a thrown timeout, which exact nonce the Feed should report depends on the channel manager's persisted state (`send.ts:33-40`). This wasn't traced further.
