# @toon-protocol/guide

The guide: the viber-facing discovery surface of
[epic #72](https://github.com/toon-protocol/slop_machine/issues/72) — where a viber finds
stations, browses categories, reads broadcaster pages, and will one day click through to vibe.

A Vite SPA on React, Tailwind and shadcn. **Browser-only, static build, no server of its own**:
`pnpm build` writes `dist/`, and a hub hosts that output the way it hosts any static file. It is
this repo's first package that is not a toon app, and its first `.tsx`.

## What exists today ([#75](https://github.com/toon-protocol/slop_machine/issues/75), [#76](https://github.com/toon-protocol/slop_machine/issues/76), [#77](https://github.com/toon-protocol/slop_machine/issues/77))

The dark shell with four routes, and the discovery half rendered from **real relay reads**:

| Route                   | What it is                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `/`                     | **the discovery grid** — one station card per announced station, ladder and per-segment prices leading, a live badge exactly while an unexpired heartbeat exists (#76) |
| `/categories`           | a tile per announced category, derived from the `t` tags — curation (a small featured list in the route) decides prominence only, never existence (#77) |
| `/categories/:category` | every station announced under that tag, as the same cards the grid uses; a multi-category station appears under each (#77) |
| `/b/:handle`            | the broadcaster page — profile, clips, rung ladder, playback (#78)  |

No bare vanity URLs: display names are not unique, and the handle is the only identity anybody
grants.

## The relay-read layer (`src/relay/`)

The guide reads ADR 0004's four-event schema off a hub relay's **free NIP-01 surface**, and only
that — never a write, never anything paid. The layer is the seam every route consumes, #77's and
#78's included:

- [`relay-url.ts`](src/relay/relay-url.ts) — the one relay, `VITE_RELAY_URL` at build time with
  the devnet's `ws://127.0.0.1:7100` as the fallback literal, so a guide served beside a running
  demo needs no configuration at all.
- [`nip01.ts`](src/relay/nip01.ts) — a hand-rolled NIP-01 reader: one REQ over one WebSocket,
  events before and after EOSE, a redial on a dropped socket. Hand-rolled on purpose — the obvious
  dependency is the announcement **signer**, which is devnet-only by the bundle guard's fence, and
  the guide never signs. Deliberately unverified too: checking `sig` needs a signing-curve
  dependency the payment-free guard forbids, and an announcement is a claim either way.
- [`announcements.ts`](src/relay/announcements.ts) — ADR 0004's kinds and tags as the guide's own
  literals, plus replaceable-event bookkeeping (newest `created_at` stands, ties to the smaller
  id — NIP-01's own rule).
- [`stations.ts`](src/relay/stations.ts) — pure derivation from the log to `Station[]`:
  profile joined by pubkey, heartbeat expiry read off the NIP-40 tag, and **first-mover-wins
  dedupe per station address** — where two pubkeys announce one address, the earlier `created_at`
  wins and the later claimant is dropped, ADR 0004's v1 squatter defense. `isLive` applies NIP-40
  against a caller-supplied clock, because a consumer that trusted a non-pruning relay would show
  dead stations live.
- [`categories.ts`](src/relay/categories.ts) — pure derivation from `Station[]` to the announced
  categories with their station and live counts. A category exists because a station announced
  itself under it, and for no other reason; the featured list lives with the tiles' route, because
  curation is presentation.
- [`stations-context.tsx`](src/relay/stations-context.tsx) — one subscription for the whole page
  and a ticking clock, so a heartbeat that lapses while the tab sits open drops the live badge on
  the next tick, with no reload.

## The Playwright harness (`e2e/`)

The guide's only true test boundary is a browser, and the ordinary suite must run with no browser,
no Docker daemon and no network — so browser specs are **opt-in**: `pnpm test:guide` from the repo
root, beside `test:devnet` and `test:image`. Prerequisite: `pnpm demo --pattern` is running (the
devnet topology with the run's own test pattern); the first spec probes the relay and fails fast
with that command in the message when it is not. The harness serves the guide itself, through the
config's own `vite` web server.

Playwright stays a **global on the box** (via `mise`), never a dependency of this repository, and
two small pieces bridge that: [`e2e/playwright-test.d.ts`](e2e/playwright-test.d.ts) is the narrow
type shim that keeps the specs typechecked with no manifest entry, and [`e2e/run.sh`](e2e/run.sh)
finds the global runner's own `node_modules` and hands it to the specs over `NODE_PATH` — which is
why [`e2e/package.json`](e2e/package.json) pins the directory to CommonJS, since `NODE_PATH`
reaches CommonJS resolution only. Specs are named `*.spec.ts`, never `*.test.ts` (the vitest globs
must not collect them), and everything a run writes lands in `e2e/output/`, gitignored — never in
`deploy/devnet/run/`, which the toolchain excludes wholesale.

## Payment-free, by test

The repo's oldest invariant — no app here contains payment code — reaches this package with extra
force: no part of the paying client can be a web app, ever.
[`src/guide/payment-free.test.ts`](src/guide/payment-free.test.ts) enforces it in the ordinary
suite: it reads this package's own source and manifest and fails on a payer dependency, on
key-material handling, on payment vocabulary — and on the word *channel* anywhere at all, because
here a channel is always a payment channel and this page has nothing to say about one.

## Components come from shadcn, which stays a global

`components.json` is committed; from this directory the globally-installed `shadcn` CLI generates
into `src/components/ui/`, and the generated source is committed like any other. shadcn itself is
a dependency of nothing and no pnpm script calls it — what a component needs at runtime (`cn`,
`radix-ui`, `class-variance-authority`, `lucide-react`) is declared here as an ordinary
dependency, and stays subject to the guard above.

## Vocabulary

The copy teaches the domain's words, not the borrowed layout's: a viber **vibes** with a station,
a finished piece of vibes is a **clip**, the free page about a station is the **broadcaster
page**, and stations are found through **announcements** under **categories**. See the repo's
[`CONTEXT.md`](../../CONTEXT.md).
