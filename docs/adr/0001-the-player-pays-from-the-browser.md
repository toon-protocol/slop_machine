# The Player pays from the browser

Across the TOON fleet, the convention is that writes never come from the SPA (vibe_station ADR 0005, the toon-meta glossary). Slop Machine deliberately breaks it. Each Player's device holds its own seed in IndexedDB and derives two keys from it: secp256k1 for Base Sepolia and Ed25519 for Solana devnet. Each key owns its own payment channel with the platform's connector. The Feed signs one claim per Pull and sends it over BTP, the connector's WebSocket protocol. Nothing custodial sits between the Player and the connector.

A Pull is one local signature plus one WebSocket frame, with no chain call, and the connector's BTP already accepts claims from a bare browser WebSocket. A browser payer therefore keeps the app tier free of payment code, and it is the thing Slop Machine exists to show off. The worst a Player can lose is their channel deposit, and that is platform-gifted devnet USDC.

## Considered Options

- **A custodial payer:** the platform holds each Player's key and channel. It avoids building toon-client for the browser, but each Pull becomes a row in the platform's database rather than a payment the Player made. It also puts payment code in the app tier. Rejected, with no fallback kept.
- **Self-serve onboarding:** the Player funds their own channel. Rejected because no TOON faucet gives out gas, so it misses "open link → pulling within a minute". Instead, a platform sponsor service relays the Player-signed `openChannel` and deposits for them on Base (ERC-2771). On Solana it co-signs one atomic open-and-deposit transaction as fee payer.

## Consequences

- toon-client needs a `./browser` subpath export that leaves out its four `node:*` imports.
- The seed has no export and no recovery. A Player who clears site data gets a fresh key and a newly sponsored channel, and the old deposit is stranded.
- The claim nonce watermark must survive reloads. `claimState()` can recover it from the connector as long as the key survives.
