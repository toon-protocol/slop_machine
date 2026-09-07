# @toon-protocol/guide

The guide: the viber-facing discovery surface of
[epic #72](https://github.com/toon-protocol/slop_machine/issues/72) — where a viber finds
stations, browses categories, reads broadcaster pages, and will one day click through to vibe.

A Vite SPA on React, Tailwind and shadcn. **Browser-only, static build, no server of its own**:
`pnpm build` writes `dist/`, and a hub hosts that output the way it hosts any static file. It is
this repo's first package that is not a toon app, and its first `.tsx`.

## What exists today ([#75](https://github.com/toon-protocol/slop_machine/issues/75))

The dark shell, with four routes stubbed and navigable:

| Route                   | What it becomes                                                     |
| ----------------------- | ------------------------------------------------------------------- |
| `/`                     | the discovery grid — one station card per announced station (#76)   |
| `/categories`           | every category any station announces itself under (#76)             |
| `/categories/:category` | the stations announced under one category (#76)                     |
| `/b/:handle`            | the broadcaster page — profile, clips, rung ladder (#77), playback (#78) |

No bare vanity URLs: display names are not unique, and the handle is the only identity anybody
grants.

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
