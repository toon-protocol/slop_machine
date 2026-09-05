# A slot is bought; a peering is still only created

**Status:** Accepted. **Amended three times: twice on 2026-09-04, once on 2026-09-05.**

**First** ([#34](https://github.com/toon-protocol/slop_machine/issues/34)): the claim that a peering
which cannot be established "rejects the packet, so no payment is taken" is withdrawn — an app that
answers is answered for, and a refusal here is paid for. See
[the first amendment](#amendment-2026-09-04-a-refusal-is-paid-for-so-the-design-moves-refusals-rather-than-pricing-them-at-nothing).

**Second** ([#38](https://github.com/toon-protocol/slop_machine/issues/38)): the first amendment's
rule that "a new refusal added at the buy is a new way to charge a broadcaster for nothing" is
**qualified, not withdrawn** — the slot cap is refused at the buy, because a buyer the quote already
warned is not being charged for nothing, and because a cap that is only reported bounds nothing. See
[the second amendment](#amendment-2026-09-04-the-cap-is-enforced-at-the-buy-because-a-warned-buyer-is-not-charged-for-nothing).

**Third** ([#53](https://github.com/toon-protocol/slop_machine/issues/53)): establishing a peering
**opens** a payment channel and does not fund one, so a fulfill that meant *you are peered* meant a
station that could not be paid to carry a packet. The buy now funds the channel it opened; and the
lapse's release of a peering **does not bring the hub's collateral back**, which this record and the
code both used to say it did. See
[the third amendment](#amendment-2026-09-05-a-peering-that-opens-a-channel-does-not-fund-it).

Everything else stands: a slot is bought, a peering is still only created.

**Scope:** slopmachine hub — the slot app. Reconciles with
[connector ADR 0043](https://github.com/toon-protocol/connector/blob/main/docs/adr/0043-purchasable-peering-is-removed.md),
which it must not be mistaken for a violation of.

A broadcaster pays the hub for a **slot** — the routing-table entry that makes their station
reachable. The slot app, a payment-oblivious app behind the hub's connector, receives the
already-paid request and performs an **operator write** (`POST /peers`, then a persisted runtime
route) with an ed25519 key on the connector's `write_keys` allowlist.

**This is not a purchasable peering.** The connector says a peering "cannot be bought. It is created
by the operator — in the config file, or through the operator surface — and by nothing else", and
that stays true here: the peering is created by the hub's operator, through the operator surface,
using the operator's own key. What the broadcaster bought is a slot. What the operator did in
response is a peering. **Collapsing those two words in the code is what would turn this into a
violation.**

## Why this is the sanctioned shape, not a loophole

[Connector ADR 0006](https://github.com/toon-protocol/connector/blob/main/docs/adr/0006-the-connector-is-mechanism-not-policy.md)
is titled *"the connector is mechanism, not policy"*, and it deleted 4,028 lines of route learning so
that discovery and route policy would live in an **external controller** instead. ADR 0043 then
removed the one surviving exception — peering-purchase as a *connector feature* — and describes
itself as restoring ADR 0006 without qualification.

An app behind the connector that takes payment and calls the operator surface is precisely the
external controller ADR 0006 cleared space for. The thing that was removed was a connector that
decided who its peers were. The connector here decides nothing; it collects a payment and hands an
app already-paid HTTP, exactly as it does for `store` and `gas-station` — both of which likewise do
something privileged with their own secrets once paid.

## How ADR 0043's objections are answered

ADR 0043 deleted the feature rather than gating it behind approval because approval would need four
things. Auto-approval removes three of them outright:

- **"A second network-writable table to bound."** The connector's runtime peer/route table already
  exists and is the operator's, not the network's — ADR 0034's rule that a runtime row can never
  shadow a config row is untouched. The slot app bounds its own writes.
- **"A fulfill whose meaning changed from *you have a peering* to *your request is recorded*."** The
  work happens synchronously, before the app answers. The fulfill means you are peered.
- **"A new status surface for a buyer to learn its outcome."** Not needed: the outcome *is* the
  response.
- **"A non-refundable payment for a thing the operator may simply bin."** Nothing is binned — there
  is no human in the loop to bin it. Transient failures are retried inside the request; a peering
  that still cannot be established **rejects the packet**, so no payment is taken. This repo has no
  refund path and wants none, which is ADR 0039's surviving "refuse, not refund" principle.

> **Amended 2026-09-04 ([#34](https://github.com/toon-protocol/slop_machine/issues/34)).** The
> fourth bullet above is **factually wrong from "a peering that still cannot be established"
> onward**, and is left standing so the reasoning it was part of stays legible. An app that answers
> is answered for, whatever its HTTP status, so a refusal at a paid address is a refusal somebody
> was charged for. The objection is still answered — see
> [the amendment](#amendment-2026-09-04-a-refusal-is-paid-for-so-the-design-moves-refusals-rather-than-pricing-them-at-nothing)
> at the foot of this record — but by moving the refusals somewhere cheap, not by their being free.

## Consequences

- **The slot app holds an operator write key.** Compromising it means mutating the hub's routing
  table, so the credential is scoped to the writes it needs and to nothing else. Writes are
  signature-gated (RFC 9421), never bearer-gated, because "no shared secret is ever sufficient to
  move value".
- **Routes are persisted, not leased.** Leased routes expire on a TTL but are deliberately
  memory-only; a hub restart would black out every station until each renewed. The slot app owns
  expiry instead, and lapses unrenewed slots itself.
- **Establishing a peering opens a channel**, so the hub fronts collateral toward every broadcaster
  it admits. Hub capital grows linearly with the roster, and the carriage fee has to cover it.

  > **Amended 2026-09-05 ([#53](https://github.com/toon-protocol/slop_machine/issues/53)).**
  > "Fronts collateral" is what this bullet *intended* and was not what happened: opening a channel
  > and funding one are two writes, and only the first was ever made. The buy makes the second now
  > — `POST /channels/:id/fund`, after the peering and before any route — and the amount is the hub's
  > own `TOON_PEERING_COLLATERAL`. See
  > [the third amendment](#amendment-2026-09-05-a-peering-that-opens-a-channel-does-not-fund-it).
- **Admission is a price, not a judgement.** That is the point — it makes onboarding self-service —
  but it means abuse bounds are the slot app's problem, since the connector no longer carries any.
- **A refusal at a paid address is paid for** *(added by the first 2026-09-04 amendment)*. The connector
  fulfills on any complete answer from the app whatever its status, so the app cannot decline
  payment by refusing. Every foreseeable refusal therefore belongs at the cheap quote address rather
  than at the buy, and a new refusal added at the buy is a new way to charge a broadcaster for
  nothing. See the first amendment below.

  > **Amended 2026-09-04 ([#38](https://github.com/toon-protocol/slop_machine/issues/38)).** The
  > last sentence is **too strong, and is left standing so the rule it states stays legible**. It
  > holds for every refusal a broadcaster could not have seen coming — which is all of them but
  > one. The **slot cap** is refused at the buy, deliberately, because a buyer who read
  > `hasCapacity: false` at the quote and bought anyway was not charged for nothing: they were
  > charged for an answer they had already been given at a floor price. See
  > [the second amendment](#amendment-2026-09-04-the-cap-is-enforced-at-the-buy-because-a-warned-buyer-is-not-charged-for-nothing)
  > at the foot of this record.
- **The hub's collateral is bounded by the cap and by nothing else** *(added by the second
  2026-09-04 amendment)*. Every admission opens a channel the hub fronts collateral toward, so the
  roster is a balance-sheet commitment that grows linearly with its own size. `TOON_SLOT_CAP` is
  therefore enforced at the buy rather than only reported at the quote, and it applies to a **new**
  slot only: a renewal opens no channel, so it adds nothing to the commitment being bounded and is
  never refused for it.

## Amendment, 2026-09-04: a refusal is paid for, so the design moves refusals rather than pricing them at nothing

**Cause.** [Issue #34](https://github.com/toon-protocol/slop_machine/issues/34) landed the slot
app's quote address, the first place this design had to state out loud what a refusal costs. The
answer contradicted this record, so the record is corrected here rather than quietly worked around
in code.

**What was claimed.** In *How ADR 0043's objections are answered*, the fourth bullet says that a
peering which still cannot be established "**rejects the packet**, so no payment is taken". The
implied guarantee is that a broadcaster whom the hub turns down pays nothing.

**Why that is not achievable.** A terminating connector fulfills on **any complete answer from the
app, whatever its HTTP status**. A status is envelope content; it is never a packet outcome
([connector ADR 0020](https://github.com/toon-protocol/connector/blob/main/docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md),
whose own words are "value moves whenever the app answered — whatever it answered", and
`crates/connector-runtime/src/connector.rs`'s comment at the delivery match). A `403`, a `409` and a
`503` from the slot app are all fulfills, and the broadcaster is charged for every one of them. The
only packets that escape payment are the ones the app never answers at all — the packet's own
deadline (`R00`,
[connector ADR 0064](https://github.com/toon-protocol/connector/blob/main/docs/adr/0064-a-deadline-bounds-the-wait-for-an-app-not-the-answer.md)),
or an app the connector cannot reach (`T01`) — and neither of those is a refusal an app can choose
to make. **An app cannot decline payment by refusing.** Deliberately hanging until the deadline to
avoid being paid would be worse than taking the money: it burns the broadcaster's whole timeout, and
it is indistinguishable to them from a hub that has fallen over.

**What the design does instead.** Three things, in place of the one that was never available.

- **Every foreseeable refusal moves to the cheap quote address.** `GET /quote` sits beneath its own
  connector prefix at a floor price — never the buy's prefix, so neither is reachable at the other's
  price — and answers everything that could turn a purchase down before the purchase is made:
  whether the hub has capacity under its cap, what a slot costs, how long it lasts, whether the
  caller already holds one, and the prefix this hub would grant them. A broadcaster who cannot be
  admitted learns it for the price of a quote, and the expensive address is only ever reached once
  the cheap one has already said yes. This is the same shape a station already uses for its own
  *now* against its segments.

- **The handle is derived from the verified payer, so "that handle is taken" stops existing.** That
  choice is usually read as being about vanity, and it is not; it is this amendment's direct
  consequence. A handle somebody could have claimed first would be a refusal at the buy that no
  quote could have foreseen — the most expensive refusal in the design, arriving after the
  broadcaster had configured their station for the address. Deriving the handle from the payer
  deletes that case rather than pricing it, and where two payers would derive one label the app
  lengthens the label deterministically rather than turning either of them away.

- **The one refusal that cannot be quoted away is a paid answer, and it is honest about whose node
  it is about.** A station URL the hub cannot reach, or that does not describe itself, is a fact
  about the **caller's own node** and is discoverable only by going and looking — which happens
  inside the paid request. That answer costs the slot price and buys no peering. It is not disguised
  as anything else: it names the broadcaster's connector as the thing to fix, so they fix it rather
  than retrying into the same charge.

**"Refuse, not refund" survives; "a refusal is free" does not.** There is no refund path in this
repo and none is wanted — that is
[ADR 0039](https://github.com/toon-protocol/connector/blob/main/docs/adr/0039-abuse-bounds-on-a-purchased-peering-refuse-not-refund.md)'s
surviving principle and it is untouched. What does not survive is the inference this record drew
from it, that a refusal therefore costs the broadcaster nothing. A refusal is not refunded, and it
is also not free. ADR 0043's fourth objection is still answered: there is no operator in the loop to
bin a purchase, and the quote makes every binnable case visible in advance — but it is answered by
where the refusals sit, not by their being unpaid.

**What does not change.** The decision itself. A slot is bought; a peering is still only created, by
the hub's operator, through the operator surface, with the operator's own key. Nothing here alters
who creates a peering, that the fulfill means you are peered, that the work happens synchronously
before the app answers, or that collapsing *slot* and *peering* in the code is what would turn this
into a violation of connector ADR 0043.
## Amendment, 2026-09-04: the cap is enforced at the buy, because a warned buyer is not charged for nothing

**Cause.** [Issue #38](https://github.com/toon-protocol/slop_machine/issues/38) landed the lapse —
the hub taking an unrenewed slot's routes and peering back out on its own initiative — which is the
only thing that ever *reduces* a hub's collateral commitment. Building it made the other half
visible: the only thing that ever *bounds* that commitment, `TOON_SLOT_CAP`, was not being
enforced. `GET /quote` reported `hasCapacity: false` at the cap and `POST /buy` admitted the caller
regardless, so the number a hub operator set was decoration. Closing that meant adding a refusal at
the buy, which the first amendment had just finished arguing against, so the argument is settled
here in the record rather than quietly in code.

**What the first amendment established, and still establishes.** A refusal at a paid address is
paid for: the connector fulfills on any complete answer from the app whatever its HTTP status, so
an app cannot decline payment by refusing. From that it drew the working rule that every foreseeable
refusal belongs at the cheap quote address, and that **"a new refusal added at the buy is a new way
to charge a broadcaster for nothing."** Nothing about the mechanism has changed. The premise is
still true and the design still moves refusals rather than pricing them at nothing.

**Why the rule is qualified.** "For nothing" is doing the work in that sentence, and it is what
distinguishes this refusal from every other one. The refusals the first amendment was written
against are the ones a broadcaster **could not have seen coming**: a handle somebody else had
claimed, arriving after they had configured their station for it. Being charged for one of those is
being charged for a fact the hub could have told them for a floor price and did not. The cap is not
that. The quote answers `hasCapacity`, and it answers it *about this hub, right now, at the cheap
address that exists for exactly this question*. A broadcaster who reads `false` and buys anyway has
had the warning the amendment demanded they be given. Charging them is charging for an answer, not
charging for nothing — and it is the same charge they would have paid for any other purchase that
told them something they did not want to hear.

**Why the alternative is worse.** The alternative to refusing is admitting, and admitting is not
free to anybody. Establishing a peering opens a payment channel the hub fronts collateral toward
(this record's own Consequences, and connector ADR 0058), so **the roster is a balance-sheet
commitment that grows linearly with its own size**. The cap is the only thing bounding it: there is
no rate limit, no approval step and no human in the loop, because admission here is a price rather
than a judgement. A cap that is only *reported* bounds nothing at all — any buyer who ignores the
quote is admitted, and a hub operator's stated capital limit becomes a suggestion the internet is
free to decline. The failure that produces is not a refused broadcaster; it is a hub that has
committed collateral it cannot cover, which takes down every station on it, including the ones that
were admitted properly. Weighing one paid refusal against that is not close.

**A renewal is never refused for the cap, at it or over it.** This is the part that keeps the
enforcement honest, and it is a rule about what the cap actually bounds. The cap bounds *collateral*
— and a renewal opens no channel, writes no new peering and adds nothing to the commitment. It is
the same broadcaster the hub is already carrying, paying to go on being carried. Refusing one would
take a paying station off the air for renewing on time, which is the exact opposite of what the
period is for. It also has an operational consequence worth stating: a hub operator who *lowers*
their cap beneath their own roster closes the door without evicting anybody behind it, and the
roster shrinks back to the new bound by slots lapsing rather than by the hub throwing out stations
that did nothing wrong.

**What stays unfair, said out loud.** Two broadcasters can quote the last free slot, both be told
`hasCapacity: true`, and both buy. One of them is refused and pays the slot price for it, having
been told yes. That is a real cost to a real person and it is not designed away here. It is not
designed away because the alternatives are worse: reserving capacity at the quote would let a cheap
address hold a hub's collateral hostage for free, and admitting both would be the unbounded roster
this amendment exists to prevent. The window is the time between one broadcaster's quote and their
buy, the refusal says plainly that capacity is what was missing and that a lapse frees a place, and
the honest position is that it can happen rather than that it cannot.

**What does not change.** The decision itself, and the first amendment in full. A slot is bought; a
peering is still only created, by the hub's operator, through the operator surface, with the
operator's own key. A refusal at a paid address is still paid for, every refusal that *can* be moved
to the quote is still moved there, there is still no refund path and none is wanted, and the set of
refusals at the buy is still deliberately small — one longer than it was, and this is the argument
for the one.

## Amendment, 2026-09-05: a peering that opens a channel does not fund it

**Cause.** [Issue #51](https://github.com/toon-protocol/slop_machine/issues/51) set out to run the
whole product end to end for the first time — a viber's packet crossing a hub and paying a
broadcaster — and doing that made visible a defect this record had helped hide. Both this ADR and
the code beneath it spoke of a hub "fronting collateral" toward every broadcaster it admits, as
though establishing a peering did it. Nothing did it.

**What was claimed.** This record's Consequences said *"establishing a peering opens a channel, so
the hub fronts collateral toward every broadcaster it admits"*, and its second amendment leaned on
the same sentence to argue that the cap bounds a balance-sheet commitment. Beneath it,
`packages/slot-app/src/peering/peering.ts` said of releasing a peering: *"this is what brings the
collateral back."* Read together, the two describe a lifecycle in which admission commits capital
and a lapse returns it. Neither half was true.

**What is actually true.** `POST /peers` **opens** a channel (connector ADR 0058). Funding one is a
separate operator write, `POST /channels/:id/fund` (ADR 0008's third write), and nothing in this
repository made it. So a broadcaster who paid the slot price was peered, routed, on the roster,
visible in the quote — and carried nothing: the hub's own connector refused to sign a covering claim
for a packet it was about to forward and answered `T00`, *"channel … has 0 base units of headroom
left"*. That failure names the hub's own internal state rather than the missing deposit, so the one
person who could have fixed it learned nothing from it, and the station that paid learned only that
the hub was broken.

**What the design does now.** The buy funds the channel it opened, as a third signed operator write
beside the peering and the routes, and **the fulfill means peered *and payable***.

- **After the peering and before any route.** A route toward an unfunded channel is an address that
  is reachable, priced, paid for and dead. The order is not a preference: it is the only order in
  which the hub never advertises carriage it cannot perform.
- **The write is an increment, so it is made idempotent by reading first.** The app reads what its
  own side of the channel already holds and deposits only the shortfall. A channel already holding
  what the policy fronts is left alone; a retried purchase deposits nothing and the hub's exposure
  does not double; a renewal is a **top-up** rather than a second deposit, so a long-lived station
  stays payable without the hub's capital growing every period. A retry after a write whose outcome
  is unknown **re-reads rather than re-sends**. This is the one place in this repository where
  repeating a write spends real money, and the fleet's only other caller of the same endpoint —
  `connector/local/open-solana-channel.py` — solves it the same way and says so.
- **The amount is the hub's own configuration**, `--peering-collateral`/`TOON_PEERING_COLLATERAL`
  ([#52](https://github.com/toon-protocol/slop_machine/issues/52)), unreachable from any request.
  A broadcaster does not choose how much capital a hub commits for them, any more than they choose
  the carriage fee. With it, `TOON_SLOT_CAP` bounds an amount instead of an intention: the hub's
  commitment is the cap times this figure.
- **A funding failure is a paid refusal that names the hub's own node**, `503 channel_not_funded`,
  distinct from `peering_not_established` because the states differ — there nothing happened, here
  the channel exists and is empty. It **leaves the peering standing**: the retry finds that same
  channel (`"status": "found"`) rather than opening a second one, and deposits the shortfall against
  whatever actually landed. Rolling the peering back would spend gas to destroy the thing a retry
  needs. No slot is recorded, so the hub does not count a caller it could not make payable as
  admitted.
- **The same rule on the only other path that establishes a peering.** Boot reconciliation
  re-establishes a peering a hub has lost and then writes routes back; it funds the channel that
  write names, before the routes, for the same reason and by the same shortfall.

**And what still does not happen, said plainly: a lapse does not return the collateral.** Releasing
a peering removes the row and stops the carriage — `deregister` goes with it, so it is the
connector's own kill switch — and that is all it does. **The deposit stays in the channel.** A
channel's money comes back by being **closed and settled** (`POST /channels/:id/close`, then
`POST /channels/:id/settle` after the challenge window), and **nothing in this app makes either
write**. A hub operator reclaiming capital from a station that lapsed does it by hand, over their
own operator surface. Every doc comment claiming otherwise is corrected in the commit that made this
amendment true.

That asymmetry is deliberate rather than an oversight left standing. Closing a channel is an
irreversible act against a counterparty's money as well as the hub's, on a challenge window measured
in days, and a broadcaster who lapsed on a Friday and re-bought on a Monday would be a channel
closed and reopened for nothing — two on-chain acts and a fresh challenge window, to reclaim capital
the hub was about to commit again. A lapsed handle is still the same broadcaster's, because the
handle is derived from their payer key, so a re-buy tops up the channel that is already there. What
this costs a hub operator is capital that stays committed to stations that stopped broadcasting, and
the honest position is that they reclaim it deliberately rather than that the app does it for them.

**What does not change.** The decision itself, and all three of the earlier amendments. A slot is
bought; a peering is still only created, by the hub's operator, through the operator surface, with
the operator's own key. Funding the channel behind it is that same operator's own act, made with
that same key, on the hub's own configured terms — it is not a thing a broadcaster bought, and it is
not the connector deciding anything. A refusal at a paid address is still paid for, and
`channel_not_funded` is a new one of those: it is not a refusal the quote could have foreseen, since
it is discoverable only by the hub trying, and it is about the hub's own node and says so.
