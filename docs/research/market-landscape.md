# Market landscape: does Slop Machine already exist?

Research note, compiled 2026-09-24. **All links were accessed 2026-09-24.**

Source-quality tags used throughout:

- **[P]** is a primary source: the company's own site, blog, docs or app-store listing, a regulator or court, a founder's own post, or an academic paper.
- **[S]** is a secondary source, such as trade press or a tracker. It is lower confidence and is used only where no primary source could be found or fetched.
- **Opinion** marks my own analysis. It appears only in the "Assessment" blocks and in §6.

Domain terms (Slop, Pull, Creator, Player, Feed) are defined in [`CONTEXT.md`](../../CONTEXT.md).

---

## Executive summary

1. **The feed format is already crowded.** In 2025–26 at least seven products shipped a TikTok-style vertical feed of small, often AI-generated, playable web games:
   - Remix (formerly Farcade)
   - Meta's Pocket (built from the Gizmo acqui-hire)
   - Playabl.ai (YC P26)
   - Aippy (US$250M valuation)
   - Riffle
   - TapHop
   - Flikk

   YouTube (Playables Builder) and TikTok (Mini Games) are adding creator-made or AI-made games inside their own apps. Playbyte tried the same idea in 2021 with a non-AI editor. It raised $4M and has since moved on to other products.
2. **Nobody we found charges the Player per swipe.** Every analog is free to scroll. They make money from ads, IAP, subscriptions or creation credits, or from creator "boosts", tips and prize jams. **The paid Pull is Slop Machine's one real point of difference.** It is also the part with the least support in the evidence.
3. **The history of micropayments argues against per-action fees for content.** Szabo (1999) and Odlyzko (2003) found that mental transaction costs outweigh technical costs, and that flat-rate pricing raises usage by 50–200%. The track record matches:
   - Blendle dropped pay-per-article after its micropayment user base stayed "very limited".
   - Coil shut down in 2023.
   - Flattr closed in 2023.
   - x402, the newest rail, handles about $0.20 payments but is mostly machine-to-machine. Artemis estimates about half of its activity is "gamed".
4. **Creators earn little in all but the biggest ecosystems.**
   - Roblox paid $1.5B in 2025, but the median DevEx creator earned about $1,500 a year.
   - Fortnite has paid over $1B since 2023, from a pool of 40% of net revenue.
   - Poki's top studios earn $50k–$1M a year on a 50/50 ad split.
   - Remix, the closest crypto-native analog, shows $123k *total* paid to creators across 140k games.
5. **Supply is cheap and plentiful. Quality and discovery are the bottleneck.**
   - Aippy reports more than 2M games created.
   - Remix lists more than 140k live games.
   - Levels' 2025 vibe jam drew more than 1,000 entries, mostly from first-time developers.
   - Of new Steam releases, about 20–30% disclose AI use ([S]).
   - itch.io now makes AI disclosure mandatory for assets.
6. **Regulatory exposure is real but can be managed if a Pull cannot win anything of monetary value.**
   - The UK Gambling Commission requires "money or money's worth" as a prize.
   - Belgium reads "a win of any kind" broadly. Value the player attaches is enough, even if it is purely cosmetic.
   - Australia rates *simulated gambling* R18+.
   - The EU (Feb 2026) preliminarily found TikTok's infinite scroll and reward loop to be addictive design in breach of the DSA.
   - Epic banned paid "prize wheel spins" in Fortnite islands within days of creators selling them.

   Marketing a paid, random-outcome swipe as a slot machine lever walks straight into all of these.
7. **App stores push the product toward the web.** Apple 3.1.1 bars using crypto to unlock in-app content. Digital content must go through IAP, apart from US-storefront link-outs, and 4.7 makes the host app responsible for every mini game. Google Play requires Play Billing for digital content. **The PWA/web route the prototype already uses is the right default.**

**Bottom line (opinion).** "TikTok for vibe-coded games" is proven demand, but it is a commodity now, with Meta, YouTube and TikTok in it. Slop Machine's defensible difference is the **payment rail**: instant USDC splits that let even tiny Creators earn per play. The **"slot machine" framing** is its biggest liability, both for how many users will convert and for regulatory risk. The data favours reframing the Pull as a *play ticket or tip* over a *lever*. It also favours testing prepaid bundles, such as "N pulls for $X", against a charge on every swipe.

---

## 1. Direct and near analogs

### 1a. Comparison table: closest analogs

