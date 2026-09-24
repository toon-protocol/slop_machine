# Can the Solana devnet faucet fund $1 of sponsored Runway per Solana Player?

Research for [#20](https://github.com/toon-protocol/slop_machine/issues/20), part of the map [#1](https://github.com/toon-protocol/slop_machine/issues/1). It builds on [#6](https://github.com/toon-protocol/slop_machine/issues/6) (`origin/research/devnet-player-onboarding`) and the decisions in [#8](https://github.com/toon-protocol/slop_machine/issues/8) and [#9](https://github.com/toon-protocol/slop_machine/issues/9).

Written 2026-09-24. Sources:

- the sibling `connector` repo at `9d48ba26`, with paths given for each claim
- the live TOON faucet's `GET https://faucet.devnet.toonprotocol.dev/api/info`
- read-only JSON-RPC calls to `https://api.devnet.solana.com` (solana-core 4.3.0)
- one `requestAirdrop` probe to a throwaway key. It returned an error and moved no SOL, but it used up this machine's IP's airdrop for the day.
- the first-party pages of the SOL faucets

## Answer

- **Mock USDC is not a constraint. The TOON faucet can fund $1 per Player at any devnet scale, but the mint is not ours.**
  - The faucet mints on demand, so it never runs dry. It is limited only by an in-memory **1000 USDC per address per 24 h** cooldown. There is no global cap and nothing on-chain limits it.
  - One daily drip to the treasury service's address covers **1000 Players at $1**, or 1000 Refills.
  - The mint's authority is a single key on TOON's faucet box. That key is not ours, and it is not an ungated `mint()` like the one on Base Sepolia.
- **Devnet SOL is the real constraint, and it is manageable.** A sponsored Solana onboarding costs about **0.00454 SOL** per Player. If the same transaction also closes the Player's emptied token account, that falls to **0.00305 SOL**. So 1000 Players need about **3–4.5 SOL**, and most of it is rent that the treasury can recover when channels settle.
  - The public devnet RPC airdrop allows **1 per IP per day**. faucet.solana.com allows 2 requests per 8 h. QuickNode allows one claim per 12 h. devnetfaucet.org advertises 20 SOL. Helius gives about 1 SOL per request and needs a paid plan.
  - A few manual top-ups a week cover low thousands of Players. No faucet can be called automatically per Player.
- **Recommendation: keep TOON's mint, fund USDC by a daily faucet drip to the treasury, and budget SOL by hand.** Make Solana opt-in, as #8 already decided: new Players land on Base. Fund the treasury with about **5 SOL per 1000 expected Solana Players**.
- **The cheapest fallback, if the faucet gets in the way, is to ask the TOON operator to share mint authority with the treasury service.** Use the faucet box's key, or lift the cooldown for the treasury's address. Both are config changes with no code work.
- **A platform-owned mint is possible, but it forks the fleet.** The channel program accepts any mint. Our own connector would bind to our mint through `[settlement.solana] token_address`. But it would stop settling in "TOON mock USDC", and other TOON nodes and toon-client presets would disagree with it. Keep it as a last resort.
- **A pre-funded treasury balance is the same as the recommendation.** The treasury's ATA *is* the pre-funded balance, refilled daily by the faucet.

## 1. TOON's Solana mock USDC: who can mint it

**The live mint is `34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU`.** The faucet reports it (`/api/info` → `chains.solana.usdcMint`, `mintMode: "faucet-is-mint-authority"`), and so does toon-client (`toon-client/docs/devnet.md`, "Settlement token").

On-chain, `getAccountInfo` with `jsonParsed` at slot 503,641,417 returns:

| Field | Value |
| --- | --- |
| owner | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (classic SPL Token) |
| `mintAuthority` | `Bg5YF6nCKe8aeJwoyovYpGr7Qj9ViGSXiH9JHE7tH98F`, a plain system account holding 1.960 SOL |
| `freezeAuthority` | `null` |
| `decimals` | 6 |
| `supply` | 21,000,000,000 base units = **21,000 USDC**, about 21 drips since creation |

- **The mint authority is the faucet box's own treasury keypair.** `connector/packages/faucet/src/solana.js`: "This faucet's keypair is the mint's own MINT AUTHORITY, so a drip coins fresh tokens rather than spending a finite balance". The faucet checks this at boot and refuses to drip if they differ (`assertMintAuthority`, `MINT_AUTHORITY_MISMATCH`).
- **The key is generated on the faucet box and never leaves it.** `connector/infra/linode-faucet/docker-compose.faucet.yml`: "Fresh treasury keypair, generated ON THIS BOX … never copied from another box". The mint is created by `infra/linode-faucet/create-devnet-usdc-mint.sh`.
- **The mint has been replaced once before, and it could be again.** The 2026-07-18 mint `xyc5J8Mg…` (`packages/solana-program/deployments/devnet-public.md`) lost its authority key: "Nobody can mint that token … so the devnet Solana leg has been dead with no repair path" (`create-devnet-usdc-mint.sh`). The script's own recovery plan is "if the box is lost, this script makes another", which means a **new mint address**.
  - A channel PDA is seeded by the mint (`[b"channel", min, max, token_mint]`, `packages/solana-program/src/processor.rs`). A mint rotation therefore strands every open Solana channel, and the platform connector has to be reconfigured.

**Unlike Base Sepolia, this is not "ours to mint freely."** On Base, anyone can call the mock token's `mint()` (`base-sepolia.js`, `mintMode: "ungated-mint"`). On Solana, only the holder of `Bg5YF6…` can mint, and everyone else gets tokens only through the faucet's HTTP route.

## 2. TOON faucet caps (Solana leg)

| Limit | Value | Source |
| --- | --- | --- |
| Per drip | **1000 USDC** (`SOLANA_USDC_AMOUNT`), freshly minted | `packages/faucet/src/solana.js`; live `/api/info` `drips.usdc: "1000"` |
| Per address | **1 drip per 24 h** (`SOLANA_DRIP_COOLDOWN_MS=86400000`) | `solana.js`, `docker-compose.faucet.yml`; live `cooldownHours: "24"` |
| Scope of the cooldown | **In memory, keyed by address, and forgotten on restart.** "a faucet restart forgets cooldowns" | `packages/faucet/src/drip-limiter.js` |
| Global or daily cap | **None.** "this service-side window is the only thing standing between one address and unlimited mock USDC" | `solana.js` |
| Per IP | nginx `limit_req` **30 r/s, burst 60** | `infra/linode-faucet/nginx/conf.d/node.conf` |
| Concurrency | Drips run one at a time on a serialized queue, each taking a few seconds (probe of 1.5–3 s plus confirmations) | `packages/faucet/src/index.js` (`solanaQueue`), `solana.js` |
| SOL | **None dispensed.** The faucet pays the recipient's ATA rent and the fee from its own SOL | `solana.js` header, `toon-client/docs/devnet.md` "Faucet" |

What this means for the platform:

- **The treasury service can draw 1000 USDC a day from one address.** At $1 = 1,000,000 base units per Player, that is **1000 new Players or Refills per day**. Each extra treasury address adds another 1000 a day. That goes around the cooldown's intent, so ask the operator first.
- **Don't point the faucet at each Player's key.** It would work: the faucet creates the ATA and pays its rent, and 1000 USDC is plenty. But every drip spends about **0.0015 SOL of TOON's faucet SOL**, from a 1.96 SOL balance. That is roughly 1300 Players before the faucet's SOL runs out, and "Treasury SOL is scarce and not self-replenishing" (`solana.js` header). It would also give each Player 1000× the intended Runway.

## 3. Devnet SOL per sponsored Solana Player

**The sponsored onboarding is one atomic transaction.** The Player signs and the treasury co-signs as fee payer (#8, ADR 0001). It creates the Player's ATA, transfers $1 of USDC, calls `initialize_channel`, then calls `deposit`. The program refuses third-party deposits, so the depositor must sign: `deposit` accounts `0. [signer] depositor` (`processor.rs`).

Current rent is `getMinimumBalanceForRentExemption`, read live: 0 B → 650,240 lamports; 165 B → 1,488,440 lamports. That is (128 + bytes) × 5,080 lamports.

| Item | Size | Lamports | Recoverable? |
| --- | --- | --- | --- |
| Channel PDA (`ACCOUNT_SIZE = 178`, `packages/solana-program/src/state.rs`) | 178 B | 1,554,480 | Yes. It goes to `rent_recipient` on settle |
| Vault token account | 165 B | 1,488,440 | Yes. It also goes to `rent_recipient` on settle |
| Player's ATA | 165 B | 1,488,440 | Yes, **in the same transaction**. After `deposit` it holds 0, so an SPL `CloseAccount` signed by the Player can refund the sponsor |
| Signature fees (2 signers × 5,000) | — | 10,000 | No |
| **Total, gross** | | **4,541,360 ≈ 0.00454 SOL** | |
| **Total, closing the ATA in the same transaction** | | **3,052,920 ≈ 0.00305 SOL** | |

The open-only figure of 3,047,920 lamports in #6 is the channel PDA plus the vault plus one fee, so it agrees with this breakdown.

- **Channel rent comes back.** `settle_channel` and `force_close_expired` send both closed accounts' lamports to a `rent_recipient` that the settler chooses. The caller "is deliberately unconstrained: any signer may settle once the challenge period has elapsed" (`processor.rs`). The treasury can therefore reclaim about 0.00304 SOL from each abandoned channel after its challenge period.
- **A Refill costs about 10,000 lamports.** It is another Player-signed `deposit`, fee-paid by the treasury. If the ATA was closed, re-creating and re-closing it in the same transaction nets to zero.
- **Unverified:** that `CloseAccount` can follow `deposit` in the same transaction without hitting the size or compute limits alongside `initialize_channel`. It is a small instruction, but no one has sent such a transaction yet.

**Budget.** Gross, 1000 Players need **4.54 SOL**. Net of ATA closure they need **3.05 SOL**, and about 0.01 SOL per 1000 Refills. Rent reclaimed on settlement pays for later Players.

## 4. Where devnet SOL comes from

| Source | Cap | Automatable per Player? | Source |
| --- | --- | --- | --- |
| Public RPC `requestAirdrop` (`api.devnet.solana.com`) | **1 airdrop per IP per day.** The response headers carry `x-ratelimit-airdrop-limit: 1` and `x-ratelimit-tier: free`. A second request gets HTTP 429 with `retry-after: 86400`: "You've either reached your airdrop limit today or the airdrop faucet has run dry". A 10 SOL request returned `-32603 Internal error` | No | Live probe, 2026-09-24 |
| faucet.solana.com | "Maximum of 2 requests every 8 hours"; GitHub sign-in "to unlock a higher airdrop limit". The amount per request is not stated | No. It is a web form | [faucet.solana.com](https://faucet.solana.com/) |
| QuickNode | "once every 12 hours per network". The amount is shown only after you enter an address. Sharing on X doubles it | No | [faucet.quicknode.com/solana/devnet](https://faucet.quicknode.com/solana/devnet) |
| DevnetFaucet.org | "Get 20 devnet SOL"; anonymous or GitHub. No cooldown is stated. Solana docs describe it as having "a rate limit separate than the public RPC endpoints" | No | [devnetfaucet.org](https://devnetfaucet.org/), [Solana airdrop guide](https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets) |
| Helius | "typically 1 SOL per request", with "reasonable daily limits". The dashboard faucet needs a paid plan | No | [Helius accounts FAQ](https://www.helius.dev/docs/faqs/accounts) |
| TOON faucet | **No SOL.** The SOL route was retired (connector issue #945) | — | `solana.js`, `docker-compose.faucet.yml` |

For the platform, this means an operator tops up the treasury by hand every so often. About 5 SOL per 1000 Players is a few faucet claims. That fits "tens to low thousands" of Solana Players, especially since Solana is opt-in behind a chain switch (#8). No SOL faucet can be called on demand per Player, and the treasury service must never try.

## 5. Fallbacks, cheapest first

1. **Status quo, as recommended.** The treasury draws 1000 USDC a day from the TOON faucet into its own ATA, and each onboarding transfers $1 from it. SOL is topped up by hand. No new infrastructure. Risk: a faucet or mint rotation (§1) stops Solana onboarding until the new mint is configured.
2. **Operator arrangement.** The same org runs both services. The faucet box could give the treasury service a long cooldown exemption, or the treasury service could hold the mint-authority key and `mintTo` inside the onboarding transaction. That makes Solana match Base Sepolia's "mint what you need". The price is that a second place holds the authority key, and the fleet's own history (§1) shows losing that key is the dangerous failure. It is a config and key-custody change only.
3. **Platform-owned mint.** It is technically open. `initialize_channel` takes any mint and binds it into the PDA seed (`processor.rs`). The connector binds to exactly one mint per chain, from `[settlement.solana] token_address` (`crates/connector-cli/src/runtime.rs`, `build_solana_settlement_backend`), and refuses a claim on a channel of another mint (runtime test `junk_mint` vs `configured_mint`).
   - Pulls end at the platform's own connector (#8), and Creator payouts are Base-only (#9). So nothing in Slop Machine's own flow needs TOON's Solana mint.
   - Cost: 1,066,800 lamports once, for an 82 B mint.
   - It diverges from "TOON mock USDC" as the fleet-wide devnet settlement token (`toon-client/docs/devnet.md`, presets). Any future Solana peering with other TOON nodes would fail.
4. **Solana-off.** If neither USDC nor SOL can be kept funded, hide the chain switch. #8 already makes Base the default, and Base Sepolia costs about 1.4 × 10⁻⁶ ETH per Player with an ungated mint (#6).

## Newly surfaced questions

1. **Does the TOON faucet operator agree to either option in fallback 2?** That would be a cooldown exemption for the treasury address, or a shared mint authority. This is a conversation with the operator, not a code question.
2. **What happens on a mint rotation?** The treasury service and the platform connector read the Solana mint from config. Should they re-read it from the faucet's `/api/info`, and what happens to Players whose channels are on the old mint?
3. **Should abandoned-channel settlement be automated?** The treasury could reclaim about 0.00304 SOL per channel, but only after its challenge period, and it needs to know which channels are abandoned.
