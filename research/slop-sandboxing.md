# Research: sandboxing untrusted Slop in the Feed

Ticket: [#5](https://github.com/toon-protocol/slop_machine/issues/5) (part of map #1). Researched 2026-09-24.

**Question.** A Slop is arbitrary vibe-coded JS that plays inline in a paid Feed. What iframe/isolation setup stops a Slop from:

1. reaching the Player's payer/keys,
2. triggering Pulls or payments,
3. navigating the top frame,
4. cross-reading other Slop,
5. phishing?

How does Arweave/ar.io gateway hosting affect the answer?

## TL;DR

- **The main boundary is the origin, not the `sandbox` flags.** Serve every Slop from its own origin: the ar.io per-tx sandbox subdomain `https://{base32(txid)}.{gateway}/{txid}/`. That origin must be on a *different registrable domain (site)* from the Feed. With that in place, the Feed's keys, storage and DOM can't be reached through the same-origin policy, whatever `sandbox` says.
- **Recommended baseline:**

  ```html
  <iframe
    src="https://{b32(txid)}.{slop-gateway}/{txid}/"
    sandbox="allow-scripts allow-same-origin"
    allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
    referrerpolicy="no-referrer"
    loading="lazy"></iframe>
  ```

  - Leave out every other token: no `allow-top-navigation*`, `allow-popups*`, `allow-modals`, `allow-forms`, `allow-downloads` or `allow-storage-access-by-user-activation`.
  - Grant no `payment`, `publickey-credentials-*`, camera, mic, geolocation or clipboard.
  - `allow-same-origin` is safe here **only because** the Slop origin is cross-site to the Feed (see §2). If that invariant can't be guaranteed, drop to `sandbox="allow-scripts"` (opaque origin).
- **Pulls are never triggered by the Slop.** A Pull is a Feed-owned gesture on Feed-owned chrome outside the iframe. The Slop→Feed `postMessage` contract is display-only: `ready`, `error`, and optionally `orientation`. None of these messages can move money.
- **Phishing inside the Slop's rectangle can't be fully prevented.** Mitigate it with structure. The Feed never asks for secrets or payment approval inside or overlapping the game area. Feed chrome is visually distinct and always on top. Operator takedown (the in-scope blocklist) covers the rest.
- **Arweave consequences.** Public gateways send **no CSP, no X-Frame-Options and no Permissions-Policy**, and `arweave.net` is **not on the Public Suffix List**. So we can't restrict a Slop's network access, and all Slops on one gateway are *same-site* with each other. The Feed must **not** be hosted on the same gateway domain. The platform should likely run its own ar.io gateway on a dedicated Slop-only domain (new ticket, see below).

## 1. What each `sandbox` token means for Slop

Source: [MDN `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [WHATWG HTML §iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox).

| Token | Slop needs it? | Why |
|---|---|---|
| `allow-scripts` | **Yes** | Slop is JS. |
| `allow-same-origin` | **Yes, conditionally** (§2) | Without it, the Slop runs in an opaque origin. `localStorage` then throws `SecurityError`: "The origin is not a valid scheme/host/port tuple" ([MDN localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)). Game engines persist through IndexedDB (Godot's `user://` [needs IndexedDB](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html)), so many exports would break at boot. |
| `allow-top-navigation`, `allow-top-navigation-by-user-activation`, `allow-top-navigation-to-custom-protocols` | **No** | These are the "navigate the top frame" threat. The `by-user-activation` variant still lets a Slop send the Player to a phishing page on a tap, and in a game every interaction is a tap. |
| `allow-popups`, `allow-popups-to-escape-sandbox` | **No** | A popup is a full unsandboxed top-level page. It's a phishing vector and can `window.opener`-style navigate. |
| `allow-modals` | **No** | `alert`/`confirm`/`prompt` render browser-chrome-looking dialogs, which are a phishing tool and can block the Feed's UI thread in some browsers. |
| `allow-forms` | No | Not needed for games. It only blocks native form submission; JS `fetch` is unaffected. Denying it removes an easy credential-harvest pattern and stops password-manager autofill on submit. |
| `allow-downloads` | No | Drive-by download vector. |
| `allow-storage-access-by-user-activation` | No | Would let a Slop ask for unpartitioned cookies. |
| `allow-pointer-lock`, `allow-presentation` | No | Desktop-only or irrelevant. |
| `allow-orientation-lock` | No | `screen.orientation.lock()` is not Baseline and "typically only enabled on mobile devices, and when the browser context is full screen" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock)), and iPhone element fullscreen is unreliable (§6). Orientation comes from Slop metadata (§5). |

## 2. `allow-same-origin`: when it's safe

