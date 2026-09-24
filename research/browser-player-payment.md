# Can a browser Player pay per Pull without a local daemon?

Research for [#2](https://github.com/toon-protocol/slop_machine/issues/2), part of the map [#1](https://github.com/toon-protocol/slop_machine/issues/1).
Vocabulary is from `CONTEXT.md`: Slop, Creator, Player, Pull, Feed.

Paths below are relative to `/home/allidoizcode/Work/TOON-Protocol/`. Sources were read at their
local `main` checkouts on 2026-09-24.

## Answer

**Yes.** A mobile browser can sign and send its own Pull payments with no daemon. The blocker is
packaging, not cryptography or transport. A Pull payment is one local signature plus one packet on
a WebSocket, and every piece on that path is already browser-compatible except three Node imports
that the package root re-exports. Those three imports are not on the paying path.

- **Build: a browser entry of `@toon-protocol/client`**, with a per-device key that is itself the
  channel participant, and BTP over a WebSocket to the platform's connector.
- **Latency per Pull:** one network round trip plus about 2.5 ms of client crypto on a desktop.
  On a phone, expect a few times that.
- **Trust given up:** only the risk of keeping a key in browser storage. The Player still holds
  their own channel.

A custodial payer is easier to build, but it gives up exactly what makes this a TOON showcase.
"Hub" and "session key" turn out to be the same design as the browser SDK, not alternatives to
it (see below).

## What a Pull payment costs a browser

A paid packet goes through five steps (`toon-client/docs/how-a-paid-packet-works.md`):

1. `GET /ilp` for the connector's self-description. This is free and cached per client.
2. Seal the request: ECDH to the connector's secp256k1 key, then HKDF and ChaCha20-Poly1305
   (`@noble/*`).
3. Sign a **claim**: a cumulative balance proof. EVM uses EIP-712 via viem. Solana uses Ed25519
   over a 96-byte message.
4. Send it: `POST /ilp`, or a frame on the BTP WebSocket `GET /ilp/btp`.
5. The connector checks the claim in this order: structure, then freshness (nonce), then value,
   then signature, then collateral. It then answers FULFILL or REJECT, sealed to the same secret.

No chain call happens per packet. "Paying for a request does not [cost gas]: it is a signature"
(`toon-client/docs/channels.md`, § Gas). The chain is touched only to open a channel, deposit,
close and settle.

**Measured** client-side CPU per Pull. This is Node 22 on a desktop, running the toon-client
source through `tsx`, averaged over 200 iterations. The bench script was deleted afterwards.

| Step | Time |
| --- | --- |
| `EvmSigner.signBalanceProof` (EIP-712, secp256k1) | 0.39 ms |
| `sealExchange` (ECDH + HKDF + ChaCha20-Poly1305) | 2.07 ms |
| Raw Ed25519 sign (the Solana claim) | 0.24 ms |

Mobile JS usually runs a few times slower, so budget roughly 5–10 ms. The rest of a Pull's
latency is the network round trip to the connector plus the connector's gate. The gate's
signature check is sub-millisecond and runs after the cheap checks. **A ~20 ms Pull therefore
depends on the network round trip, not on who signs.** A mobile round trip to a single-region
connector is usually well above 20 ms. So the design should keep payment off the critical path:
pay for Pull N+1 while the Player is on Slop N, or pay in parallel with rendering a Slop that was
already fetched. That holds for every option below.

## What stops the SDK loading in a browser today

I bundled `toon-client/packages/client/src/index.ts` with esbuild using `--platform=browser`.
Exactly four unresolved Node imports came back, from three modules:

| Import | From | On the Pull path? |
| --- | --- | --- |
| `node:crypto`, `node:fs` | `src/keys/keystore-node.ts`: the scrypt/AES keystore file, re-exported by `src/keys/index.ts` | No. A browser key never uses this keystore file. |
| `node:fs`, `node:path` | `src/channel/ChannelStore.ts`: `JsonFileChannelStore`, statically imported by `src/client/config.ts` | Only when `channelStore` is passed as a string path. |
| `node:module` | `src/transport/socks.ts` (hidden-service SOCKS). The static copy also comes from `makeBtpWebSocketFactory` in `src/http/HttpIlpClient.ts` | No. Both are dynamic imports reached only for `.anyone` hosts or `HttpIlpClient.upgradeToBtp()`. |

With `node:*` marked external, the root bundles to **577 KB minified**, most of it viem. The docs
already admit this: "The package root is not itself browser-clean today — the Node keystore pulls
`node:crypto` and `node:fs` in" (`toon-client/docs/hidden-service.md`, § Browsers).

Everything else on the path is already written for the browser:

- **Carriage.** `IsomorphicBtpClient` calls `new WebSocket(url)` by default and says it uses the
  "native WebSocket (browser)" (`toon-client/packages/client/src/btp/IsomorphicBtpClient.ts:4`,
  `:209-211`). `ToonClient` builds BTP through `BtpRuntimeClient`, passing an optional
  `createWebSocket` and no Node factory (`src/client/ToonClient.ts:615-630`).
- **The connector accepts a plain browser WebSocket.** "An upgrade offering none [subprotocol] is
  accepted identically … Nothing about the session is trusted from the handshake — authorization
  to write comes from each frame's claim" (`connector/crates/connector-client-edge/src/btp.rs:60-71`).
  No Origin check or handshake header is needed.
- **Keys.** `generateMnemonic`, `deriveFullIdentity` and `generateRandomIdentity` use
  `@scure/bip39`, `@scure/bip32` and `@noble/*`, which are pure JS.
- **HTTP carriage** uses the global `fetch`, and a `fetch` can be injected (`src/client/types.ts:154-157`).
- **Channel store** is an interface. `InMemoryChannelStore` is browser-clean. An IndexedDB store
  is about one small class (`src/channel/ChannelStore.ts`).

There are smaller gaps too:

- `Buffer.from(...)` in `src/signing/solana-signer.ts:153,180` and
  `src/channel/solana/payment-channel.ts:818,955`. These are Solana-only. `src/utils/binary.ts`
  already has `typeof Buffer` guards to reuse. The EVM path has none.
- **CORS on `POST /ilp`.** The devnet nginx allows cross-origin reads only on `GET /ilp/identity`:
  "every other path here stays same-origin-only" (`connector/infra/linode-relay/nginx/node.conf.template:128-140`,
  same in `linode-store`). `POST /ilp` with the `ILP-Payment-Channel-Claim` header needs a preflight.
  So an HTTP-carriage Player must be served same-origin with the platform's connector, or the
  platform's own nginx must add CORS. BTP over WebSocket is not subject to CORS.

**There is precedent for a browser entry.** The package has twice split browser-unsafe code
behind subpaths. `./hidden-service` exists "so a browser bundle never follows an import into
them" (`toon-client/docs/api.md`, § The hidden-service entry point). An earlier browser-safe
`./render` subpath existed for the same reason (`toon-client/packages/client/CHANGELOG.md:1724`).
A `./browser` entry that leaves out `keystore-node` and `JsonFileChannelStore` fits that pattern.

**Stopgap with no upstream change:** in Vite, alias `node:fs`, `node:path` and `node:crypto` to
empty modules. They are never called on the browser path.

## Policy context: what "the browser path was dropped" actually means

The ticket quotes toon-client as having dropped the browser path. **That refers to hidden
services only.** The dropped item is "Any browser path, including a server-side gateway proxying
on a browser's behalf" to a `.anyone` connector, and the stated reason is that "a browser cannot
open a SOCKS connection" (`toon-client/docs/hidden-service.md`, §§ Browsers, Not covered here).
The removed `transport/gateway` module was part of the anon overlay
(`CHANGELOG.md:1773-1782`). A clearnet connector is unaffected.

There is a stronger **cultural** position against payment in the browser elsewhere in the fleet:

- vibe_station: "no part of the paying client can be a web app, because toon-client's keystore is
  Node-only and browser key management is out of scope for ever"
  (`vibe_station/docs/adr/0005-the-budget-lives-on-the-paying-side-of-the-loopback-line.md`).
- toon-meta glossary on rig-web: "Writes enter through the paying clients, never the SPA"
  (`toon-meta/context/glossary.md:24`).
- console binds its daemon to loopback and keeps keys in a Signer (`console/CLAUDE.md`).

The counter-precedent: the connector's operator dashboard **signs in the browser** with WebCrypto
Ed25519 (Chrome 137+, Firefox 130+, Safari 17+), using a key pasted in for the session
(`connector/docs/adr/0066-the-operator-dashboard-is-a-page-the-surface-serves-and-signs-in-the-browser.md`).
It is recorded as fleet decision 0066 in `toon-meta/context/decisions.md:29`.

So the browser option contradicts no protocol rule. It does break a house convention, and that
should be recorded as a Slop Machine ADR: devnet-only, small balances, a per-device key. The
existing reasoning (a shared browser, XSS, key custody) is real, but its stakes are devnet USDC.

## The options

| | A. Browser SDK with a per-device key | B. Platform-hosted custodial payer | C. "Hub": one channel with the platform | D. Session keys |
| --- | --- | --- | --- | --- |
| **What it is** | The Player's browser holds a keypair that **is** the channel participant. It signs claims locally and sends them over BTP to the platform connector. | A server process runs `ToonClient` for all Players and debits a per-Player ledger. The browser calls a platform API. | The Player holds a channel only with the platform's connector, which terminates or forwards Pulls. | A short-lived key authorised by a Player's main wallet to sign claims. |
| **Exists today** | Signing, sealing, BTP, key generation, `claimState` recovery, `ChannelStore` interface. | All of it, since `ToonClient` runs server-side. vibe_station's devnet player is this shape in miniature (`vibe_station/deploy/devnet/player.ts`). | Connector routing, forwarded-route pricing and per-peering fees (`connector/docs/adr/0028-…`, `0061-…`). vibe_station's hub prices the split per segment into `toStation`/`toHub` (ADR 0005 state shape). | Nothing. The claim gate verifies "the counterparty recorded for the channel, not the address the claim declares" (`how-a-paid-packet-works.md`, Step 5.4). TokenNetwork and the Solana program have no delegate-signer field. |
| **To build** | Browser entry (or Vite aliases), IndexedDB `ChannelStore` and key storage, Buffer fixes for Solana, same-origin or CORS if using HTTP carriage. | A Player account and auth (cookie or Nostr), a balance ledger, a payer service, and its own abuse limits. | Nothing beyond A. It is A's topology. | Contract changes on both chains. Not worth it for an MVP. |
| **Per-Pull latency** | 1 round trip browser→connector, plus about 2.5 ms of crypto on desktop, a few times that on mobile. | 1 round trip browser→platform API, plus ~1 ms server→connector if co-located. About the same as A. | Same as A. | n/a |
| **Trust given up** | The key lives in browser storage, so XSS or a malicious Slop that escapes the sandbox could sign with it. The loss is capped at the channel deposit (the collateral step refuses claims over it). The Player keeps unilateral close. | Full custody: the platform holds the money and can freeze or lose it, and the Player has no exit on chain. TOON is then only used platform-to-connector, which undercuts the showcase. | Same as A. The connector is the counterparty either way. | n/a |

### Why C and D collapse into A

- **C (hub).** Slop is a static bundle, and Creators do not run connectors. So the Player's only
  possible counterparty is the platform's connector. A Player holding "one channel with a hub" is
  just option A. The vibe_station-style hub only differs when the far end (a Creator) runs its own
  connector. That is the split question in #3, not a payment-mechanism question.
- **D (session keys).** With no delegate authority in the contracts, a "session key" can only be a
  **fresh key per device that is itself the channel participant**, which is A's per-device key.
  On Solana this can be a **non-extractable WebCrypto Ed25519 `CryptoKey`**. The Solana claim is
  raw Ed25519 over a 96-byte message (`how-a-paid-packet-works.md`, Step 4), and the browser
  support is the same as for connector ADR 0066. Script can then sign with the key but can never
  read it out. EVM claims need secp256k1, which WebCrypto does not offer, so an EVM key would sit
  extractable in IndexedDB.

## Facts the payer decision needs

1. **A Pull is a signature, not a transaction.** No chain call happens per Pull. Chain calls happen
   only at open, deposit and close (`toon-client/docs/channels.md`).
2. **Client crypto is about 2.5 ms per Pull on desktop.** The 20 ms target is decided by network
   round trip, so pay ahead or in parallel.
3. **Only three non-Pull modules keep the SDK root out of a browser.** BTP, signing, sealing and
   key derivation already run in browsers.
4. **The connector's BTP accepts a bare browser WebSocket.** Authorisation comes from each frame's
   claim, and WebSockets are not subject to CORS. The HTTP carriage is same-origin-only on the
   devnet nginx.
5. **The claim signer must be the channel participant.** There are no delegated signers on either
   chain, so "session key" means "a per-device key that owns its own channel".
6. **Nonce state must survive reloads.** A lost watermark causes `F01` refusals, and the library
   raises `ChannelResumeError` rather than restart at 0 (`channels.md`, § The watermark). `claimState()`
   can read the connector's nonce back if the key survives. EVM and Solana channel ids are both
   derivable from the participants (`deriveEvmChannelId`, `connector/docs/adr/0059-…`), so a
   surviving key can find its channel again. A cleared browser loses key and state together, but
   the loss is capped at the deposit.
7. **Worst case for option A is the deposit.** The collateral step refuses any claim over the
   on-chain deposit (`how-a-paid-packet-works.md`, Step 5.5). Keep deposits small, since this is
   devnet anyway.
8. **House convention says "never pay from the SPA".** That comes from vibe_station ADR 0005 and
   the toon-meta glossary. Choosing A means writing a Slop Machine ADR that overrides it for
   devnet, citing connector ADR 0066 as precedent for signing in the browser.
9. **The map's "the app contains no payment code" still holds under A.** The HTTP app behind the
   connector stays payment-oblivious. The web Feed embeds the *client* SDK, which is the payer and
   not the "app" in TOON's sense.

## Recommendation

Choose **A**: a browser entry of the SDK, a per-device key that owns its own channel, BTP to the
platform connector, and payment pipelined ahead of the swipe. Prefer a **Solana** settlement if
#6 allows it, so the key can be a non-extractable WebCrypto key. Keep B as the fallback only if
channel funding (#6) cannot fit inside the one-minute onboarding budget.

## Questions this surfaced

- **What does a Pull's payment actually gate?** If Slop bundles are freely fetchable from Arweave,
  the paid request has to return something the Player needs, such as the next Feed entry or a
  signed pointer. Otherwise paying is voluntary. This affects #4 and #11.
- **A key in browser storage next to untrusted Slop.** The sandbox (#5) now protects money as well
  as the page. The paying origin must be separate from any origin that runs Slop.
- **Upstream ask to toon-client:** a `./browser` subpath entry and an IndexedDB `ChannelStore`,
  or accept the Vite-alias stopgap in the MVP.
- **For #6:** EVM `TokenNetwork.setTotalDeposit` lets a third party credit the Player's side, but
  the Solana program refuses that (`connector/crates/connector-settlement/src/port.rs:215-235`).
  Solana gas can be sponsored by gas-station kind 5096 as fee payer (`gas-station/README.md`).
  Both bear on how fast a browser Player gets a funded channel.
