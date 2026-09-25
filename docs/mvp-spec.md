# Slop Machine MVP spec

Slop Machine is a doom-scroll Feed of small web games (**Slop**). Every swipe to the next one is a paid **Pull**, like pulling a slot-machine lever. Creators publish Slop from the command line, and Players pull through a mobile-first web Feed. Each Pull pays the platform a 1¢ devnet-USDC toll. Creators earn from **Purchases** made inside their Slop. Everything runs on the TOON connector, relay and store.

This spec assembles decisions from the [Slop Machine MVP map][map] and decides nothing new. Every section cites the ticket or ADR it comes from. Where the record has a gap, the spec names an **open item** and links the ticket that will close it. Terms are defined in [`CONTEXT.md`](../CONTEXT.md). The ADRs are in [`docs/adr/`](adr/).

**Status:** build-ready except for two open items (see [Open items](#open-items)).

---

## 1. Standing constraints

- **Devnet only.** Players and Creators never move real money. The one exception is infrastructure storage: the fleet funds the store's Arweave uploads with a few dollars of mainnet $ARIO ([ADR 0003](adr/0003-a-slop-is-a-creator-listing-its-versions-live-on-arweave.md), [t18]).
- **Mobile-first web (PWA)**, not native. App stores forbid pay-to-scroll and downloaded code ([map]).
- **Slop is a static web bundle**, played in a sandboxed iframe, with a size cap ([map], [t10]).
- **The house keeps every Pull, and Creators earn from Purchases.** The platform and Creators compete for the Player ([ADR 0002](adr/0002-the-house-keeps-the-pull-creators-earn-from-purchases.md)).
- **The Player pays from the browser**, with a per-device key, and funds their own channel. The platform sponsors nothing ([ADR 0001](adr/0001-the-player-pays-from-the-browser.md), [t20]).
- **Creator publishing is CLI/agent-first** (`slop publish`). There is no web upload form ([map]).
- **Stack:** TS/Node ≥22, pnpm and vitest. UIs use React, Vite and Tailwind. The connector does all pricing, so the app tiers carry no payment logic beyond the browser payer and the treasury service ([map]).

### Out of scope

These are carried over from the map: mainnet or real money for Players and Creators, native apps, social features (likes, follows, comments, browse/search), community moderation, per-Slop Pull stats for Creators, a web upload form, cross-device Saves and Purchase records, crediting Creators for Purchases the treasury service never received ([t30]), a Public Suffix List entry for `slopmachine.fun` ([ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md)), and operator tooling and monitoring ([t27]).

---

## 2. System overview

```
                 slopmachine.xyz  (one origin, split by path)                 *.slopmachine.fun
 ┌────────── Player's phone ──────────┐                                   ┌──────────────────────┐
 │ Feed PWA                           │  BTP WebSocket, /ilp/*            │ <base32(txid)>.      │
 │  · seed + keys (IndexedDB)         │──────────────► connector ──┐      │  slopmachine.fun     │
 │  · browser payer (toon-client)     │                 │ Pull 1¢  │      │  (one origin per     │
 │  · Saves, Purchase records         │                 ▼          │      │   Version)           │
 │  · iframe ◄── Slop Version ────────┼──── caddy ◄── ar-io-core ◄─┼──────┤ cache-only gateway,  │
 │      └ injected shim               │    (CSP)       (cache)     │      │ lockdown CSP         │
 └───────────┬────────────────────────┘                 │ Purchase │      └──────────────────────┘
             │ reads listings,                          ▼ 1/5/10/25¢
             │ operator lists            feed-index   treasury ──► Base Sepolia TokenNetwork
             ▼                            (no keys)   (float key,   (platform → Creator channels)
        TOON relay ◄──── listings ──── slop publish    Nostr key) ──► gift-wrapped proofs ──► relay
             ▲                          (Creator CLI) ──► TOON store ──► Arweave (Versions)
             └── operator-signed blocklist / featured list (signed off-box)
```

| Component | What it is | Section |
|---|---|---|
| **Feed** | PWA on `slopmachine.xyz`: the payer, gesture layer, Slop frames, Purchase sheet, Saves | [§4](#4-feed-app) |
| **Shim** | Script `slop publish` injects into every Version: input replay, pause, `slop-ready`, `window.slop` API | [§5](#5-slop-format-and-the-shim) |
| **`slop` CLI** | Creator's `init` / `fund` / `publish` / `unpublish` / `cashout` | [§6](#6-creator-cli) |
| **Feed index** | Keyless service: relay subscriber, admission, dealing, re-deal and status routes | [§7](#7-feed-index) |
| **Treasury service** | Credits Purchases and pays Creators through platform → Creator channels | [§8](#8-treasury-service) |
| **Connector** | Stock TOON connector that every Player channel opens to, and the only place prices live | [§9](#9-platform-connector) |
| **Slop gateway** | Cache-only `ar-io-core` behind Caddy, serving locked-down Versions | [§10](#10-slop-gateway) |

Sources: [t27], [ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md).

---

## 3. Player: keys, funding, Runway

### 3.1 Keys and recovery

- Each device holds one **seed** in IndexedDB. The seed is an ordinary 12-word BIP39 phrase (the **Recovery phrase**) on the standard paths, derived with toon-client `deriveFullIdentity(mnemonic, { scheme: 'standard', accountIndex: 0 })`:
  - Base Sepolia (secp256k1): `m/44'/60'/0'/0/0`
  - Solana devnet (Ed25519): `m/44'/501'/0'/0'`

  The phrase imports into MetaMask or Phantom ([t25], ADR 0001).
- Each key owns **its own payment channel** with the platform connector. Nothing custodial sits between the Player and the connector ([t8], ADR 0001).
- **Base Sepolia is the default.** "Use Solana instead" opens a second channel on Solana devnet, and the price chip shows which chain is paying ([t8], [t23]).
- **Showing the phrase:** only in **Settings**, and in a one-time, dismissable **backup nudge** after the first deposit lands. The nudge says whoever holds the phrase controls the money ([t25]).
- **Restoring:** "Restore from phrase" on the funding card. A restore *moves* the key to this device, picks up the same channel, and reads the watermark and Runway with `claimState()`. One phrase pulling on two devices at once is unsupported. Restoring over an existing key replaces that key: the Feed warns first that the current key's unspent money stays with it, and offers to show the current phrase ([t25]).
- **A lost key without its phrase:** the deposit and wallet money are stranded, and the platform never closes quiet channels. Seen-history resets for the new key ([t25]).
- The Feed calls `navigator.storage.persist()` on the first deposit ([t25]).

### 3.2 What an unfunded Player gets

- A session opens with **two free entries**: the first Slop, plus the next one preloaded behind it. Flicking from entry 1 to entry 2 is free. The flick from entry 2 lands on the **funding card**. **No free Pulls** beyond that ([t12], [t23]).
- The **funding card** is full-screen and dealt in place of the next Slop. Swiping back through earlier Slop stays free. The **Runway chip** opens the same content as a sheet at any time. There is no screen before the Feed ([t23]).

### 3.3 Funding checklist

Every step is ticked by watching the Player's key on-chain, never by a Player tap. Progress is always derived from the chain, so a Player who leaves resumes where they were ([t23]).

1. **Gas.** Shows the key's address (copy button and QR code) and faucet links.
   - Base Sepolia: QuickNode (no login) and Coinbase CDP. Ticked at ≥0.00001 ETH.
   - Solana: devnetfaucet.org and faucet.solana.com. Ticked at ≥0.0035 SOL.
2. **Mock USDC.**
   - Base: the key calls the ungated `mint()` on TOON mock USDC `0x49beE1…a9Ce` itself (~51k gas).
   - Solana: a TOON faucet button (`POST https://faucet.devnet.toonprotocol.dev/api/solana/usdc-request`, CORS open), unlocked only once step 1 is ticked.
3. **Open channel.** Automatic, and signed by the device key.
   - Base: `approve(MAX)`, then `openChannel`, then `setTotalDeposit` on TokenNetwork `0xe9E05d…952a` (~320k gas in total). Use a read-after-write-consistent RPC such as publicnode, not `sepolia.base.org`.
   - Solana: `initialize_channel` and `deposit` in one transaction.

Only TOON mock USDC counts (`0x49beE1…` on Base, `34eSxY…` on Solana). Circle and CDP USDC are useless here ([t6]).

### 3.4 Deposit, Runway, Refill

- **Each deposit is $10 (1,000 Pulls).** The rest of the key's USDC stays in its wallet ([t23]).
- **Runway** = on-chain deposit − cumulative signed claims, shown as a count of Pulls. The price comes off when a claim is *sent*. Once any doubt is settled, Runway is set from the connector's `available` ([t22], [t23]).
- **Automatic Refill:** below ~100 Pulls of Runway, if the wallet holds USDC and gas, the Feed deposits another $10 by itself (`setTotalDeposit` at the new total on Base, `deposit` on Solana) ([t23]).
- **Empty wallet:** the Runway chip becomes a Refill prompt that reopens the checklist ([t23]).
- The claim-nonce watermark must survive reloads. `claimState()` recovers it from `/ilp/claim-state`, which is same-origin on `slopmachine.xyz`, so no CORS is needed ([t27], ADR 0001).

---

## 4. Feed app

A React PWA served by Caddy at `slopmachine.xyz/`, with a real web app manifest (baked-in `start_url`) ([t7], [t27]).

### 4.1 Gesture layer: "swipe anywhere, no modes"

- A transparent Feed layer sits over the Slop iframe and **owns every touch**. It uses non-passive touch listeners with `preventDefault()`, because mobile browsers otherwise take over pointer streams ([t7]).
- **Quick upward vertical flick** means a **Pull**, from anywhere on screen ([t7]).
- **Downward flick** means **back**, which is free, through the whole session ([t21]).
- **Tap, horizontal swipe, or press-and-hold (~120 ms) then drag** is forwarded into the Slop ([§5.4](#54-input-forwarding)), one message per finger with its own id. If a forwarded touch turns into a Pull, the Feed sends a cancel ([t7], [t14]).
- **A Slop whose listing has `flicks=true`** keeps its vertical flicks. On that Slop, a Pull only starts in a marked bottom zone (~16% of the screen) ([t7]).
- **Cost display:** a `0.01 USDC / pull` chip (it also shows the paying chain), Runway in a corner, and a `−0.01` toast on each Pull. No slot-reel theatre ([t7], [t8]).
- **Autoplay.** There is no play mode and no "tap to play" cover ([t7]).
- **Landscape Slop** is letterboxed inside the portrait Feed, with a "rotate for full screen" hint. Rotating the phone switches to a full-screen Slop with a side rail ([t7]).

### 4.2 Framing Slop

- The iframe `src` is the Version's sandbox origin, `https://<base32(txid)>.slopmachine.fun/`. Link it directly, which skips the gateway redirect ([ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md), [t11]).
- `sandbox="allow-scripts allow-same-origin"`. This is safe only because Slop is cross-site to the Feed ([t5]).
- `allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"`. **`autoplay` is required.** Audio unlocks from forwarded taps on iPhone Safari and the home-screen app only through it ([t5], [t15]).
- No top-navigation, popups, modals, forms, downloads or payment permissions ([t5]).
- The Feed serves `frame-ancestors 'none'` ([t5]).
- **Live window:** previous, current and next. Only the one Slop behind stays alive, paused and muted. Anything further back reloads and restores from its Save ([t21]).
- **A preloaded Slop starts paused**, and the Feed sends resume on landing. A Slop left behind gets pause ([t10], [t21]).
- **Self-navigation is a violation.** A second `load` event on a revealed Slop's iframe makes the Feed kill the frame, show the error card, and report the Slop to the operator. It doesn't Take Down automatically ([ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md)).
- **Takedowns in the Feed:** the Feed reads the operator blocklist from the relay and refuses to frame a blocked Slop, Version or Creator, including one opened by a share link ([t11]).
- **Attribution:** for title, Creator npub, orientation and `flicks`, the Feed reads the Creator-signed listing from the relay while the Slop preloads. It doesn't trust the index's word ([t12]).

### 4.3 Sessions and share links

- Opening a session returns **entries 1 and 2 for free** (see [§7.5](#75-routes)) ([t12]).
- **Share links:** `slopmachine.xyz/s/<npub>/<slug>` plays the Slop's current Version, and `/s/<txid>` plays that pinned Version. Either opens the Feed with that Slop as the session's free first Slop. Every Slop after it is a house pick, and the shared Slop counts as seen ([t10], [t11], [t12]).
- A shared-link Slop that fails to load shows an error card ("This Slop didn't load") with the listing's title and Creator. It is never silently swapped ([t17]).

### 4.4 The Pull

A Pull is a paid `GET` to the Feed index's connector route. Its FULFILL, sealed to the Player, carries the **next Feed entry**. The Feed stays **one ahead**: when the Player is on N, N+1 is already preloaded, and the Pull that lands on N+1 returns N+2 ([t12]).

**A Feed entry** is the Slop's listing address (`<kind>:<pubkey>:<slug>`) plus the current Version's manifest txid ([t10], [t12]).

**Sending.** The Feed signs one claim and sends it over BTP with a per-call `timeoutMs` (~8 s) and `withRetry` off. The Feed runs **no timer of its own**. If no reply comes, one `claimState()` call decides the outcome ([t22]).

| Outcome | How it's known | What the Player sees |
|---|---|---|
| **Not charged** | F01, F03, F06, `claimAck=rejected`, or `claimState` shows the claim wasn't counted | Snap back to the current Slop, at no cost |
| **Delivered** | FULFILL, which carries N+2 | Lands on N+1 once it's ready, and preloads N+2 |
| **Charged, not delivered** | Any other REJECT after counting (F02, T0x, R00), or a timeout where `claimState` shows the claim was counted | Lands on N+1 once it's ready. N+2 comes from the free re-deal route |
| **Can't tell** | `claimState` also fails | Snap back with "Couldn't confirm that Pull". A later confirmation corrects Runway only; the Pull never lands after the fact |

**The landing gate** is *claim counted* **and** `slop-ready` from N+1. While N+1 isn't ready, the transition holds on a Feed-drawn **loading card** showing the listing's title and Creator ([t17], [t22]).

**Load failure** means no `slop-ready` within ~10 s. The iframe `load` event can't be trusted, because gateway error pages fire it too ([t17]).
- A preloaded Slop fails before the flick: the Feed silently re-deals.
- A Slop fails while the Player waits on the loading card: the card reads "That one didn't load, finding another…", and the Pull lands on the first replacement that loads.
- A paid Pull can't land at all (the re-deal cap is hit, there's no entry, or the gateway is down): snap back with "Paid 1¢, but nothing would load. Try again shortly." The cent is lost, with no refund.
- Anything after `slop-ready` (a crash, a freeze) is the Creator's bad game, not a load failure.

**Empty Feed:** the Feed **never charges a flick when nothing is preloaded behind it**. It shows an end card ([t17]).

**Pace:** skimming faster than the Pull round trip plus load time stalls on the loading card by construction, and that's accepted. On iPhone Wi-Fi, a ≤2 MB Slop is ready in 0.4–0.8 s, and a cap-sized 4 MiB Version in ~1–1.5 s ([t28], [t31]).

### 4.5 Purchases

**The Feed's checks** come first. `slop-pay` is accepted only from the Slop origin, then refused at once (no sheet drawn) with `status: 'refused'` and one of these reasons ([t16], [t19]):

| reason | when |
|---|---|
| `over-cap` | tier > 25¢ |
| `bad-tier` | tier isn't 1, 5, 10 or 25 |
| `busy` | another Purchase is in flight (only one at a time) |
| `not-on-screen` | the request isn't from the Slop currently on screen |
| `no-tap` | no tap was forwarded to that Slop in the last 1.5 s |
| `no-payout` | the Slop's listing has no `payout` tag |

**The confirmation sheet** (variant A, "bottom sheet, tap Pay") ([t16]):
- It slides up over the dimmed Slop and shows, from top to bottom:
  - the Slop's icon and title, and the Creator (from the listing)
  - the item label, in quotes, marked "item named by the Slop"
  - the price, large, with "all of it to the Creator"
  - Runway before → after
  - **Pay N¢**, then **Not now**
- The label is the only text the Slop controls. Everything else comes from the Feed.
- **Pay arms after 500 ms.**
- Backdrop tap, **Not now**, or a swipe down on the sheet all decline. While the sheet is open it takes every touch, and no Pull (touch or keyboard) can happen.
- **Short Runway:** if the wallet holds USDC and gas, the automatic Refill ([§3.4](#34-deposit-runway-refill)) covers it. The sheet offers a Refill (reopening the funding checklist) **only when the wallet is empty** ([t23], which supersedes [t16]'s sponsored Refill button).
- While paying, it shows a spinner. On success, "✓ Paid N¢" and a toast `−N¢ → <Creator>`.

**Paying.** One claim is sent to the connector route for that tier. The packet names the Slop's **listing address** and a `purchaseId`. The Feed never sends a payout address ([t19], [t30]). Outcomes follow the same single-timer rule as a Pull ([t22]):

| status | when | reason |
|---|---|---|
| `paid` | FULFILL, **or** the claim was counted with no FULFILL | none. Carries `purchase`, a Feed-side id |
| `declined` | the Player declined | `cancelled` |
| `failed` | the claim was refused, or not counted; the Player isn't charged | `rejected` / `timeout` |
| `failed` | the Feed can't tell whether the Player was charged. The sheet says "Couldn't confirm. Check your Runway." | `unknown` |
| `refused` | the checks above; no sheet was drawn | see the table above |

After `failed`/`unknown`, a later `settleWatermarkDoubt` may find the claim was counted. The Feed then sends a **late `paid` receipt with the same `id`** (if that Slop is still loaded), and always records it in `slop.purchases()` ([t22]).

Receipts can be forged from devtools. This is accepted on devnet, because a forger only cheats the game and no Creator loses pay (ADR 0002).

### 4.6 Saves and Purchase records

- The Feed stores each Slop's **Save** in its own first-party IndexedDB, keyed by the **listing address**, so a Save carries over to new Versions. Saves are capped at **64 KB** of serialised JSON. Writes are debounced, and the last write wins ([t21]).
- The Feed keys each Save request by the **frame it came from**, so a Slop can only ever reach its own Save.
- The current Slop and the paused Slop behind it may call `save` and `load`. A preloaded Slop may call `load` only.
- The Feed keeps a per-Slop list of paid receipts, `{ item, tier, at }`, keyed by listing address ([t21]).
- Everything is device-local. Safari tabs lose it after 7 days without a visit (ITP), and the home-screen app is exempt. Restoring a Recovery phrase doesn't bring Saves or Purchase records ([t21], [t25]).

---

## 5. Slop format and the shim

### 5.1 Slop and Version

- A **Slop** is its Creator's **addressable Nostr listing** on the TOON relay (`d` = a Creator-chosen slug), signed by the Creator's key and written as a paid write. It points at its current **Version** (ADR 0003, [t10]).
- A **Version** is one immutable ar.io **path manifest** uploaded through the TOON store: one `kind:5094` write per file, plus one for the manifest. Versions live on Arweave mainnet, so they are **permanent** ([t4], ADR 0003).
- **The listing is kind `37567`** (addressable), so a Slop's address is `37567:<pubkey>:<slug>`. The number is fresh: it is unassigned upstream and in the fleet, and no existing kind means "listing" without pulling other apps' events into the index's subscription. It is this repo's to keep stable, since every Feed entry, share link and `payout` lookup embeds it ([t33]).

### 5.2 Bundle rules

`slop publish` enforces these before upload, and the index re-checks them at admission ([t10], [t31], ADR 0003, ADR 0004).

| Rule | Limit |
|---|---|
| Entry | `index.html` at the root |
| Paths | relative only (root-absolute `/assets/…` returns 404) |
| Per file | ≤ 1.5 MiB (1,572,336 B: the connector's 2 MiB body cap after base64) |
| Per Version | **≤ 4 MiB** and ≤ 200 files |
| Compression | none (no gzip) |
| Thumbnail | at the `image` path, PNG/JPEG/WebP, ≤ 100 KB, 9:16 or 16:9 to match orientation |
| Self-contained | a Version never references earlier Versions or the network. `slop publish` **warns** on absolute `http(s)://` URLs and on more than one HTML file |

Engines: Phaser, PixiJS, Three.js, Kaplay/Kaboom and Godot web all accept forwarded input. Creators are warned (in docs, or as `slop publish` lints) about mouse-only drags, keyboard-only games, `isTrusted` checks, and anything that needs a real user gesture (fullscreen, pointer lock, vibrate, clipboard). Unity WebGL is untested, so "test on a phone" guidance applies there. Threaded (SharedArrayBuffer) exports won't run ([t5], [t14]).

### 5.3 The lockdown CSP

A Version may load and contact only its own sandbox origin ([ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md)):

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;  media-src 'self' data: blob:;  font-src 'self' data:;
connect-src 'self' data: blob:;
worker-src 'self' blob:;
frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'
```

- The gateway front (Caddy) sends it as a header on every `*.slopmachine.fun` response, plus `frame-ancestors https://slopmachine.xyz`.
- `slop publish` also injects it as a `<meta>` tag, the **first element of every HTML file's `<head>`**, so a Version is locked down even on a raw public-gateway link (except workers loaded from files, which ignore `<meta>`).
- Requests the policy blocks aren't reported as `slop:error`.

### 5.4 The injected shim

`slop publish` injects the shim as `./__slop/shim.js` into `index.html`. It runs **before** the Slop's own scripts, after the CSP `<meta>`. A Creator changes nothing, and an untouched game still works ([t10], [t14]).

**Input replay.** Per forwarded finger, the shim replays what a phone browser sends ([t14]):
1. Pointer events (`pointerType: "touch"`, unique `pointerId` ≥ 2, implicit capture).
2. Touch events. Where `new TouchEvent()` is unavailable, the shim falls back to duck-typed events, and it sets `Touch.pageX` explicitly.
3. **Only after an uncancelled one-finger tap:** `mousemove`, `mousedown`, `mouseup`, then `click`. Live mouse events on top of touch double-press Phaser and Kaplay.

It also patches `setPointerCapture` for synthetic pointer ids, handles multi-touch, and honours cancel (a forwarded touch that turned into a Pull).

**Pause.** On pause, and from preload until the first resume, the shim holds `requestAnimationFrame` callbacks, suspends every `AudioContext`, and pauses media elements. It mutes audio as a backstop, because a Slop can ignore the pause ([t10], [t21]).

**`slop-ready`.** During preload the shim fetches **every file in the Version's manifest** itself. It fires `slop-ready` once window `load` has fired and all of those fetches have finished. This is the Feed's landing and load-failure signal ([t17], [t31]).

**`window.slop` API (Creator-facing, all optional):**

```js
slop.onPause(fn); slop.onResume(fn);                 // lifecycle hooks
const r = await slop.pay({ tier, item, label });     // tier ∈ {1,5,10,25} cents; label ≤ 40 chars
// r = { id, status, tier, item, reason?, purchase? }; never throws.
// A 'slop:receipt' DOM event also fires on window, including any late 'paid'.
slop.save(json);            // ≤ 64 KB; returns { ok:false, reason:'too-big' } over cap; save(null) = new game
const s = await slop.load();          // null when there is no Save
const p = await slop.purchases();     // [{ item, tier, at }], paid receipts for this Slop
```

- `slop.pay` sends its request to `parent` with target origin `'*'`, because the request carries nothing secret ([t16]).
- Creators must accept a `paid` receipt after a `failed`/`unknown` one for the same `id`. The promise resolves once, so the late receipt arrives only through the event and `slop.purchases()` ([t22]).
- **Outside the Feed** (a raw gateway link or a crawler), `save`/`load` fall back to the origin's own `localStorage` (lost on a new Version), and `purchases()` returns `[]` ([t21]).

### 5.5 Feed ↔ Slop messages

Every message uses one envelope, `{ slop: 1, type, … }`, and both sides check `source` and `origin` ([t10]). The Slop can never trigger a Pull. Slop → Feed messages are either display signals (ready, error) or *requests* the Feed may refuse (pay, save/load, purchases) ([t5], [t9], [t21]).

| Direction | Message | Payload |
|---|---|---|
| Feed → Slop | input | `{ kind: 'down'\|'move'\|'up'\|'cancel', id, x, y }`, per finger ([t14]) |
| Feed → Slop | pause / resume | — |
| Feed → Slop | receipt | `{ id, status, tier, item, reason?, purchase? }` |
| Feed → Slop | save/load/purchases replies | result |
| Slop → Feed | ready / error | — |
| Slop → Feed | pay | `{ id, tier, item, label }` |
| Slop → Feed | save / load / purchases | JSON / — / — |

*Editorial note.* The tickets name these messages inconsistently (`feed:input` in one, `slop-input`, `slop-pay` and `slop-ready` in others). Both ends are platform code (the shim is injected, and the Feed is ours), so the exact `type` strings are an implementation choice under the `slop: 1` envelope. Because every published Version bakes in its shim **permanently**, the Feed must keep accepting every envelope version it has ever shipped.

### 5.6 The listing

Signed by the Creator's Nostr key ([t10], [t19]):

| Tag | Required | Value |
|---|---|---|
| `d` | yes | slug |
| `title` | yes | ≤ 40 chars |
| `version` | yes | the current Version's manifest txid |
| `image` | yes | thumbnail path inside the Version |
| `orientation` | yes | `portrait` \| `landscape` |
| `flicks` | yes | `true` \| `false`: whether the Slop uses vertical flicks |
| `payout` | written by `slop publish` | Base address. Without it, Purchases are refused `no-payout` |
| `summary` | no | ≤ 140 chars |
| `t` | no | topic tags |

The Feed uses only the required tags plus `payout`.

---

## 6. Creator CLI

`slop` shares rig's identity model: one BIP-39 seed (it creates one, or reuses `~/.toon-client`). The seed derives the Creator's **Nostr key** (their npub, which signs listings) and an **EVM key** (`m/44'/60'/0'/0/0`), which pays the store and relay and is the default payout address ([t10], [t19]).

| Command | Does |
|---|---|
| `slop init` | Creates or reuses the seed, and writes `slop.json` at the project root. `slop.json` holds the listing fields plus an optional `payout` override, and is never uploaded |
| `slop fund` | Drips TOON faucet funds to the Creator's key, as rig's `fund` does |
| `slop publish [dir]` | Publishes a Version (see below). CLI flags override `slop.json` for one run |
| `slop unpublish <slug>` | Writes a NIP-09 deletion of the listing. The index drops the Slop, and `/s/<txid>` keeps playing |
| `slop cashout` | Fetches the newest gift-wrapped proof on every Creator channel and redeems it with `claimFromChannel` (see open item 3) |

**`slop publish` steps** ([t10], [t11], [t26], [t31]):
1. **Validate** against [§5.2](#52-bundle-rules). Refuse, naming the file, over any cap. Warn on absolute URLs and on more than one HTML file.
2. **Inject** the CSP `<meta>` into every HTML file, and the shim into `index.html`.
3. **Estimate the cost and confirm.** `--yes` skips the prompt for agents.
4. **Upload** each file, skipping any already in the local content-hash → txid cache. This makes a run **resumable**, which is required because store#132 charges for refused writes.
5. **Upload** the manifest.
6. **Sign and write** the listing (with `payout`).
7. **Print** the share link, `/s/<npub>/<slug>`.
8. **Poll** the index status route and print the result. Exit non-zero on `rejected`.

**Costs to the Creator** (devnet USDC through the connector's schedule): `1000 + 10 × (⌊sealed/1024⌋+1)` base units per write, about $0.001 per file plus ~$0.014 per MiB. The fleet key separately pays Turbo ~$0.08/MiB in mainnet $ARIO ([t4], [t18]).

---

## 7. Feed index

A keyless service (`feed-index` container). Its state can all be rebuilt from the relay, except the per-payer seen-history. That lives in a SQLite volume that isn't backed up, and losing it only means repeats ([t11], [t27]).

### 7.1 Ingest

- It holds a long-lived NIP-01 subscription to the TOON relay for the listing kind, kind 5 deletions, and the operator's blocklist and featured list. It backfills everything on start. Reads are free ([t11]).
- A NIP-09 deletion signed by the listing's own pubkey drops the Slop straight away ([t11]).

### 7.2 Admission

Before a Version is ever dealt, and again whenever the listing's pointer moves ([t11], [t26], [t28], [t31]):
- **Fetch the whole Version through our gateway** (`*.slopmachine.fun`), which warms its cache so no Player pays a cold miss.
- **Check:**
  - `index.html` is at the root
  - ≤ 200 files, each ≤ 1.5 MiB, and **≤ 4 MiB measured total** (otherwise `too-large`)
  - the `image` thumbnail exists
  - the required tags are valid
  - **every HTML file carries the lockdown CSP `<meta>`**

A Version over the cap is never dealt, although it still opens by its link. There is no approval queue.

### 7.3 Dealing

- **Weighted random** ([t11]):
  - floor weight 1
  - **×5 on first admission**, decaying linearly to ×1 over 72 h (a republish never boosts again)
  - **featured ×3**, multiplied with the recency boost
  - these weights are tunable config
- **Never the same Creator twice in a row.** This is relaxed when it's the only way to deal ([t11], [t17]).
- **Never a Slop this payer has seen** (seen-set keyed on `X-TOON-Payer`; identity is the Slop, not the Version). Once everything has been seen, the index falls back to least-recently-seen. An empty Feed therefore only means zero eligible Slop ([t11], [t17]).
- A failed-and-replaced Slop isn't added to the seen set, but is excluded for that payer for the rest of the session ([t17]).
- Blocked Slop, Versions and Creators are never dealt ([t11]).

### 7.4 Failure reports and re-admission

The index counts failure reports per Version from distinct payers. Past a threshold, it re-runs admission. If that fails, the status route reports `rejected: unreachable` and the index stops dealing the Version. This is re-admission, not a Takedown ([t17]).

### 7.5 Routes

The connector passes paid and zero-priced routes to the index over HTTP with `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` stamped. Free public routes sit under `slopmachine.xyz/index/*` ([t12], [t27]).

| Route | Price | Does |
|---|---|---|
| **Pull** (`GET`) | 1¢ | Returns the next entry. Its answer (even an error) comes back on a charged FULFILL |
| **Session open** | free | Returns entries 1 and 2. Ideally a zero-priced connector route, so `X-TOON-Payer` is stamped. The fallback is plain HTTP with the payer key as an unauthenticated parameter ([t11]) |
| **Re-deal** (e.g. `POST /redeal {failed: <txid>}`) | free (zero-priced route) | Replaces this payer's single **outstanding** entry with a fresh pick, and records a failure report. Capped at ~3 between Pulls; over the cap, it returns no entry. Also fills N+2 after a charged-not-delivered Pull ([t17], [t22]) |
| **Status** `GET /index/slop/<npub>/<slug>` | free | `admitted \| pending \| rejected: <reason> \| blocked`, where reason is e.g. `too-large` or `unreachable` ([t11], [t31]) |

### 7.6 Operator lists

- The **blocklist** (Slop addresses, Version txids, Creator pubkeys) and the **featured list** (Slop addresses) are operator-signed replaceable Nostr list events (NIP-51-style) on the relay. The operator signs them **from their own machine**, never on the box ([t11], [t27]).
- **Kinds:** the blocklist is `17567` and the featured list `17568`. Both are plain replaceable events, one of each per operator key (NIP-51 *standard lists*, whose meaning is carried by the kind, not by `d`). The index reads both with `{kinds:[17567,17568], authors:[<operator>]}`. Kinds `10032`–`10099` are avoided, because the TOON relay stores that range keyed on `d` ([t33]).
- **Takedown enforcement:** in the index (never dealt, status `blocked`) and in the Feed app (refuses to frame). Not at the relay or gateway ([t11], ADR 0004).

---

## 8. Treasury service

A single platform program (`treasury` container) that **only pays Creators**. It sponsors no Players (ADR 0001, ADR 0002, [t20]).

**Keys and state** ([t19], [t27]):
- Its own **float key** (EVM, Base Sepolia), separate from the connector's settlement keys, funded by the operator by hand (it mints mock USDC and takes faucet ETH).
- Its own **Nostr key**.
- Its own toon-client channel to the relay's connector, for paid relay writes.
- A SQLite ledger with `{total, nonce, deposit}` per channel, rebuildable from its self-wraps plus on-chain deposits.

**On each Purchase delivery** (connector routes 1¢/5¢/10¢/25¢ → treasury) ([t9], [t19], [t30]):
1. Dedupe by `purchaseId`.
2. Resolve the named listing and read `payout`, trusted on the Creator's Nostr signature alone.
3. **Commit the credit to SQLite, then answer 2xx.** Any HTTP answer returns as a FULFILL.
4. After answering: if this address has no channel, `openChannel(creatorAddress, 7 days)` and `setTotalDeposit` $5 of minted USDC. If the new total would exceed the deposit, first raise the deposit to total + $5. **Never gift-wrap a proof the deposit doesn't cover.**
5. Sign a cumulative EIP-712 balance proof on the platform → Creator channel (TokenNetwork, Base Sepolia). It handles one Purchase at a time per channel, so nonces strictly increase.
6. Gift-wrap the proof (NIP-59, kind 1059, `p` = the Creator's npub) and write it to the relay. Also self-wrap it to the treasury's own npub. That's two paid writes per Purchase.

**Rules:**
- **Channels are per payout address.** A Creator who changes `payout` gets a new channel ([t19]).
- It **never closes** Creator channels. After a settle (for example a force-close at the 365-day lifetime), the next Purchase opens a fresh channel ([t19]).
- **Creator channels are Base only.** A Purchase paid from Solana still credits the Base claim (ADR 0002).
- **Charged but never received:** the platform keeps that Purchase, and the treasury service logs every case where a Player was charged but no Purchase arrived ([t30]).
- **Redeem relay:** it relays the Creator's `claimFromChannel` through the ERC-2771 forwarder, because the gas station refuses claims (gas-station#18) (ADR 0002). **Open item 3: how the request reaches the treasury service, and how its gas is protected** → [How does slop cashout reach the treasury service to relay a redeem?][t34]

---

## 9. Platform connector

The stock `ghcr.io/toon-protocol/connector` image at a pinned tag. It is **the one connector** every Player channel opens to ([t27]).

| Route | Price | Handler |
|---|---|---|
| Pull | 1¢ (`10000` base units) | feed-index |
| Purchase ×4 | 1¢, 5¢, 10¢, 25¢ (flat, one route per tier) | treasury |
| Session open, re-deal | 0 (if zero-priced routes work; see [§7.5](#75-routes)) | feed-index |

- **Keys:** `signer.key`, `settlement.key` (EVM), and `settlement-solana.key`, which must hold devnet SOL to boot. Claim journals live on the `connector_state` volume ([t27]).
- **Serving:** BTP WebSocket and `/ilp/*` are served on `slopmachine.xyz`, the same origin as the PWA ([t27]).
- The platform keeps 100% of the Pull. A fee is flat per packet, and the connector can't express a split or an amount chosen by the payer (ADR 0002, [t3]).
- No ticket covers redeeming the platform's own Player claims. The connector can redeem without closing (`claimFromChannel`) ([t25]), and the spec treats that as operator tooling, which the map rules out of scope ([t27]).

---

## 10. Slop gateway

A cache-only `ar-io-core` (`ar-io-core` container) ([ADR 0004](adr/0004-slop-is-served-locked-down-from-our-own-gateway.md), [t27]):
- Config: `ARNS_ROOT_HOST=slopmachine.fun`, `START_WRITERS=false` and `RUN_OBSERVER=false`, with no envoy, observer or redis.
- `TRUSTED_NODE_URL` direct. The cache TTL cleanup is set.
- `mem_limit` ~1.25 GiB, with `restart: unless-stopped`.
- Each Version gets its sandbox origin at `<base32(txid)>.slopmachine.fun`. Caddy terminates TLS with a `*.slopmachine.fun` wildcard cert issued by DNS-01 through Porkbun, and adds the lockdown CSP and `frame-ancestors` headers, which core can't set.
- **No fallback to public gateways.** An outage is a load failure and goes down the re-deal path.
- **No Takedowns at the gateway, and no PSL entry** for the MVP.
- The Feed and Slop must never share a gateway domain.
- Measured: ~0.7–0.8 GiB RSS, <1 GB disk plus cache. A cold fetch took 5–10 s, and a cached one <10 ms.
- **Open item 1: which upstream to fetch cold Versions from, and the cache TTL.** ADR 0004 and [t27] use `ar-io.dev`, because arweave.net 429s gateway hops, while [t28] recommends arweave.net → [Which upstream should our Slop gateway fetch cold Versions from?][t32]

---

## 11. Deploy

- **One 4 GB Linode**, running five containers: `caddy` (image `slop-machine-feed:release`, with the PWA `dist/` baked in and the `caddy-dns/porkbun` module), `connector`, `feed-index`, `treasury`, and `ar-io-core` ([t27]).
- **`deploy/` in this repo**, in the relay/vibe_station shape:
  - `docker-compose.yml`, plus `.local.yml` and `.watchtower.yml`
  - `Caddyfile`, `connector.toml` and `.env.example`
  - `auto-apply.sh`, plus `toon-auto-apply.service` and `.timer` (GitOps every 5 min from `/root/slop_machine`)
  - `bundle.test.ts`
- **CI:** GitHub Actions on `main` builds `ghcr.io/toon-protocol/slop-machine-{feed,feed-index,treasury}` as `:release` plus an immutable `sha-…` tag. Watchtower follows `:release`, and the connector stays pinned in compose.
- **Backups:** only keys, offline, by hand. The operator Nostr key never sits on the box.
- **Fallback:** if memory is tight, move `ar-io-core` to its own box. Nothing changes but DNS.

---

## 12. Upstream dependencies

| Dependency | Needed for | Status |
|---|---|---|
| toon-client `./browser` subpath export (without its four `node:*` imports), following the `./hidden-service` split | the browser payer | Ask upstream. A Vite alias is the MVP stopgap ([t2], [t8], ADR 0001) |
| EVM `claimFromChannel` helper | `slop cashout` | Not in toon-client. Lift it from `../swap` (ADR 0002) |
| Paid uploads on the devnet store: `STORE_TURBO_MAX_ARIO_PER_UPLOAD=120`, $5 of mainnet $ARIO on the store key, restart, then confirm `/health` shows `paidUploads` on | publishing any file > ~105 KB | Agreed by the fleet. **Execution pending** on the store box ([t18]) |
| store#135: `/health` runway visibility | seeing the store float from outside | Filed ([t18]) |
| store#132: refused writes are still charged | — | Open. That's why `slop publish` must resume ([t10]) |
| gas-station#18: the gas station refuses claims | — | Open. That's why the treasury service relays redeems ([t9]) |
| The TOON faucet's own SOL spend on Solana Players' token accounts | Solana funding | Operator note ([t23]) |

---

## 13. Tunables and numbers

| Item | Value | Source |
|---|---|---|
| Pull price | 1¢ = `10000` base units (6-dec USDC) | ADR 0002 |
| Purchase tiers | 1¢, 5¢, 10¢, 25¢ (the cap) | ADR 0002 |
| Player deposit / Refill | $10 (1,000 Pulls) | [t23] |
| Auto-Refill threshold | below ~100 Pulls | [t23] |
| Gas tick thresholds | ≥ 0.00001 ETH / ≥ 0.0035 SOL | [t23] |
| Send timeout | ~8 s per call, `withRetry` off | [t22] |
| Load-failure timeout (`slop-ready`) | ~10 s | [t17] |
| Re-deal cap between Pulls | ~3 | [t17] |
| Purchase tap window / Pay arming | 1.5 s / 500 ms | [t16] |
| Press-and-hold to forward | ~120 ms | [t7] |
| Flick bottom zone | ~16% of screen height | [t7] |
| Save cap | 64 KB | [t21] |
| Version caps | 1.5 MiB/file, 4 MiB and 200 files/Version | [t31], ADR 0003 |
| Thumbnail | ≤ 100 KB, 9:16 or 16:9 | [t10] |
| Ordering | ×5 recency decaying over 72 h, ×3 featured | [t11] |
| Creator channel | $5 open, then +$5 top-ups; 7-day settle timeout | [t19] |
| Store float | $5 of $ARIO ≈ 63 MiB ≈ 15 cap-sized Versions | [t18], [t31] |

---

## Open items

Each is a ticket on the map. Its resolution replaces the item here.

1. **Gateway upstream and cache TTL.** [Which upstream should our Slop gateway fetch cold Versions from?][t32] ([§10](#10-slop-gateway))

*Resolved:* item 2, the Nostr kind numbers, is now listing `37567`, blocklist `17567` and featured list `17568`. See [Which Nostr kinds do the Slop listing and the operator lists use?][t33] ([§5.1](#51-slop-and-version), [§7.6](#76-operator-lists)).

3. **Redeem relay transport and gas protection.** [How does slop cashout reach the treasury service to relay a redeem?][t34] ([§8](#8-treasury-service))

## Known unverified assumptions

These are carried as risks, not open decisions:
- Zero-priced connector routes for session open and re-deal. A plain-HTTP fallback is specified ([t11]).
- iOS audio passed on one iPhone, but the iOS version wasn't captured ([t15]).
- Load latency was measured on iPhone Wi-Fi only. LTE and 3G weren't run, so mobile is at best this good ([t28]).
- Unity WebGL input was reasoned from source, not run ([t14]).

---

## Sources

[map]: https://github.com/toon-protocol/slop_machine/issues/1
[t2]: https://github.com/toon-protocol/slop_machine/issues/2 "Can a browser Player pay per Pull without a local daemon?"
[t3]: https://github.com/toon-protocol/slop_machine/issues/3 "How can one Pull pay both the platform and the Creator?"
[t4]: https://github.com/toon-protocol/slop_machine/issues/4 "Can Slop be hosted on Arweave via the TOON store and embedded in an iframe?"
[t5]: https://github.com/toon-protocol/slop_machine/issues/5 "How do we sandbox untrusted Slop in the Feed?"
[t6]: https://github.com/toon-protocol/slop_machine/issues/6 "How fast can a new Player get a funded devnet channel?"
[t7]: https://github.com/toon-protocol/slop_machine/issues/7 "What should pulling through the Feed feel like?"
[t8]: https://github.com/toon-protocol/slop_machine/issues/8 "How does a Player pay for Pulls?"
[t9]: https://github.com/toon-protocol/slop_machine/issues/9 "What does a Pull cost and how is it split?"
[t10]: https://github.com/toon-protocol/slop_machine/issues/10 "What is a Slop and how does a Creator publish one?"
[t11]: https://github.com/toon-protocol/slop_machine/issues/11 "How does the Feed learn what Slop exists and order it?"
[t12]: https://github.com/toon-protocol/slop_machine/issues/12 "What does paying for a Pull actually unlock?"
[t14]: https://github.com/toon-protocol/slop_machine/issues/14 "Do common Slop engines accept Feed-forwarded input?"
[t15]: https://github.com/toon-protocol/slop_machine/issues/15 "Does Slop audio play on iPhone with forwarded input?"
[t16]: https://github.com/toon-protocol/slop_machine/issues/16 "How does a Slop ask for a Purchase?"
[t17]: https://github.com/toon-protocol/slop_machine/issues/17 "What happens when a revealed Slop fails to load?"
[t18]: https://github.com/toon-protocol/slop_machine/issues/18 "Will the fleet fund paid uploads on the devnet store?"
[t19]: https://github.com/toon-protocol/slop_machine/issues/19 "How does the treasury service learn a Creator's payout address, and how much collateral backs each Creator channel?"
[t20]: https://github.com/toon-protocol/slop_machine/issues/20 "Can the Solana devnet faucet fund $1 of sponsored Runway per Solana Player?"
[t21]: https://github.com/toon-protocol/slop_machine/issues/21 "How does a Slop keep game state, across Pulls and across visits?"
[t22]: https://github.com/toon-protocol/slop_machine/issues/22 "How does the Feed settle a FULFILL that arrives after it gave up?"
[t23]: https://github.com/toon-protocol/slop_machine/issues/23 "How does a new Player fund their channel, and what do they get for free meanwhile?"
[t25]: https://github.com/toon-protocol/slop_machine/issues/25 "What happens to a Player's channel and Runway when their device key is lost?"
[t26]: https://github.com/toon-protocol/slop_machine/issues/26 "Where is Slop served from: public ar.io gateways or a platform-run, Slop-only domain?"
[t27]: https://github.com/toon-protocol/slop_machine/issues/27 "Which services does the platform run, and how do they deploy?"
[t28]: https://github.com/toon-protocol/slop_machine/issues/28 "Measure Slop load latency on real mobile networks"
[t30]: https://github.com/toon-protocol/slop_machine/issues/30 "Can the treasury service credit a Creator from a counted claim it never saw?"
[t31]: https://github.com/toon-protocol/slop_machine/issues/31 "How does the Feed handle Slop too big to preload one ahead?"
[t32]: https://github.com/toon-protocol/slop_machine/issues/32 "Which upstream should our Slop gateway fetch cold Versions from?"
[t33]: https://github.com/toon-protocol/slop_machine/issues/33 "Which Nostr kinds do the Slop listing and the operator lists use?"
[t34]: https://github.com/toon-protocol/slop_machine/issues/34 "How does slop cashout reach the treasury service to relay a redeem?"

Ticket links show each ticket's title on hover. Prototypes: [`prototype/feed-pull`](https://github.com/toon-protocol/slop_machine/tree/prototype/feed-pull) (Pull feel, shim) and [`prototype/purchase`](https://github.com/toon-protocol/slop_machine/tree/prototype/purchase) (Purchase sheet). Research write-ups are on the `research/*` branches linked from each research ticket. The load bench is on [`task/slop-load-latency`](https://github.com/toon-protocol/slop_machine/tree/task/slop-load-latency/measure/slop-load).