| Product | Format | Who makes content | Player pays? | Creator gets paid how | Status (2026-09) | Source |
|---|---|---|---|---|---|---|
| **Remix** (ex-Farcade, Farworld Labs) | Swipe feed of instant-play web games; app + Telegram / Farcaster / World App / Base mini-app | Vibe coders via built-in AI; forkable games | Free to play; "Bits" currency spent on Boosts; Pro $15/mo, Max $100/mo creation plans | Boosts ("creators keep most of it"), weekly rewards, sponsored jams. **$123,339 total rewards** shown on site | Live. $5M seed (Jul 2025), 1.5M+ players, 52M+ plays, 140k+ games | [P] [remix.gg](https://remix.gg/), [blog](https://remix.gg/blog), [Archetype](https://www.archetype.fund/media/announcing-our-lead-investment-in-remix), [App Store](https://apps.apple.com/us/app/remix-tiktok-for-games/id6748889050) |
| **Meta Pocket** (from Gizmo / Atma Sciences) | TikTok-style feed of prompt-made "gizmos"; remix / repost | Anyone via AI prompt | Free; no monetization reported | None reported | Live in US since Aug 2026; not formally announced by Meta. Gizmo app shut down | [S] [TechCrunch 2026-08-20](https://techcrunch.com/2026/08/20/meta-brings-pocket-an-app-that-lets-you-vibe-code-and-share-games-to-us-users/) |
| **Gizmo** (Atma Sciences) | Vertical feed of vibe-coded interactive mini apps | Anyone via AI prompt | Free | None reported | About 600k installs (Appfigures); team acqui-hired by Meta in Mar 2026, app wound down | [S] [TechCrunch 2026-02-04](https://techcrunch.com/2026/02/04/meet-gizmo-a-tiktok-for-interactive-vibe-coded-mini-apps/) |
| **Playabl.ai** (YC P26) | "TikTok-style feed where every scroll is a game you can instantly play, remix, and republish" | Anyone via AI; structured component engine | Free | "Monetize" claimed; mechanism not disclosed | Live. 1M plays / 3k games in first 5 days | [P] [YC Launch](https://www.ycombinator.com/launches/QeI-playabl-ai-tiktok-for-user-generated-games) |
| **Aippy** (NADA AI, HK) | "AI-native game community" | Users via AI | Free (app) | Not disclosed | Live. >3M downloads, ~2M MAU, >2M games created; raised "tens of millions" at $250M post (Jun 2026) | [P] [PR Newswire](https://www.prnewswire.com/apac/news-releases/aippy-raises-tens-of-millions-of-dollars-at-a-250-million-valuation-to-build-the-future-of-ai-native-interactive-entertainment-302787864.html) |
| **Riffle** (Rochelimit Interactive) | "Like TikTok, but every post is interactive"; browser-playable share links | Users via AI prompt | Free | None disclosed | Live (iOS, Jan 2026); 193 ratings | [P] [App Store](https://apps.apple.com/us/app/-/id6757701493) |
| **TapHop** (Linkadoo) | "Endless feed of bite-sized games"; auto-play on arrival | Users via AI | IAP credits $1.99–$34.99; Pro $2.99–4.99 | Not disclosed | Live, tiny (7 ratings). Reviews call visuals "comically terrible" | [P] [App Store](https://apps.apple.com/us/app/taphop-ai-game-maker-play/id6751584497) |
| **YouTube Playables (+ Builder)** | Web games inside YouTube; Gemini 3 builder for creators | Studios; since Dec 2025 approved creators via AI (US/CA/GB/AU closed beta) | Free | Not public | Live; early access | [P] [Google dev docs](https://developers.google.com/youtube/gaming/playables), [P] [@YouTubeGaming](https://x.com/YouTubeGaming/status/2000989303086649637) |
| **TikTok Mini Games** | Instant-play games launched from within TikTok | Studios (Cocos / Unity etc.) | Free; IAP via TikTok payments | Ads (rewarded / interstitial) + IAP | Live in US, JP, ID, TR, SA, TH, BR, MY, PH, VN | [P] [TikTok for Developers](https://developers.tiktok.com/docs/en/mini-games-overview), [P] [Newsroom 2026-06-18](https://newsroom.tiktok.com/tiktok-unveils-native-experiences-and-creative-ai-to-power-app-growth-in-southeast-asia?lang=en-SG) |
| **Playbyte** (2021) | "TikTok for games": vertical feed of microgames made in a mobile editor | Users (block / emoji editor, pre-AI) | Free | Planned ads, then patronage / NFTs | App era over; company moved on to Godot tools and other products | [S] [TechCrunch 2021-09-03](https://techcrunch.com/2021/09/03/playbytes-new-app-aims-to-become-the-tiktok-for-games/) |

### 1b. Portals and platforms: context and payout benchmarks

- **Poki** [P]
  - Scale: "over 100 million monthly active players" ([developer guide](https://developers.poki.com/guide/working-with-poki)) and 1B plays a month, reached June 2025 ([Poki blog](https://poki.com/blog/poki-wins-dutch-game-awards-2025)).
  - Revenue share: 50/50 on Poki-sourced traffic and 100% to the developer on traffic the developer brings. Poki requires web exclusivity.
  - Developer earnings: 600+ developers, with the top ones earning $50k–$1M a year.
- **CrazyGames** [P]
  - Scale: "over 50 million monthly players" ([FAQ](https://docs.crazygames.com/faq/)).
  - Revenue share and payouts: developers get a share of ad and IAP revenue, paid monthly once the balance passes €100. There is no exclusivity requirement.
  - The FAQ does not give an exact split. A 60% ad / 70% IAP figure comes from jam terms ([S] [Cinevva](https://app.cinevva.com/guides/publish-game-crazygames)).
- **GamePix** [P]: developers get 45% of ad revenue ([partners page](https://partners.gamepix.com/developers)).
- **Gamezop** [P]: B2B HTML5 publisher claiming 45M monthly users across 9,000+ integrations ([about](https://business.gamezop.com/about-us)).
- **itch.io** [P]
  - Uses "open revenue sharing": the seller chooses itch's cut from 0–100%, with a default of 10%.
  - Card and PayPal fees are $0.30 + 2.9%. itch's docs point out that "30 cents represents 30% of a $1 sale" and recommend a $2 minimum price ([docs](https://itch.io/docs/creators/payments)). This is the fee problem a USDC rail is meant to solve.
- **Facebook Instant Games** [P]: Meta is shrinking the program.
  - Legacy Web Games "will cease operating on Facebook after September 30, 2026". Instant Games must migrate to "Zero Permissions" ([Meta dev blog, 2025-07-31](https://developers.facebook.com/blog/post/2025/07/31/web-and-instant-games-changes/)).
  - Meta shut the standalone Facebook Gaming app in Oct 2022 ([S] [TechCrunch](https://techcrunch.com/2022/08/30/meta-shutting-down-facebook-gaming-app)). That app had earlier been rejected repeatedly by Apple under guideline 4.7 for being mainly a casual-game distributor ([S] [9to5Mac](https://9to5mac.com/2020/08/07/facebook-ios-gaming-app/)).
- **Snap Games / Minis**: discontinued. Spiegel's memo: "We have made the decision to discontinue our investments in Snap Originals, Minis, Games, and Pixy" ([P] [Snap Newsroom, 2022-08-31](https://newsroom.snap.com/restructuring-and-refocusing-our-business)).
- **Telegram mini-app games**
  - Telegram has passed 1B MAU ([P] [Durov](https://x.com/durov/status/1902454590747902091)).
  - Game activity rose and fell with tap-to-earn crypto games. Hamster Kombat reportedly fell from about 300M users to 41M MAU by Nov 2024 ([S] [CoinMarketCap](https://coinmarketcap.com/academy/article/hamster-kombat-faces-dramatic-user-decline-as-paws-mini-app-gains-traction)). Mini-app reach was estimated at a 1.44B peak in Sep 2024, then about 150–190M by mid-2025 ([S] [VoxBooster](https://voxbooster.com/blog/telegram-statistics-2026/)).
  - We found no first-party Telegram numbers for game MAU.
- **Farcaster mini apps / Frames**
  - Verified mini apps earned weekly "Developer Rewards" based on usage and onchain transactions ([P] [Farcaster docs](https://miniapps.farcaster.xyz/docs/guides/publishing)).
  - Farcaster itself failed to grow. On 2026-01-21 Neynar took over the protocol and app ([P] [Dan Romero](https://x.com/dwr/status/2014045233189888483)). Romero said Farcaster "needs a new approach and leadership" after five years, and CoinDesk reported the social-first model had not reached sustainable growth ([S] [CoinDesk](https://www.coindesk.com/business/2026/01/21/farcaster-founders-step-back-as-neynar-acquires-struggling-crypto-social-app)).
  - Remix started as a Farcaster game hub ("Farcade") and moved to native apps, a sign that crypto-social alone was not enough distribution.
- **Websim** (AI-simulated websites and games, $11M raised [S] [Crunchbase](https://www.crunchbase.com/organization/websim-5262))
  - On 2026-01-12 it discontinued "the creator program, video rewards, and free daily credits" ([P] [Websim blog](https://websim.com/blog/update-on-daily-credits)).
  - Community posts claim it is shutting down, but the official blog was still posting in Aug 2026, so **not confirmed as shut down**.
- **Rosebud AI**: AI game studio, $9.2M raised ([S] [Crunchbase](https://www.crunchbase.com/organization/rosebud-ai)). It lets creators add a Stripe "Tip Jar" to games ([P] [Rosebud blog](https://lab.rosebud.ai/blog/rosebud-ai-vs-competitors-the-only-fully-integrated-ai-game-creation-platform)).

### 1c. What died, and why

| Product | Died / pivoted | Stated or evident reason |
|---|---|---|
| Snap Games & Minis | Aug 2022 | Not core to "community growth, revenue growth, and augmented reality"; cost cuts ([P](https://newsroom.snap.com/restructuring-and-refocusing-our-business)) |
| Facebook Gaming app | Oct 2022 | Limited success; Apple 4.7 had forced gameplay out of the iOS app ([S](https://techcrunch.com/2022/08/30/meta-shutting-down-facebook-gaming-app)) |
| FB Web Games (legacy) | 2026-09-30 | 2007-era tech; Meta consolidating onto Instant Games ([P](https://developers.facebook.com/blog/post/2025/07/31/web-and-instant-games-changes/)) |
| Playbyte feed app | ~2022–23 | Company pivoted to dev tools; no public post-mortem found ([S](https://techcrunch.com/2021/09/03/playbytes-new-app-aims-to-become-the-tiktok-for-games/)) |
| Gizmo | 2026 | Acqui-hired into Meta; product reborn as Pocket ([S](https://techcrunch.com/2026/08/20/meta-brings-pocket-an-app-that-lets-you-vibe-code-and-share-games-to-us-users/)) |
| Farcaster (as independent co.) | Jan 2026 | Social-first model didn't reach sustainable growth ([S](https://www.coindesk.com/business/2026/01/21/farcaster-founders-step-back-as-neynar-acquires-struggling-crypto-social-app)) |
| Telegram tap-to-earn wave | 2024–25 decline | Retention collapsed after token launches ([S](https://coinmarketcap.com/academy/article/hamster-kombat-faces-dramatic-user-decline-as-paws-mini-app-gains-traction)) |

> **Assessment (opinion).** Standalone "game feed" apps from big platforms keep getting cut (Snap, Facebook Gaming). Distribution-owning giants now absorb the category into their main apps: TikTok Mini Games, YouTube Playables, Meta Pocket. Independent players survive by owning a niche: Poki with web portals and SEO, Remix with crypto-native jams and brands. When a startup exits, it is to an acqui-hirer (Gizmo). The format itself is not a moat.

---

## 2. Pay-per-action / micropayments: evidence

### Theory (primary, academic)

- **Szabo (1999)**: "Customer mental transaction costs will soon dominate the technological transaction costs of the payment system". He recommends bundling and flat fees to reduce "mental accounting costs" ([P] [Nakamoto Institute](https://nakamotoinstitute.org/library/micropayments-and-mental-transaction-costs/)).
- **Odlyzko (2003)**: "consumers are willing to pay more for flat-rate plans than for metered ones". Also: "switching from metered to flat-rate pricing increases usage by 50 to 200 percent". AOL's move to unlimited plans tripled time online ([P] [The Case Against Micropayments, PDF](https://www-users.cse.umn.edu/~odlyzko/doc/case.against.micropayments.pdf)).

### Real-world attempts

| Attempt | Model | Outcome | Source |
|---|---|---|---|
| **Blendle** | Pay-per-article news | Dutch micropayments dropped in 2019; DE/US closed in 2023 because the micropayment user base was "very limited compared to the size of the overall Cafeyn / Blendle base" | [S] [journalism.co.uk, 2023-08-09](https://www.journalism.co.uk/blendle-shuts-down-micropayment-model-due-to-very-limited-user-base/); [S] [Nieman Lab 2019](https://www.niemanlab.org/2019/06/micropayments-for-news-pioneer-blendle-is-pivoting-from-micropayments/) |
| **Coil / Web Monetization** | $5/mo membership streamed to sites | Signups stopped 2023-02-02; service ended 2023-03-15; standard handed to the Interledger Foundation | [P] [coil.com open letter](https://coil.com/) |
| **Flattr** | Monthly micro-donation split | Closed 2023 | [S] [Wikipedia](https://en.wikipedia.org/wiki/Flattr) (primary notice not retrievable) |
| **Brave Rewards / BAT** | Ad-view rewards → creator tips | Ended unverified "virtual BAT" in 2023, citing fraud ("bad actors … across a large number of profiles") and accounting problems; custodial KYC now required to earn | [P] [Brave blog, 2023-01-13](https://brave.com/blog/rewards-changes/) |
| **Stacker News** | Pay sats per post / comment; zaps split 70% creator / 21% territory / 9% rewards | Running; a working small-scale example of per-action fees used as anti-spam and reward | [P] [SN FAQ](https://stacker.news/faq) |
| **Fountain (V4V podcasts)** | Streaming sats per minute + "boosts" | Running; niche Bitcoin audience | [P] [Fountain blog](https://blog.fountain.fm/p/value-for-value-how-to-build-unbreakable) |
| **x402** (Coinbase / Cloudflare; Linux Foundation) | HTTP 402 + USDC per request | Coinbase and partners cite 200M+ transactions and about $50M+ cumulative volume. Artemis (Mar 2026): about 131k tx/day, about $28k/day, **avg about $0.20**, and about 50% of activity "gamed" (wash / self-dealing). Use is mainly agents and APIs, not people | [S] [CoinDesk 2026-03-11](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet); [P] [Coinbase x402 Foundation](https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation) |
| **Warpcast / Farcaster rewards** | Platform-funded weekly USDC to creators and devs | Paid out; ecosystem later stalled (see §1) | [P] [Farcaster docs](https://miniapps.farcaster.xyz/docs/guides/publishing) |
| **Remix Boosts / Bits** | Players spend Bits to boost games; creators keep most | $123k total creator rewards to date. The breakdown between Boosts and jam prize pools is not disclosed | [P] [remix.gg](https://remix.gg/) |

**Is there prior art for charging per swipe?** We found **no** consumer feed, game or otherwise, that charges the viewer per swipe. The nearest cases are pay-per-article (Blendle, which failed) and per-post anti-spam fees (Stacker News, niche).

> **Assessment (opinion).** The evidence strongly suggests that a *visible* charge on every swipe will cut both sessions and conversion. Crypto rails have removed the technical cost barrier: itch.io's $0.30 floor becomes sub-cent. They do nothing about Szabo's mental cost. The products where users do accept per-action fees have one of two traits. Either the fee buys a *status or signal* (zaps, boosts, Stacker News), or it is spent from a *prepaid balance* the user no longer thinks of as money (arcade tokens, Telegram Stars, Robux, Bits). The second pattern also shifts the Pull toward the "virtual currency" pattern regulators watch; see §5.

---

## 3. Creator economics: real payout figures

| Platform | Mechanism | Figures | Source |
|---|---|---|---|
| **Roblox** | DevEx cash-out of earned Robux; rate raised $0.0035 → **$0.0038/Robux** for Robux earned after 2025-09-05 | Creators earned **$1.5B in 2025** ($923M in 2024). **42,000+** DevEx creators; **median about $1,500** (12 mo to 2026-06-30). Top 10 averaged $33.9M in 2024; top 1,000 averaged $820k | [P] [Roblox 2026-09](https://about.roblox.com/newsroom/2026/09/global-impact-of-creation-on-roblox), [P] [Roblox 2025-09](https://about.roblox.com/newsroom/2025/09/roblox-annual-economic-impact-report), [P] [DevEx docs](https://create.roblox.com/docs/production/monetization/developer-exchange) |
| **Fortnite (UEFN)** | Engagement pool = **40%** of eligible net Item Shop / real-money revenue; plus in-island sales (from Jan 2026) at 100% of V-Bucks value until 2027-01-31, then 50% | More than **$1B** paid since 2023 (State of Unreal, June 2026); islands = 47% of playtime | [P] [Epic docs](https://dev.epicgames.com/documentation/en-us/fortnite/engagement-payout-in-fortnite-creative); [S] [Tubefilter 2026-06-17](https://www.tubefilter.com/2026/06/17/epic-games-unreal-editor-for-fortnite-creator-payouts/); [S] [PocketGamer.biz](https://www.pocketgamer.biz/epic-games-pushes-in-island-transaction-publishing-for-fortnite-creators-to-january-2026/) |
| **Poki** | 50/50 on Poki traffic; 100% on developer-sourced traffic | Top devs $50k–$1M a year; 600+ devs | [P] [Poki docs](https://developers.poki.com/guide/working-with-poki), [P] [Poki blog](https://poki.com/blog/poki-wins-dutch-game-awards-2025) |
| **CrazyGames** | Ad + IAP rev share; €100 payout threshold | Split not in FAQ (jam terms 60% ads / 70% IAP [S]) | [P] [FAQ](https://docs.crazygames.com/faq/) |
| **GamePix** | 45% of ad revenue to the developer | n/a | [P] [GamePix](https://partners.gamepix.com/developers) |
| **itch.io** | Seller sets itch's cut (default 10%) | Processor fee $0.30 + 2.9% dominates small sales | [P] [itch docs](https://itch.io/docs/creators/payments) |
| **Telegram Stars** | Stars required for digital goods in mini apps (Apple / Google compliant); withdrawn as TON via Fragment | Rates exposed via `stars_usd_withdraw_rate_x1000` config; 21-day hold and 1,000-Star minimum reported [S] | [P] [Telegram blog 2024-06-06](https://telegram.org/blog/telegram-stars), [P] [core.telegram.org](https://core.telegram.org/api/stars) |
| **TikTok Mini Games** | Rewarded / interstitial ads + IAP | No public payout totals | [P] [TikTok for Developers](https://developers.tiktok.com/docs/en/mini-games-overview) |
| **Remix** | Boosts / Bits, jams, weekly rewards | **$123,339 total** rewards; top creator $10,038 | [P] [remix.gg](https://remix.gg/) |
| **fly.pieter.com** (single vibe-coded game) | In-game sponsorships | "$1M ARR in just 17 days" after the 2025-02-22 launch | [P] [levels.io](https://levels.io/fly-pieter-com-vibecoded-flight-simulator) |

> **Assessment (opinion).** Creator income follows a power law everywhere. Roblox's *median* DevEx creator makes about $1,500 a year while the top 10 average $34M. For Slop Machine, the realistic Creator pitch is not "earn a living". It is "every play pays you something, instantly, from the first Pull". None of the AI-feed competitors (Pocket, Playabl, Aippy, Riffle) publish any per-play creator payout. Remix's $123k in total, spread across 140k games, shows how thin incentive-funded payouts are. **Automatic, transparent per-Pull earnings are a real point of difference**, if the Pull volume exists.

---

## 4. Supply side: AI / vibe-coded game creation

- **Volume**
  - Aippy: >2M games created, with daily publishing up "tenfold since year start" ([P](https://www.prnewswire.com/apac/news-releases/aippy-raises-tens-of-millions-of-dollars-at-a-250-million-valuation-to-build-the-future-of-ai-native-interactive-entertainment-302787864.html)).
  - Remix: 140k+ live games ([P](https://remix.gg/)).
  - Playabl: 15k games within weeks of launch ([P](https://www.ycombinator.com/launches/QeI-playabl-ai-tiktok-for-user-generated-games), traction per [S] [Founderland](https://www.founderland.ai/articles/playablais-ai-game-builder-hits-100k-users-with-tiktok-style-mpwgqhb1)).
- **Newcomers**: Levels' 2025 Vibe Coding Game Jam drew "over 1,000+ games", and "the vast majority of people participating never made a game before" ([P] [levels.io](https://levels.io/winners-of-the-2025-vibe-code-game-jam)).
- **Platform tooling**
  - YouTube Playables Builder uses Gemini 3 and is in closed beta for creators ([P] [@YouTubeGaming](https://x.com/YouTubeGaming/status/2000989303086649637)).
  - Meta Pocket ([S](https://techcrunch.com/2026/08/20/meta-brings-pocket-an-app-that-lets-you-vibe-code-and-share-games-to-us-users/)).
  - Remix supports "Claude Code and other agents" ([P](https://remix.gg/)).
- **Quality and trust**
  - itch.io made generative-AI disclosure mandatory for asset creators. Untagged AI assets are no longer indexed on browse pages (leafo, 2024-11-20; [P] [itch.io forum](https://itch.io/t/4309690/generative-ai-disclosure-tagging)).
  - Steam AI disclosures: about 22% of 2025 releases and about 31% of 2026 releases so far ([S] [Cinevva](https://app.cinevva.com/news/2026-07-20-steam-ai-disclosure-study), [S] [Pikorafy](https://pikorafy.com/blog/steam-ai-games-disclosure-surge-2026)). Lower confidence, since these are third-party scrapes.
  - A TapHop reviewer called the AI games' visuals "comically terrible" ([P] [App Store](https://apps.apple.com/us/app/taphop-ai-game-maker-play/id6751584497)).
- **Cost pressure on free creation**: Websim ended free daily credits and its creator program in Jan 2026 ([P](https://websim.com/blog/update-on-daily-credits)). Remix charges $15–$100/mo for creation ([P](https://remix.gg/)).

> **Assessment (opinion).** Supply is not the constraint. **Curation is.** When 2M games exist, a *paid* Pull makes a bad landing actively painful, where a free swipe is merely skipped. Recommendation quality, and possibly Creator stakes or reputation, matter more for Slop Machine than for free-scroll competitors.

---

## 5. Regulatory and risk angle

### 5a. Gambling / loot-box law

The three classic elements are **consideration** (the Pull fee), **chance** (which Slop you land on), and **prize**. Most of the risk depends on whether anything the Player can "win" has value.

- **UK (Gambling Commission)**: "where in-game items obtained via loot boxes are confined for use within the game and cannot be cashed out it is unlikely to be caught as a licensable gambling activity" ([P] [UKGC, 2017-11-24](https://www.gamblingcommission.gov.uk/news/article/loot-boxes-within-video-games)). Gaming under the Gambling Act 2005 s.6 requires a prize of "money or money's worth" ([P] [legislation.gov.uk](https://www.legislation.gov.uk/cy/ukpga/2005/19/section/6/2014-04-01)). The government's July 2022 response chose industry-led protections over legislation ([P] [GOV.UK](https://www.gov.uk/government/calls-for-evidence/loot-boxes-in-video-games-call-for-evidence/outcome/government-response-to-the-call-for-evidence-on-loot-boxes-in-video-games)).
- **Belgium (Gaming Commission, April 2018)**: the broadest test. A game of chance exists where "a bet of any kind … leads to the loss of this bet … or a win of any kind", and "chance may even be a secondary element". On the prize: "it is not important if a 'skin' … is merely of aesthetic value. What is important is that players attach value to it". Paid loot boxes in Overwatch, FIFA 18 and CS:GO were found to be illegal games of chance ([P] [BGC research report, EN translation](https://www.gamingcommission.be/sites/default/files/2021-08/onderzoeksrapport-loot-boxen-Engels-publicatie.pdf)).
- **Netherlands**: the Raad van State (2022-03-09) overturned the Ksa's €5M-max penalty on EA. It held that FIFA packs were not a separate game of chance, partly because most packs come from normal play ([P] [Ksa](https://kansspelautoriteit.nl/nieuws/2022/maart/uitspraak-raad-state-fifa-zaak-dwangsom/); [P] [Raad van State](https://www.raadvanstate.nl/@130206/dwangsom-onterecht-opgelegd-loot-boxes/)).
- **Australia (from 2024-09-22)**: games with paid chance-based purchases are rated at least **M**, and games with **simulated gambling** are rated **R 18+** ([P] [Australian Classification](https://www.classification.gov.au/about-us/media-and-news/news/new-classifications-for-gambling-content-video-games)).
- **EU, addictive design (DSA)**: on 2026-02-06 the Commission preliminarily found that TikTok's "infinite scroll, autoplay, push notifications" and recommender system breach the DSA. It said "constantly 'rewarding' users with new content" shifts users into "autopilot mode", and suggested disabling infinite scroll over time ([P] [European Commission](https://digital-strategy.ec.europa.eu/en/news/commission-preliminarily-finds-tiktoks-addictive-design-breach-digital-services-act)). The DSA's heaviest duties fall on very large platforms, but the reasoning is now on record.
- **Industry self-policing (Epic)**: Fortnite allowed in-island transactions on 2026-01-09. When a large kid-focused island sold 200-V-Buck prize-wheel spins, Epic added a rule from 2026-01-20: "Do not offer any in-island transactions that directly or indirectly influence prize wheels in any way" ([S] [PC Gamer](https://www.pcgamer.com/games/battle-royale/fortnite-bans-paid-prize-wheels-in-third-party-games-just-days-after-steal-the-brainrot-started-selling-them/); the primary Developer Rules page requires login).

> **Assessment (opinion), not legal advice.**
> - **In the UK and US, a Pull that only leads to a free-to-play game** probably has no "prize of money's worth". That is lower risk, *as long as* no Pull can land on a cash, crypto or tradeable reward. Examples to avoid: a "jackpot" Slop, Creator-funded bounties for Players, or rare NFT drops.
> - **Belgium's test is much broader.** If the product *markets* some landings as more valuable than others, a Belgian-style analysis could find "a win of any kind". That includes rarity tiers, "golden" Slop, and the whole "slot-machine lever" metaphor.
> - **Australia's "simulated gambling" category**, and app-store age ratings, are the most likely *practical* problems if the UI copies reels, jackpot sounds or near-miss animations.
> - **Creator payouts are not Player winnings.** Creators do not stake anything on chance, so they are low risk.
> - **Mitigations**
>   - Drop casino imagery.
>   - Show the price before each Pull, or use prepaid bundles.
>   - Give no Player-side cash or crypto prizes.
>   - Add spend caps and cooldowns.
>   - Age-gate.
>   - Consider letting Players *see* the next Slop's title or thumbnail before paying. That removes "chance" almost entirely.
>
> Get jurisdiction-specific legal review before launching in BE, NL or AU.

### 5b. App-store rules

- **Apple App Review Guidelines** [P] ([developer.apple.com](https://developer.apple.com/app-store/review/guidelines/))
  - **3.1.1**: "If you want to unlock features or functionality within your app … you must use in-app purchase. Apps may not use their own mechanisms to unlock content or functionality, such as … cryptocurrencies and cryptocurrency wallets". A paid Pull that unlocks the next game inside an iOS app is exactly this case.
  - **3.1.1**: the loot-box rule, "must disclose the odds".
  - **3.1.1(a)**: US-storefront apps may include external purchase links and buttons. The Ninth Circuit (Dec 2025) let Apple charge only a cost-based commission on linked-out purchases, and litigation is ongoing ([P] [9th Cir. opinion](https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/11/25-2935.pdf)).
  - **3.1.5(v)**: "Cryptocurrency apps may not offer currency for completing tasks".
  - **4.7**: HTML5 mini games are allowed, but "You are responsible for all such software offered in your app". Hosts must provide content filtering and reporting (4.7.1), follow 3.1 for digital goods, and apply age restriction (4.7.5).
  - **Mini Apps Partner Program** (2025-11-13): 15% commission on qualifying IAP, with the Declared Age Range and Advanced Commerce APIs required ([P] [Apple Developer News](https://developer.apple.com/news/?id=xcz1s7cz)).
- **Google Play**
  - Digital content "must use Google Play's billing system", with exceptions for P2P, alternative billing programs, and similar ([P] [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)).
  - Real-money gambling is prohibited without licensing, including "Games that accept money in exchange for an opportunity to win a physical or monetary prize" ([P] [RMG policy](https://support.google.com/googleplay/android-developer/answer/9877032?hl=en)).
- **Telegram** routes digital goods through Stars specifically to stay "compliant with Apple and Google's latest policies" ([P](https://telegram.org/blog/telegram-stars)).

> **Assessment (opinion).** A native iOS or Android app that charges USDC per Pull would almost certainly be rejected or forced onto IAP, and IAP's 15–30% cut would take most of a micropayment. **Stay web / PWA-first**, as the prototype's home-screen install already does. Treat any native app as a thin client that either uses IAP-bought credits (accepting the fee) or leaves paid Pulls to the web.

---

## 6. Synthesis

### Where the gap is (opinion, grounded in the facts above)

1. **Per-play creator payouts that are automatic and transparent.** Every AI-game feed competitor is free to scroll and pays creators opaquely, if at all. Remix's $123k in total across 140k games shows how thin incentive-funded payouts are. A USDC split on every Pull gives a small Creator real, instant, visible income, which none of the analogs we found offer.
2. **Web-native, rail-native distribution.** The large platforms (TikTok, YouTube, Meta) are locked into app-store IAP and ad models. A web-first product on a stablecoin rail can price in sub-cent units that itch.io's $0.30 card floor or Apple IAP cannot.
3. **Fewer, better games.** A paid Pull naturally penalises low-quality Slop, since Players stop paying to land on it. That can become a quality signal: rank by paid-Pull retention. Free feeds cannot get that signal as cleanly.

### Biggest risks

1. **Conversion.** Thirty years of micropayment evidence (Szabo, Odlyzko, Blendle, Coil, Flattr) says per-action charging suppresses use. No per-swipe feed exists to prove otherwise. *Highest risk.*
2. **Competition from free feeds with massive distribution.** Pocket, TikTok Mini Games and YouTube Playables are all free. Why pay per swipe on Slop Machine?
3. **Gambling and addictive-design framing.** The slot-machine metaphor invites scrutiny under the Belgian test, Australian R18+ simulated-gambling ratings, and the EU DSA reasoning on TikTok, and may put off app stores and payment partners.
4. **Crypto onboarding friction.** Players need a funded USDC wallet before their first Pull. Farcaster's stall and the Telegram tap-to-earn crash show crypto-native audiences are small and fickle.
5. **Supply quality / moderation.** Apple 4.7.1-style duties (filtering, reporting, blocking) apply once distributed in-app, and AI-generated content raises IP and safety moderation load.

### What the market evidence says about viability

- **Demand for the feed format: supported.** Aippy reports about 2M MAU, and investors put a $250M valuation on it. Remix reports 1.5M players and 52M plays. Meta, YouTube and TikTok are all shipping versions.
- **Demand for paying per swipe: not supported by any evidence found.** It is untested at best and contradicted by adjacent evidence at worst.
- **Creator-side appetite for monetization: supported.** Roblox paid $1.5B in 2025, Fortnite >$1B, Poki's top studios up to $1M a year, and jams drew 1,000+ entries for small prize pools.

**Suggested experiments** (opinion). Run these in the prototype before committing to "every swipe costs":

- (a) A free swipe feed with an optional *paid Pull* that only unlocks something extra: a "Creator's pick", or a skip past the algorithm.
- (b) Prepaid Pull bundles with a visible running balance.
- (c) Free browsing plus a pay-to-play tap, per play rather than per swipe. This matches the prototype's existing browse/play variant D.
- (d) Reframing from "slot lever" to "tip the Creator whose game you landed on".

Compare pull-through rate, session length and Creator payout per 1k sessions.

---

## Open questions / not verified

- Official Telegram figures for game-specific mini-app MAU (only secondary trackers found).
- Remix's exact Boost revenue split ("creators keep most" only).
- Flattr's primary shutdown notice (HN / Wikipedia only).
- Epic's Fortnite Developer Rules text on prize wheels (page requires login; secondary quote used).
- Whether Websim has actually shut down (community claims vs. an active official blog).
- Any per-swipe-priced consumer feed. None found, but absence of evidence is not proof.
