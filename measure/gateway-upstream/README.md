# Slop gateway upstream: cold-fetch measurement

A throwaway harness for [Which upstream should our Slop gateway fetch cold Versions from?](https://github.com/toon-protocol/slop_machine/issues/32). Run on 2026-09-24/25.

## Setup

- `ghcr.io/ar-io/ar-io-core:4704625fe2587cdca2c53828dbc5ceefbd22b4b2` (built 2026-09-02). It is configured like the one in the deploy ticket: `START_WRITERS=false`, `RUN_OBSERVER=false`, `ARNS_ROOT_HOST`, no envoy/redis, and `mem_limit` 1.25 GiB. There is one container per upstream, and each uses `ON_DEMAND_RETRIEVAL_ORDER` set to a single source so that nothing else masks it.
- It ran on a home workstation on residential broadband, with the host heavily loaded (load ~25, swapping). Treat the absolute times as upper-ish bounds, and trust the *relative* outcomes more.
- **A cap-sized Version** is 3 random, old, Arweave **bundled data items** of 1.2–1.5 MiB each (≈ 4 MiB), found through Goldsky GraphQL (`find.mjs`) and fetched **in parallel** through `/raw/<id>`. Each Version is fetched once cold and then once warm. Every (gateway, round) uses fresh items, so a result from one gateway never warms another.
- `bench.mjs` compares 5 upstreams over 5 rounds. `bench2.mjs` compares the recommended two-tier config against each single upstream over 6 rounds, on fresh items.
- `fresh.mjs` uploads a tiny throwaway Version (3 × 90 KiB random files plus a path manifest) on Turbo's free tier with a random key, then polls each gateway until it serves the data. This is the admission case: `slop publish` has just uploaded the Version.

## Results

| Upstream (`TRUSTED_GATEWAYS_URLS`) | Complete cold Versions | Items | Cold wall, complete Versions |
|---|---|---|---|
| `arweave.net` trusted | 0/5 | 0/15 | — (every fetch `429` → 404) |
| `arweave.net` `trusted:false` | 0/5 | 0/15 | — (every fetch `429` → 404) |
| chunks only (`chunks-offset-aware`, `TRUSTED_NODE_URL=arweave.net`) | 0/5 | 0/15 | — (90 s timeouts: it can't locate a data item's parent bundle without an index) |
| `ar-io.dev` | 7/11 | 25/33 | 4.5–7.0 s (one 73 s outlier) |
| `turbo-gateway.com` | 7/11 | 27/33 | 2.4–8.8 s |
| **`turbo-gateway.com` p1 + `ar-io.dev` p2, 30 s timeout** | **5/6** | **17/18** | **3.9–5.6 s** (15.5 s for the round in which turbo 429'd, which fell back) |

Warm (cache HIT): 0.01–0.13 s for 4 MiB.

**Freshly uploaded Version** (seconds after the Turbo upload receipt until it was first served):

| Upstream | Served after |
|---|---|
| `turbo-gateway.com` | ~10 s |
| `ar-io.dev` | ~48 s |
| `arweave.net` (either mode) | never (`429`) |
| chunks only | not within 20 min (the bundle wasn't seeded yet) |

The manifest's path resolution through the sandbox host (`<base32>.slop.localhost/<manifest>/c.bin`) returned 200 through turbo-gateway.com. `fresh.out` shows `path NOT served` only because the probe's own redirect-follow was broken. The path was checked by hand.

## Failure modes seen

- **arweave.net answers `429` (with `retry-after: 299`) to any request carrying any `X-AR-IO-*` header**. `Hops`, `Origin`, `Node-Release` and `Via` were each tested alone. It answers `200` to the same request without them. ar-io-core sends these headers to every upstream, including `trusted:false` ones (only the `ar-io-*` query params are dropped for untrusted ones). So arweave.net can't be a `trusted-gateways` upstream in either mode. The phone-side 1–4 s from the load-latency ticket was measured without these headers.
- **The 10 s default `TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS`** cut off slow cold fetches as 404 on both ar-io.dev and turbo-gateway.com (the misses cluster at exactly ~10.0 s). The same item then came back in 1.8 s on retry.
- **turbo-gateway.com rate-limits**: `429` after ~40 cold fetches from one IP in ~30 min (two test gateways shared the IP). ar-io.dev returned intermittent `504`s. It also 404s some old data outright. Every single upstream had failures, so the fallback tier and admission retries are what make the setup reliable.
