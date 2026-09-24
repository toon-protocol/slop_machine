# Slop is served locked down, from our own gateway on slopmachine.fun

Public ar.io gateways send no CSP, so a published Version doesn't bind what a Slop does: it can fetch and run code from anywhere after publish, and a harmless game can turn into a phishing page for the Player's Recovery phrase without its Version changing. We lock every Version down to its own files. A Slop may load and contact only its own sandbox origin, never the network.

The Feed frames Slop from a cache-only `ar-io-node` (`START_WRITERS=false`, on-demand retrieval from trusted gateways) that we run with `ARNS_ROOT_HOST=slopmachine.fun`, so each Version gets its per-tx sandbox origin `<base32(txid)>.slopmachine.fun` behind a wildcard cert issued by DNS-01 through the Porkbun API. The gateway adds the lockdown as a CSP header on every response, which also covers worker scripts, plus `frame-ancestors https://slopmachine.xyz`. The Feed lives on `slopmachine.xyz`, a different site. `slop publish` also injects the same policy as the first element of every HTML file's `<head>`, and the Feed index refuses a Version where any HTML file lacks it, so a Version opened from a raw public-gateway link is still locked down (except for workers loaded from files, which ignore a `<meta>` policy).

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;  media-src 'self' data: blob:;  font-src 'self' data:;
connect-src 'self' data: blob:;
worker-src 'self' blob:;
frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'
```

## Considered Options

- **Public gateways, with Takedown as the only control.** Rejected. It allows networked Slop (leaderboards, multiplayer), but a Version then proves nothing, and harm is only handled after the fact. Loosening the lockdown later is easy. Tightening it later would break every Slop that already relies on the network.
- **A `<meta>` CSP only, on public gateways, with no box.** Rejected as the sole mechanism. Workers loaded from files run with no policy, so it needs `worker-src 'none'`, which breaks engines. The Feed would also share a gateway with every other site's content.
- **A thin reverse proxy instead of `ar-io-node`.** This is the fallback if the node is too heavy to run. It would have to reimplement manifest resolution and sandbox redirects itself.
- **A per-listing origin allowlist.** Rejected. A phishing Slop would just declare its own collection server.

## Consequences

- Slops can't use any outside service. Every Version is a complete bundle (it can't reference earlier Versions), and a Slop is a single HTML document. `slop publish` warns about absolute `http(s)://` URLs and about more than one HTML file.
- The lockdown can't stop a frame from navigating itself (`navigate-to` is dead), so a Slop can still leak data once by navigating its own iframe. The Feed treats a second `load` on a revealed Slop's iframe as a violation: it kills the frame, shows the error card and reports the Slop to the operator. It doesn't Take Down automatically.
- Slops on `slopmachine.fun` are cross-origin but same-site with each other until the domain is on the Public Suffix List. Only cookies leak, and Slop has no use for them, so the PSL entry is a follow-up, not a prerequisite.
- Takedowns stay in the Feed index and the Feed app. The gateway doesn't enforce them, because any public gateway serves the tx to anyone who has the raw URL.
- If our gateway is down, the Feed doesn't fall back to a public gateway: the Slop fails to load, and the re-deal path handles it.
- Whatever the future ArNS name is for, the Feed and Slop must never share a gateway domain.
- The platform runs one more service: `ar-io-core` alone (no envoy, observer or redis; `START_WRITERS=false`, `RUN_OBSERVER=false`, `ar-io.dev` as trusted gateway, since arweave.net rate-limits gateway hops), on the platform box. Core can't set response headers, so the platform's Caddy front adds the CSP and `frame-ancestors`, and it also holds the `*.slopmachine.fun` wildcard via the Porkbun DNS-01 module. Decided in "Which services does the platform run, and how do they deploy?" (slop_machine#27).
