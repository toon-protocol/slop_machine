# The house keeps the Pull; Creators earn from Purchases

The platform keeps 100% of every Pull toll: one platform-wide price of 1¢ (`10000` base units of 6-decimal USDC). A Creator earns nothing from Pulls. Creators earn from **Purchases**: in-game payments their Slop asks for and the Player confirms, all of which go to the Creator. The platform takes no cut. So the platform and Creators compete for the same Player. The house earns when the Player pulls away, and a Creator earns when the Player stays and buys. That rivalry is the pitch.

A Purchase is paid like a Pull, as a claim from the Player's browser payer to the platform's connector. It uses one flat-priced route per tier: 1¢, 5¢, 10¢ and 25¢, with 25¢ as the cap. The connector charges and reports only a route's configured price, so an amount the payer chooses can't be expressed. Behind those routes sits the **treasury service**. It is one platform program that also does the Player sponsoring decided in ADR 0001. On each cleared Purchase it:

- adds the amount to the Creator's running total
- signs a cumulative EIP-712 balance proof on a platform → Creator payment channel on Base Sepolia
- gift-wraps the proof (NIP-59, kind 1059) to the Creator's npub and writes it to the TOON relay

The Creator collects whenever they like with `slop cashout`. It fetches the newest wrap and redeems it with `claimFromChannel`, and the treasury service relays that call through the ERC-2771 forwarder. The model follows `../swap`, which delivers claims to a counterparty the same way.

## Considered Options

- **Split each Pull with the Creator of the landed Slop**, through a ledger and batched transfers, as the research for issue #3 recommended. Rejected in favour of the rivalry. A Creator paid per Pull landed on is rewarded for being swiped *to*, not for being played.
- **Route each Pull to the Creator through a platform hub.** This is TOON's native split, where the hub keeps a flat peering fee. It was already ruled out by #3, because every Creator would need a connector online for every Pull.
- **The Player pays Creators directly.** A claim is only good on a channel between the two parties, so every Player–Creator pair would need gas and collateral. Rejected.
- **A playtime meter:** a per-minute charge paid to the Creator while their Slop is on screen. It needs no Creator code, but it charges the Player for staying, which is the very thing Creators are meant to be rewarded for. Rejected.
- **Creator channels on Solana.** Rejected. A Solana claim only records state, and USDC moves at close-and-settle after a challenge window, so every cash-out would close the channel. A Purchase paid from Solana still credits the Creator's Base claim.

## Consequences

- This amends the decision in #5: Slop → Feed messages are no longer purely for display. A Slop may *ask* for a Purchase, but only the Feed can pay. The Feed draws a confirmation sheet for every Purchase that the Slop can't draw or fake, and refuses anything above the cap.
- The Feed's receipt to the Slop can be forged from devtools, because static Slop has no server to verify it. This is accepted on devnet: a forger cheats the game out of an item, but no Creator loses pay.
- Most Slop will earn nothing unless its Creator builds Purchases in.
- The platform ranks the Feed and profits from churn. Creators may suspect the house rigs the Feed, which the ordering decision has to answer.
- The treasury service holds a hot wallet key and a Nostr key. It runs next to the connector, never inside anything facing the web.
- toon-client has signers and channel clients but no EVM `claimFromChannel` helper. `slop cashout` needs one, or can lift it from `../swap`.
