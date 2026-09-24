# The Player pays from the browser

Across the TOON fleet, the convention is that writes never come from the SPA (vibe_station ADR 0005, the toon-meta glossary). Slop Machine deliberately breaks it. Each Player's device holds its own seed in IndexedDB and derives two keys from it: secp256k1 for Base Sepolia and Ed25519 for Solana devnet. Each key owns its own payment channel with the platform's connector. The Feed signs one claim per Pull and sends it over BTP, the connector's WebSocket protocol. Nothing custodial sits between the Player and the connector.

A Pull is one local signature plus one WebSocket frame, with no chain call, and the connector's BTP already accepts claims from a bare browser WebSocket. A browser payer therefore keeps the app tier free of payment code, and it is the thing Slop Machine exists to show off. The worst a Player can lose is their channel deposit, and that is devnet USDC from a free faucet.

The Player also funds that channel themselves, on both chains. They bring their own gas (Base Sepolia ETH or devnet SOL from a third-party faucet) and draw mock USDC from the TOON faucet, then open and deposit into their channel with their own key. The platform sponsors nothing. This drops charting's "open link → pulling within a minute": getting gas takes as long as the faucet does, and the free first entries cover the wait.

## Considered Options

- **A custodial payer:** the platform holds each Player's key and channel. It avoids building toon-client for the browser, but each Pull becomes a row in the platform's database rather than a payment the Player made. It also puts payment code in the app tier. Rejected, with no fallback kept.
- **Sponsored onboarding:** a platform sponsor service relays the Player-signed `openChannel` and deposits for them on Base (ERC-2771), and on Solana co-signs one atomic open-and-deposit as fee payer, gifting ~$1 of Runway. It was chosen at first because it meets "open link → pulling within a minute". It was rejected on 2026-09-24: on Solana it needs a hand-topped SOL budget (~5 SOL per 1000 Players) and a USDC mint the platform doesn't own, and on both chains it creates free Runway to farm and a Refill grant to rate-limit. Self-funding makes all of that go away.

## Consequences

- toon-client needs a `./browser` subpath export that leaves out its four `node:*` imports.
- The seed has no export and no recovery. A Player who clears site data gets a fresh key and has to fund a new channel, and the old deposit is stranded.
- The claim nonce watermark must survive reloads. `claimState()` can recover it from the connector as long as the key survives.
