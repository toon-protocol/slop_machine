# slop_machine

Paid live broadcast over TOON. Vibers pay per segment as they watch or listen; the money lands with
the broadcaster. Two toon apps ship from this repo, both sitting behind the connector so neither
ever sees a payment:

- the **station origin** — ingests a broadcaster's RTMP stream and serves HLS segments of it;
- the **slot app** — sells the routing-table entries that make a station reachable from a hub.

A **hub** deployment is otherwise stock: the announcement surface is the **relay** toon app's
published image, and the router is the stock connector. Only the two apps above are new code.

Part of the **TOON Protocol** — pay-to-use infrastructure over Interledger (ILP), split into
per-team repos.

## Vocabulary is load-bearing here

Read [`CONTEXT.md`](./CONTEXT.md) before writing anything. The words are chosen, not incidental —
*vibes* are the media, a *viber* is who pays for them, a *rung* is a priced quality level, a *slot*
is what a broadcaster buys, and a *channel* always means a payment channel. Two collisions matter
enough to be called out in the glossary itself: **slot is not peering**
([ADR 0003](docs/adr/0003-a-slot-is-bought-a-peering-is-still-only-created.md) depends on the
distinction) and **segment is not packet**.

## Status: design only — there is no code here

This repository contains `README.md`, `CONTEXT.md`, `docs/`, `.gitignore` and `LICENSE`.
Nothing else. There is no package, no image, no deployment and no devnet node.

**Do not infer commands from the sibling repos.** There is no `pnpm install`, no `pnpm test`, no
`deploy/` bundle and no CI here yet — `relay` and `store` have those because they are built. If you
are asked to "run the tests" or "deploy", the honest answer is that neither exists yet. Add this
section's replacement in the same commit that adds the thing it describes.

The design is settled and written down; the open questions the README used to list — which
direction pays, the unit of payment, and how discovery works — are all answered. Vibers pay, per
segment, and stations announce to a hub's relay.

The numbers — slot price, renewal period, hub collateral, the rung ladder — are **placeholders**,
not decisions, and live in [`docs/placeholder-numbers.md`](docs/placeholder-numbers.md). They are
internally consistent and safe to build against; none has been reasoned about economically. Change
one freely, but keep the ladder under ADR 0001's byte bound.

## The invariant that outlives everything else

**No app in this repo contains payment code.** Payment is enforced upstream by the connector; a
request that reaches an app is already proven paid, and the app serves it. This is the same split
`relay` uses, and it is what makes an ordinary HTTP app monetizable without knowing ILP exists.

**All payment-claim validation lives ONLY in the
[connector](https://github.com/toon-protocol/connector) — never re-implement it here.** Pricing a
route is connector config, not application code.

## Two hazards specific to this repo

**The slot app holds an operator write key.** It is the one app in the fleet that reaches back into
its own connector's operator surface, so compromising it means mutating the hub's routing table.
Scope the credential to the writes it needs. Writes are RFC 9421 signature-gated, never
bearer-gated — do not add a bearer path for convenience.

**A segment is bounded to 2 MiB on purpose.** Nothing enforces this: the connector's 2 MiB body
limit is request-only and the response direction has no cap at all. That absence is an open question
upstream, not a guarantee — see
[ADR 0001](docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md) before raising a
bitrate or lengthening a segment.

Related: **do not set `per_kib` on a station route.** A price is a schedule over the *inbound*
payload, so it charges for the request, not the vibes in the fulfill. It will silently do nothing.
Quality is priced per rung, by address ([ADR 0002](docs/adr/0002-bitrate-follows-the-vibers-budget.md)).

## This repo is public, and will hold key material on live boxes

A slopmachine node deploys the standard connector bundle and so generates an ILP signer key,
settlement keys that hold real value, and peering secrets. A hub additionally holds an operator
write key. `.gitignore` already covers these by wildcard (`*.key`, `*.secret`, `*.pem`, operator
credentials) before any of them exist — see its comments for the incidents that shaped those rules.

- Never commit key material, and never weaken those rules to make a file visible. An ignore rule
  does not protect an already-tracked file: if one lands, `git rm --cached` it **and rotate the
  key** — the rotation is what closes the exposure.
- Do not add a `*.ts` ignore rule. HLS segments are MPEG-TS `.ts` files, which collides with the
  TypeScript extension; generated media is ignored by directory (`segments/`, `recordings/`) for
  that reason.

## Cross-repo dependencies

- **[connector](https://github.com/toon-protocol/connector)** — the paid reverse proxy both apps sit
  behind. Stock GHCR image on an immutable pin, with a bind-mounted `connector.toml`; this repo
  should publish no connector image. It is also the normative authority on vocabulary: where
  `CONTEXT.md` and [`connector/CONTEXT.md`](https://github.com/toon-protocol/connector/blob/main/CONTEXT.md)
  disagree, that one wins.
- **[relay](https://github.com/toon-protocol/relay)** — the reference for putting an ordinary app
  behind the connector, and the hub's announcement surface. Read its `deploy/` before writing one
  here.
- **[toon-client](https://github.com/toon-protocol/toon-client)** — the payer side. The client
  daemon is built on it, and its keystore is Node-only: there is no browser key management, so no
  part of the client can be a web app.
- **[store](https://github.com/toon-protocol/store)** — where a broadcaster's clips live, so that a
  broadcaster page costs a station node nothing to serve.

## Shared skills, docs & project context → toon-protocol/toon-meta

Cross-cutting agent skills, docs, and the canonical project context live in
**[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**:

```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```

Canonical rules/decisions: `toon-meta` → [`context/context.md`](https://github.com/toon-protocol/toon-meta/blob/main/context/context.md),
with `architecture.md`, `repos.md`, `decisions.md` and `glossary.md` beside it.

## Agent skills

### Issue tracker

GitHub Issues on `toon-protocol/slop_machine`, via the `gh` CLI. See
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).