The well-known warning, in the spec's words: "Setting both the `allow-scripts` and `allow-same-origin` keywords together **when the embedded page has the same origin** as the page containing the iframe allows the embedded page to simply remove the sandbox attribute and then reload itself" ([WHATWG](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)).

The escape needs the Slop to reach the parent's DOM, and that is only possible if Slop and Feed share an origin. When the Slop's real origin is a different host, `allow-same-origin` just means "keep your own real origin." The Slop gets its own storage, and the Feed stays unreachable. This is how CodePen works. It runs Pens with `allow-scripts allow-same-origin …` because previews are served from the separate domain `cdpn.io`: "using a different domain is a very important security aspect of CodePen… if CodePen executed code on codepen.io itself, that would essentially be one massive XSS vulnerability" ([CodePen: Changed Domains for Iframe Previews](https://blog.codepen.io/2019/10/03/changed-domains-for-iframe-previews/), [CodePen: iframe Security is So Strange](https://blog.codepen.io/2022/05/11/iframe-security-is-so-strange/)). The spec gives the same advice independently: "Potentially hostile files should not be served from the same server as the file containing the iframe element."

Other hosts:

- **itch.io** serves HTML5 games in an iframe from a separate CDN domain, `html-classic.itch.zone` ([itch.io HTML5 docs](https://itch.io/docs/creators/html5), [CDN domain change notice](https://itch.io/t/3099694/notice-for-html-game-devs-upcoming-change-to-cdn-domain)).
- **Figma** plugin UIs go further and use **null-origin** iframes: "any attempt to make a request to figma.com will be denied… the only way to communicate with the iframe is via message-passing" ([Figma: How to build a plugin system on the web](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)). Figma can afford that because plugin UIs are small forms, not engines that need IndexedDB.

**Invariants that make the recommended baseline safe:**

1. Each Slop origin ≠ the Feed origin. Better still, each Slop is on a different *site* (registrable domain) from the Feed.
2. Each Slop has its own origin, so Slops can't read each other's storage.
3. Nothing secret is ever stored on the Slop domain.

The ar.io sandbox subdomain gives us (2). Our hosting choice has to guarantee (1). If (1) ever fails, for example because the Feed is itself deployed to the same gateway as a Site (the `../rig` pattern), `allow-same-origin` becomes a full sandbox escape and we must fall back to `sandbox="allow-scripts"`.

## 3. How ar.io gateways isolate content (verified live)

Probes against `arweave.net` and `ar-io.dev` on 2026-09-24:

- `GET https://arweave.net/{txid}/` → `302` to `https://{sandbox}.arweave.net/{txid}/`. `ar-io.dev` behaves the same.
- `{sandbox}` is the **lowercase unpadded base32 of the 32-byte tx id**, 52 chars. For example, tx `bNbA3TEQ…Dt_U` → `ntlmbxjrcbkl5ngglabhfj3t4gj4ofm66xk4m54gneurvw2dw72q`. We recomputed this locally and it matched the redirect. So the Feed can compute the final origin and **frame the sandbox URL directly**, skipping the redirect.
- A request for tx B on tx A's sandbox host → `302` to tx B's own sandbox host. The gateway keeps one origin per tx. A Slop's manifest paths all live under its manifest tx's origin.
- ar.io's own docs say the redirect exists for "Security Isolation – Content is served from isolated sandbox environments" and tell clients to "always follow redirects" ([ar.io: Fetch Data](https://docs.ar.io/build/access/fetch-data)). The original design rationale is that storage and cookies are bound to the per-tx sandbox, so a malicious tx can't reach an app's storage ([Arweave gateway sandboxes design note](https://hackmd.io/@arweave-kyle/rJRU5VsDI)). That note describes an older 12-char hashed scheme; today's gateways use the full base32 id, as observed above.
- The sandbox responses carried **no `Content-Security-Policy`, no `X-Frame-Options`, no `Permissions-Policy`, and no COOP/COEP**. They did carry `Access-Control-Allow-Origin: *`.
- `https://arweave.net/raw/{txid}` returned `200 text/html` **without** redirecting to a sandbox. **Never frame `/raw/` URLs.** They put every Slop on the bare gateway origin, where they would all share one origin.
- `arweave.net` and `ar-io.dev` are **not** on the [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat) (checked 2026-09-24). CodePen, by contrast, registered `codepen.app` and `codepen.dev` there. So every sandbox subdomain of a gateway is the same *site*. With `allow-same-origin`, a Slop can set `Domain=arweave.net` cookies that other Slops, or any Arweave app on that gateway, receive ("cookie tossing"). Browser process isolation (site isolation) also groups them together. This is low impact for Slop, which holds no secrets, but it's the reason the Feed must not live on the gateway domain.

**What this means for the Feed:**

- Per-Slop origins come free from the gateway, which covers threat 4 (cross-reading other Slop) for storage.
- Because public gateways set no CSP, **we can't limit a Slop's network access or remote code loading.** A Slop can `fetch`/`import()` anything at runtime. So the reviewed bundle and the size cap aren't enforcement boundaries, and a Slop can change behaviour after publishing. CSP Embedded Enforcement (`<iframe csp=…>`) would let the parent impose a policy, but it is experimental, not Baseline, and needs the server to opt in ([MDN `HTMLIFrameElement.csp`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/csp)). It's not an option.
- If the platform **runs its own ar.io gateway** (or a thin proxy in front of one) on a dedicated domain such as `slop-usercontent.example`, we gain several things:
  - headers under our control: a CSP `sandbox` directive as defence in depth even if the page is opened top-level ([MDN CSP `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)), `frame-ancestors` limited to the Feed, and a `Permissions-Policy` header;
  - enforcement of the operator takedown blocklist at the serving edge;
  - the option to register the domain on the PSL.

## 4. Threat-by-threat

| Threat | Stopped by | Residual risk |
|---|---|---|
| **Reach Player's payer/keys** | The Slop is cross-origin to the Feed, so the same-origin policy blocks its DOM, storage, IndexedDB and cookies. Keys live only in the Feed origin. The Feed's `message` handler checks `event.source === iframe.contentWindow` and never answers a request with secrets. | Keys held on the same *site* as Slops, which is why the Feed must not be on the gateway domain. Spectre-class leaks if Feed and Slop share a renderer process: keep them on different sites so site isolation separates them. |
| **Trigger Pulls or payments** | The Pull gesture happens on Feed chrome outside the iframe (see §5). No message type in the Slop→Feed contract causes a Pull or payment. `allow` grants no `payment`, and the Permissions-Policy default for `payment` is `self` ([MDN Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy)). The payer (connector) is Feed-side only. | A Slop that *looks* like a "tap to pull" button is only a UI trick. It can't cause an actual Pull. |
| **Navigate the top frame** | No `allow-top-navigation*` and no `allow-popups*`. | The Slop can still navigate *its own* frame anywhere, e.g. to a phishing page, inside its rectangle. That falls under phishing, below. |
| **Cross-read other Slop** | Per-tx origin from the gateway. Only one live Slop iframe at a time, with the previous one destroyed on Pull, so there's nothing to `postMessage` between. | Cookie tossing across Slops on a non-PSL gateway domain (§3). The Slop and the Feed both keep hold of nothing sensitive there. |
| **Phishing** | No modals, popups, top navigation, forms or downloads. Feed chrome is visually distinct and never overlapped by the iframe. The Feed never collects secrets or payment approval anywhere a Slop could imitate. Operator blocklist. | A Slop can draw a fake "enter your seed phrase" screen in its own area. This can't be prevented technically. The UX rule is that the Feed never asks for secrets at all during play, and onboarding happens before the first Slop is shown. |
| **Framing the Feed (clickjacking)** | Feed sends `Content-Security-Policy: frame-ancestors 'none'` so no Slop can embed the Feed and trick taps into a Pull. | None. |
| **Resource abuse** (crypto mining, memory bombs) | Lazy-load, and destroy the previous iframe on Pull. Consider a Feed-side watchdog that unloads a Slop if `ready` doesn't arrive in N seconds. | Can't be capped from the browser. Relevant to the Pull UX edge cases (refunds on failed load). |

## 5. The Feed ↔ Slop `postMessage` contract

MDN's rules ([postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)): always check the sender, validate message syntax, and "always specify an exact target origin, not `*`". Messages from an opaque-origin frame arrive with `event.origin === "null"`. With the recommended baseline the Slop keeps its real sandbox origin, so the Feed can check it exactly.

**Feed side:**

- Accept a message only if `event.source === currentIframe.contentWindow` **and** `event.origin === expectedSandboxOrigin`, where the expected origin is computed from the tx id.
- Parse against a strict schema and drop everything else.
- Send with `targetOrigin = expectedSandboxOrigin`.

**Slop → Feed (display-only, never money):**

- `{"type":"slop:ready"}`: the Slop has loaded. The Feed hides the spinner and starts any "failed to load" timer logic.
- `{"type":"slop:error","message":string}`: optional. Feeds the refund/skip policy (open question on map).
- *(No orientation message needed if orientation is declared in Slop metadata.)* Static metadata is better. The Feed can lay out before load, and the Slop can't change its layout mid-play to cover Feed chrome.

**Feed → Slop:**

- `{"type":"feed:pause"}` / `{"type":"feed:resume"}` when the Slop is swiped off or on screen, or the tab is hidden.
- Optionally `{"type":"feed:mute"}`.

**What the contract must *not* contain:** anything that causes a Pull, a payment, navigation, or access to Player identity, balance or keys. Any Slop→Feed message must be safe to receive in a loop from a hostile Slop.

**Pull gesture vs game input:** a Slop consumes its own touches, and touch events inside a cross-origin iframe don't reach the parent. The Pull gesture therefore needs a Feed-owned hit area outside the iframe, such as a swipe rail or lever. This is a UX constraint the Pull UX ticket should pick up, and it's also a security property: the Slop can't synthesise or intercept the Pull.

## 6. iOS Safari / mobile-first constraints

- **Fullscreen API:** iOS Safari support is partial ([caniuse: Fullscreen](https://caniuse.com/fullscreen)). Element fullscreen on iPhone has a history of being video-only or buggy ([Apple Developer Forums thread](https://developer.apple.com/forums/thread/133248)). Don't rely on a Slop going fullscreen. The Feed (installed as a PWA, standalone) owns the viewport and gives the iframe the full play area. `allow="fullscreen"` is harmless to grant.
- **Third-party storage is partitioned and ephemeral in Safari.** "Third-party LocalStorage and IndexedDB are partitioned per first-party website and also made ephemeral", and script-writable storage is purged after 7 days without interaction ([WebKit Tracking Prevention](https://webkit.org/tracking-prevention/)). So even with `allow-same-origin`, **Slop save data won't reliably persist on iOS.** `allow-same-origin` is about *compatibility* (engines don't crash on storage access), not persistence. If persistent Slop saves matter, a Feed-mediated save API is needed (new question).
- **Orientation lock** needs fullscreen and isn't Baseline ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock)), so it's not dependable on iPhone. Orientation comes from Slop metadata, and the Feed shows a "rotate your device" hint.
- **Threads / SharedArrayBuffer:** Godot and Unity threaded web exports need COOP/COEP cross-origin isolation ([Godot web export docs](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html)). Public gateways don't send those headers, and isolation would also require the Feed itself to be cross-origin isolated. **MVP: Slop must be single-threaded.** Put this in Creator publishing guidance and the `slop publish` checks.
- **Audio/autoplay:** Web Audio has to be unlocked by a user gesture. A tap inside the iframe counts for that iframe. Grant `autoplay` in `allow`, and expect Slops to start audio on first tap.

## 7. Recommended baseline, as one checklist

1. **Hosting:**
   - Frame `https://{base32(txid)}.{slop-gateway}/{txid}/` directly.
   - Never frame `/raw/` or bare-gateway URLs.
   - The Feed is on its own registrable domain, **never** the Slop gateway's domain.
2. **iframe:**
   - `sandbox="allow-scripts allow-same-origin"`
   - `allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"`
   - `referrerpolicy="no-referrer"`
   - one live Slop iframe at a time, destroyed on Pull.
3. **Feed headers:**
   - `Content-Security-Policy: frame-ancestors 'none'` plus a strict `frame-src` limited to the Slop gateway domain
   - `Permissions-Policy` denying `payment`, `publickey-credentials-*`, `camera`, `microphone`, `geolocation` to all but `self`.
4. **Messaging:** the §5 contract. Source and origin are checked. It's display-only, and nothing in it touches money or identity.
5. **Pull:** only via Feed-owned chrome outside the iframe.
6. **Phishing:** the Feed never asks for secrets or approvals during play. The operator blocklist is checked before a Slop is framed.
7. **Fallback:** if invariant (1) can't hold, use `sandbox="allow-scripts"` and accept that storage-dependent engines break.

## Newly surfaced questions

- **Do we run our own ar.io gateway on a dedicated Slop domain?** This gives us control of CSP `sandbox`/`frame-ancestors`/`Permissions-Policy`, blocklist enforcement at the edge, PSL registration, and freedom from third-party gateway uptime. It overlaps with "Service decomposition".
- **Where is the Feed hosted?** If it follows the `../rig` Site pattern (Arweave-hosted), it must not be on the same gateway domain as Slop, because that breaks invariant (1).
- **Pull gesture vs in-game touch.** Touches inside the iframe never reach the Feed, so the Pull needs a dedicated Feed-owned hit area. This affects Pull UX.
- **Persistent Slop saves.** iOS makes third-party iframe storage ephemeral. Is a Feed-mediated save API worth it, or are Slops session-only? (Could be a nice-to-have or out of scope.)
- **Runtime remote code.** Without CSP, a Slop can fetch new code after publishing, so pre-publish review or size caps can't bind behaviour. Is operator takedown enough for MVP?
- **Creator constraints to enforce in `slop publish`:** single-threaded exports (no SharedArrayBuffer), must post `slop:ready`, and must declare orientation in metadata.
