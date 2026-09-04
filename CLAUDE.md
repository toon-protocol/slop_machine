# radio

The TOON Protocol **stream origin**: a paid audio/stream broadcast service
that sits behind the connector, so listeners pay per request and the origin
never sees a payment.

Part of the **TOON Protocol** — pay-to-use infrastructure over Interledger
(ILP), split into per-team repos.

## Status: design only — there is no code here

This repository currently contains `README.md`, `.gitignore` and `LICENSE`.
Nothing else. There is no package, no image, no deployment, and no devnet node.

**Do not infer commands from the sibling repos.** There is no `pnpm install`,
no `pnpm test`, no `deploy/` bundle, and no CI here yet — `relay` and `store`
have those because they are built. If you are asked to "run the tests" or
"deploy", the honest answer is that neither exists yet. Add this section's
replacement in the same commit that adds the thing it describes.

The intended shape, and the questions still open about it, are in
[`README.md`](./README.md) — which direction pays (paid listens vs. relay-style
paid ingest), the unit of payment, and Nostr vs. ArNS discovery. Those are
genuinely undecided; do not resolve one silently in code. If an
implementation forces the question, raise it.

## The invariant that outlives the design questions

Whatever this becomes, **the origin contains no payment code.** Payment is
enforced upstream by the connector; a request that reaches the origin is
already proven paid, and the origin serves it. This is the same split `relay`
uses, and it is what makes an ordinary HTTP app monetizable without knowing
ILP exists.

**All payment-claim validation lives ONLY in the
[connector](https://github.com/toon-protocol/connector) — never re-implement
it here.** Pricing a route is connector config, not application code.

## This repo is public, and will hold key material on live boxes

A radio node deploys the standard connector bundle and so generates an ILP
signer key, settlement keys that hold real value, and peering secrets.
`.gitignore` already covers these by wildcard (`*.key`, `*.secret`, `*.pem`,
operator credentials) before any of them exist — see its comments for the
incidents that shaped those rules.

- Never commit key material, and never weaken those rules to make a file
  visible. An ignore rule does not protect an already-tracked file: if one
  lands, `git rm --cached` it **and rotate the key** — the rotation is what
  closes the exposure.
- Do not add a `*.ts` ignore rule. HLS segments are MPEG-TS `.ts` files, which
  collides with the TypeScript extension; generated media is ignored by
  directory (`segments/`, `recordings/`) for that reason.

## Cross-repo dependencies

- **[connector](https://github.com/toon-protocol/connector)** — the paid
  reverse proxy this sits behind. Stock GHCR image on an immutable pin, with a
  bind-mounted `connector.toml`; this repo should publish no connector image.
- **[relay](https://github.com/toon-protocol/relay)** — the reference for
  putting an ordinary app behind the connector. Read its `deploy/` before
  writing one here.

## Shared skills, docs & project context → toon-protocol/toon-meta

Cross-cutting agent skills, docs, and the canonical project context live in
**[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**:

```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```

Canonical rules/decisions: `toon-meta` → [`context/context.md`](https://github.com/toon-protocol/toon-meta/blob/main/context/context.md),
with `architecture.md`, `repos.md`, `decisions.md` and `glossary.md` beside it.

> Sibling CLAUDE.md files still point at `toon-meta` →
> `_bmad-output/project-context.md`. That path no longer exists — the raw BMAD
> dump was removed in favour of the curated `context/` above. Follow
> `context/` here.
