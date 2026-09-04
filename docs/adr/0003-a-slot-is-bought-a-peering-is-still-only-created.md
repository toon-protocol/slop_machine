# A slot is bought; a peering is still only created

**Status:** Accepted. **Amended 2026-09-04** ([#34](https://github.com/toon-protocol/slop_machine/issues/34)):
the claim that a peering which cannot be established "rejects the packet, so no payment is taken" is
withdrawn — an app that answers is answered for, and a refusal here is paid for. See
[the amendment](#amendment-2026-09-04-a-refusal-is-paid-for-so-the-design-moves-refusals-rather-than-pricing-them-at-nothing)
at the foot of this record. Everything else stands: a slot is bought, a peering is still only
created.

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
- **Admission is a price, not a judgement.** That is the point — it makes onboarding self-service —
  but it means abuse bounds are the slot app's problem, since the connector no longer carries any.
- **A refusal at a paid address is paid for** *(added by the 2026-09-04 amendment)*. The connector
  fulfills on any complete answer from the app whatever its status, so the app cannot decline
  payment by refusing. Every foreseeable refusal therefore belongs at the cheap quote address rather
  than at the buy, and a new refusal added at the buy is a new way to charge a broadcaster for
  nothing. See the amendment below.

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
