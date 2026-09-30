# Slop Machine

Slop Machine is a TOON showcase. Creators publish Slop (static web games), and Players pull them through a mobile-first web Feed, paying a small devnet-USDC toll per Pull. Creators earn from Purchases made inside their Slop. It all runs on the TOON relay and store.

It is devnet only, so no mainnet money is involved.

## Where the plan is

- **The map:** [#1, Slop Machine MVP](https://github.com/toon-protocol/slop_machine/issues/1) holds the destination, the standing decisions and every ticket resolved so far.
- **The MVP spec:** [`docs/mvp-spec.md` on `spec/mvp`](https://github.com/toon-protocol/slop_machine/blob/spec/mvp/docs/mvp-spec.md). It is still in progress and is not on `main` yet.

## How work gets done here

- **Planning** happens in wayfinder tickets, labelled `wayfinder:*` and filed under the map (#1). They are for a human.
- **Building** happens in the AFK factory. An issue labelled `ready-for-agent` is implemented and reviewed by agents, and comes back as a PR labelled `ready-for-human`.

See [`CLAUDE.md`](CLAUDE.md) for how the factory works, and [`docs/agents/`](docs/agents/) for the issue tracker, triage labels and domain docs conventions.
