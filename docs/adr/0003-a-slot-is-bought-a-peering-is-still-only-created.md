# A slot is bought; a peering is still only created

**Status:** Accepted.

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
