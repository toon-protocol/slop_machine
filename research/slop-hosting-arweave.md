# Can Slop be hosted on Arweave via the TOON store and embedded in an iframe?

Research for [#4](https://github.com/toon-protocol/slop_machine/issues/4) (map: #1). Researched 2026-09-24.

## Answer

**Yes.** A Slop can be published the way rig publishes a Site. Each file goes up as its own paid `kind:5094` store write, and then one more write uploads an ar.io path manifest. The manifest txid is the Slop's permanent address. Public ar.io gateways send no `X-Frame-Options` or CSP header, so the Feed can embed a Slop in an iframe. Gateways also redirect each txid to its own sandbox subdomain, so **every Slop gets its own browser origin for free, with no ArNS needed**.

There are four catches the Slop format has to design around:

1. **About 1.5 MiB per file.** This comes from the connector's 2 MiB request cap after base64 encoding. Bigger files would need chunked uploads, which exist in the SDK but not in rig.
2. **Bundles must use relative asset paths.**
3. **Cold gateway loads can take seconds.** The Feed should prefetch the next Slop.
4. **Uploads land on mainnet Arweave, so they are permanent**, even though TOON is devnet-only.

## Key facts for the Slop format decision

| Question | Finding |
|---|---|
| Binding size limit | The connector's **2 MiB request body** (not the nginx `4m`). A file travels base64-encoded in an `i` tag plus ~704 B of envelope, so **the largest raw file per write is about 1,572,336 B (~1.5 MiB)**. |
| 105 KB Turbo free tier | This is a **cost to the store operator**, not a cap. Files above 107,520 B are paid by the store in $ARIO. The Creator pays the same `per_kib` schedule either way. The live Turbo service also now reports a **10 MiB lifetime free allowance per wallet and per IP**, and the store signs every upload with a single key. |
| One upload per file? | **Yes.** Each file is its own Arweave data item. Its `Content-Type` comes from the event's `output` tag, and the manifest is one more write. The store has no folder or bundle job. |
| Cost per publish | `1000 + 10 × (⌊sealed/1024⌋+1)` USDC base units per write. That is roughly **$0.001 per file plus ~$0.014 per raw MiB**. A typical 2 MB, 8-file Vite+WASM game costs **~$0.035**. |
| Iframe embedding | Allowed. No `X-Frame-Options` and no `Content-Security-Policy` headers were seen on turbo-gateway.com, arweave.net or ArNS hosts. `access-control-allow-origin: *`. |
| Own origin per Slop | **Yes, automatically.** `GET /<txid>/…` returns 302 to `https://<base32(txid)>.<gateway>/<txid>/…`. The gateway domains are **not** on the Public Suffix List, so different Slop are cross-origin but *same-site* with each other. |
| ArNS needed? | **No.** The manifest txid is enough for addressing, origin isolation and permanence. ArNS costs $ARIO plus SOL per name, takes a multi-step `kind:5095` flow, and adds nothing a Feed needs. |
| Bundle shape | Asset URLs must be **relative** (`./assets/x.js`, Vite `base: './'`). Root-absolute `/assets/x.js` returns 404 on a txid URL because the path keeps the `/<txid>/` prefix. |
| Load latency | Measured from desktop, not mobile. A warm gateway cache gives ~0.5 s TTFB for `index.html`. A cold cache took **15.7 s TTFB** for a 26 MB asset on arweave.net, and 0.8 s once warm. |
| Permanence | The store's Turbo uploads default to **mainnet** Arweave. Slop is public and undeletable. An operator takedown can only hide it from the Feed. |

## Details

### 1. How the store takes bytes

- `kind:5094` puts the whole file in the event: `["i", base64(blob), "blob"]`, `["bid", …, "usdc"]`, `["output", contentType]` (`@toon-protocol/core` `buildBlobStorageRequest` / `parseBlobStorageRequest`, core 3.5.0 as vendored in `../store/node_modules`).
- The store handler uploads the decoded bytes through Turbo and tags them `Content-Type: sanitizeContentType(output)`. It returns the txid (`@toon-protocol/sdk` 3.3.0 `createArweaveDvmHandler`, `TurboUploadAdapter`). Every upload is signed by, and **owned by, the store's key** (`../store/README.md` "Run it locally"). So Arweave ownership says nothing about who the Creator is. Creator attribution has to come from the Nostr listing event.
- The store's HTTP backend is `POST /store { event }` behind the connector (`../store/src/store-backend.ts`).

### 2. Size limits, in the order they bite

1. **Connector request body: 2 MiB, "deliberately not a config knob"** (`../connector/docs/rfcs/0035-ilp-over-http/0035-ilp-over-http.md` §"The body limit…", citing `client-edge-spec.md` §1.1; also `../vibe_station/docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md`).
2. **Base64 plus envelope.** rig measures the metered bytes as `ceil(body/3)*4 + 704` (`../rig/packages/rig/src/publisher.ts` `estimateSealedUploadBytes`, `UPLOAD_ENVELOPE_OVERHEAD_BYTES = 704`). Solving `sealed ≤ 2,097,152` gives **≤ 1,572,336 raw bytes per file**.
3. **nginx `client_max_body_size 4m`** on the store box (`../store/deploy/nginx/node.conf.template:76`). This is looser than the connector cap, so it never binds.
4. **Turbo free tier, 107,520 B per item.** This decides pricing, not whether an upload is allowed (`../rig/packages/rig/src/objects.ts` `FREE_TIER_MAX_ITEM_BYTES`; `../store/README.md`: above it `OnDemandFunding` buys credits in $ARIO, capped by `STORE_TURBO_MAX_ARIO_PER_UPLOAD`, and **refused outright if that ceiling is unset**). A live `GET https://upload.ardrive.io/` on 2026-09-24 returned `"freeTier":{"lifetimeBytes":10485760,"ipBytes":10485760,"maxItemBytes":107520}`. ar.io's docs describe the same 10 MiB lifetime limit per wallet and per IP ([docs.ar.io SKILL.md, Testnet Sandbox](https://docs.ar.io/SKILL.md)). The store's own README still says the free tier is "free for any signer at any balance". **If the lifetime allowance applies to mainnet, a store with no `$ARIO` ceiling set would stop accepting Slop after ~10 MiB in total.**
5. **Files over 1.5 MiB (big WASM, audio, sprite atlases).** The SDK has `uploadBlobChunked`: 500 KB chunks, one paid write per chunk, carried in `param uploadId/chunkIndex/totalChunks`. The store holds the chunks in an in-memory `ChunkManager` with a 50 MiB cap per upload, 100 concurrent uploads and a 5-minute timeout (`@toon-protocol/sdk` `ChunkManager`, `uploadBlobChunked`; the store constructs it with defaults in `../store/src/entrypoint-store.ts:581`). **rig does not use it.** `rig site` only uploads whole blobs. Chunked upload works in principle but has not been exercised, and a store restart mid-upload loses the chunks.

The Player's read path does **not** go through the connector. Players fetch straight from a gateway for free, so the unbounded-response concern in vibe_station ADR 0001 does not apply to them.

### 3. Multi-file bundles: the rig Site pattern

`rig site publish` walks the tree, maps each path to the txid of an already-uploaded blob, builds an `arweave/paths` v0.2.0 manifest (`index.path`, optional `fallback.id` for SPAs), and uploads it as one more write with `output = application/x.arweave-manifest+json`. The site URL is `https://<gateway>/<manifestTxId>/` (`../rig/packages/rig/src/cli/site.ts`). The same flow runs end to end in `../toon-meta/scripts/demo-e2e.sh`, steps 3/6 to 5/6. The manifest schema and content-type tag rule are in the [ar.io Manifests guide](https://docs.ar.io/build/upload/manifests) and [ArweaveTeam path-manifest-schema](https://github.com/ArweaveTeam/arweave/blob/master/doc/path-manifest-schema.md).

A `slop publish ./dist` would therefore make N+1 paid writes. Each file must carry the right MIME type, and WASM needs `application/wasm` for `instantiateStreaming`. rig's `../rig/packages/rig/src/mime.ts` already maps extensions to types.

There is also a **single-file option**. The whole game could be inlined into one HTML file, for example with `vite-plugin-singlefile`. That is one write with no manifest and no path-prefix problem, but it hits the ~1.5 MiB cap and inflates binaries by base64.

### 4. Cost per publish (devnet USDC)

The store route price is `{ base = 1000, per_kib = 10 }` in USDC base units (6 decimals), charged per write as `base + per_kib × ceil(payload/1024)` (`../store/deploy/connector.toml.template:83-121`; `../connector/docs/adr/0065-a-price-is-a-schedule-over-payload-length.md`). rig's client-side estimate is `uploadChargeFor` (`publisher.ts:230`).

These worked examples use rig's formula and a manifest of ~120 B per path:

| Bundle | Writes | Cost |
|---|---|---|
| 40 KB single-file HTML (no manifest) | 1 | ~1,540 units ≈ **$0.0015** |
| ~2 MB Vite+WASM game, 8 files | 9 | ~35,170 units ≈ **$0.035** |
| ~5 MB, 25 files of 200 KB | 26 | ~91,550 units ≈ **$0.092** |

The base fee per file dominates for many small files. The per-KiB term dominates for heavy assets, at about $0.014 per raw MiB once base64 is counted.

### 5. Iframe embedding and origins

Read-only `curl -D -` checks were made on 2026-09-24 against the manifest `CUQAk2IzuFNbVWzplP7ZZtPrIk1ISe1vwlpuS0FC2kQ` (what the ArNS name `ardrive` resolved to):

- `https://turbo-gateway.com/<txid>/` returned **302** to `https://bfcabe3cgo4fgw2vntuzj7wzm3j6wisnjbe6236cljxewqkc3jca.turbo-gateway.com/<txid>/`. arweave.net and ar-io.dev (testnet) behave the same way. I confirmed the subdomain is the lowercase unpadded **base32 of the txid bytes**. ar.io documents this as sandboxing: "Content is served from isolated sandbox environments… Always follow redirects" ([Fetch Data](https://docs.ar.io/build/access/fetch-data)). Its content scanner describes the "origin-isolated base32(txId).<domain> sandbox subdomain" ([ar-io-content-scanner](https://github.com/ar-io/ar-io-content-scanner)).
- The sandbox host, ArNS hosts (`ardrive.ar.io`, `ardrive.arweave.net`) and path URLs returned **no `X-Frame-Options`, no `Content-Security-Policy`, and no `Cross-Origin-*` headers**, only `access-control-allow-origin: *`. Nothing stops iframe embedding.
- Each Slop's manifest txid gets its own origin, distinct from the Feed's origin and from every other Slop's. The Feed can therefore give its iframe `sandbox="allow-scripts allow-same-origin …"`, which Slop needs for localStorage and IndexedDB, without the Slop being able to reach the Feed's origin.
- **Same-site caveat:** none of `arweave.net`, `ar.io`, `turbo-gateway.com` or `ar-io.dev` is on the [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat). All Slop on one gateway therefore share a *site*. A malicious Slop could set cookies on `.turbo-gateway.com` that other Slop would receive. Games that rely on cookies are exposed to this. Storage APIs remain per-origin, and inside a third-party iframe browsers also partition them by the Feed's top-level site.
- **Paths:** `<sandbox>/<txid>/assets/FontManifest.json` returned 200, while `<sandbox>/assets/FontManifest.json` returned 404. On an ArNS host the manifest is served at `/`, so root-absolute paths do work there (`ardrive.turbo-gateway.com/assets/…` returned 200). Txid-addressed Slop **must use relative paths**. ar.io's manifest guide recommends relative paths for the same reason.
- Gateway rate limits are generous: turbo-gateway.com `/ar-io/info` shows a per-IP egress bucket of 5.12 GB that refills at 512 KiB/s.

### 6. Load latency

These numbers come from a desktop connection, not a phone. I could not measure a mobile network from here.

| Request | TTFB | Total |
|---|---|---|
| `index.html` (16 KB) via sandbox, cache HIT | ~0.51 s | ~0.52 s |
| 26.6 MB `main.dart.js` via turbo-gateway.com (1 redirect) | ~0.93 s | 3.9–4.9 s |
| same via arweave.net, cold | **15.7 s** | 18.3 s |
| same via arweave.net, warm | 0.79 s | 1.75 s |

A newly published or rarely pulled Slop can hit a cold cache and take many seconds to start. The Feed should **prefetch the next Slop** before the Player pulls, for example with a hidden iframe or `<link rel=prefetch>` on its manifest and assets. The publish step could also warm the gateway by fetching every path once. Every HTML navigation also pays one extra 302 round trip; linking the sandbox URL directly avoids it.

### 7. ArNS: not needed per Slop

A manifest txid already gives a permanent URL, its own origin, and resolution on every gateway. An ArNS name adds a mutable, human-readable pointer ([ArNS](https://docs.ar.io/learn/arns)). That requires a lease or permabuy priced in ARIO (13+ characters: 200 ARIO × demand factor), SOL for each Solana write, a record TTL (the `ardrive` record showed `x-arns-ttl-seconds: 3600`), and by default only 10 undernames per name ([docs.ar.io SKILL.md](https://docs.ar.io/SKILL.md) constants). On TOON it also means the two-party `kind:5095` prepare/gas-station/buy flow (`../store/README.md` "kind:5095 has two ops"). Slop are immutable, so a mutable name gains nothing. ArNS might make sense for the **Feed app itself**, not for individual Slop.

### 8. Devnet vs. permanence

The store's `STORE_TURBO_SOLANA_NETWORK` defaults to `mainnet` (`../store/README.md` Configuration), and `rig/gateway-preference.ts` explains that rig prints mainnet gateways because the testnet gateway `ar-io.dev` serves data that "never reach[es] Arweave". Slop published through the devnet TOON store is therefore **permanent public mainnet Arweave data**. ar.io's testnet sandbox is the only ephemeral option: it purges data after ~3 days and never posts to mainnet ([SKILL.md Testnet Sandbox](https://docs.ar.io/SKILL.md)).

The operator takedown blocklist can remove a Slop from the Feed, but not from Arweave. Gateways do run their own phishing and content blocking, per ar-io-content-scanner.

## Open questions surfaced

1. **The store's free-tier runway.** Does Turbo's 10 MiB lifetime-per-wallet/IP free allowance apply to mainnet? Is `STORE_TURBO_MAX_ARIO_PER_UPLOAD` set on the devnet store box, and who funds its $ARIO? If it isn't set, publishing stops once the lifetime allowance is used up. This belongs to the store repo, so file it upstream.
2. **Files over 1.5 MiB.** Either cap each file at ~1.5 MiB in the Slop format, or adopt the SDK's in-memory chunked upload, which rig has never exercised.
3. **Per-Slop total size cap.** The map already assumes a cap. The numbers above (cost, cold-load latency) should set it, and something in the 5–10 MB range looks plausible.
4. **Gateway choice and prefetch strategy for the Feed.** Should the Feed use one pinned gateway, or Wayfinder-style routing? Should it link sandbox URLs directly to skip the 302?
5. **Mobile latency.** This still needs measuring on a real phone network, perhaps in a prototype ticket.
6. **Same-site cookie leakage between Slop.** Is this acceptable, or should the Slop format forbid cookies?
