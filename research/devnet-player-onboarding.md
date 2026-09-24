# How fast can a new Player get a funded devnet channel?

Research for [#6](https://github.com/toon-protocol/slop_machine/issues/6), part of the map [#1](https://github.com/toon-protocol/slop_machine/issues/1).
Written 2026-09-24. Sources are the sibling TOON repos (the path is given for each claim), official Base, Coinbase, Circle and Solana docs, and **read-only** RPC reads against Base Sepolia and Solana devnet. No money was spent and no channel was opened.

## Answer

- **If Players self-serve, neither chain meets "open link → pulling within a minute".** A Player needs native gas (Base Sepolia ETH or devnet SOL) *and* TOON's mock USDC before the first Pull. TOON's faucet gives USDC only, never gas. Gas comes from third-party faucets that need a login or are rate-limited, so getting it takes minutes and sometimes fails.
- **If the platform sponsors onboarding, both chains take seconds, and the existing contracts already support it.** The best option is **Base Sepolia (`evm:84532`)**:
  - The Player's browser key signs **one EIP-712 message**. It pays no gas and holds no USDC.
  - The platform submits two transactions: `openChannel`, relayed through the deployed ERC-2771 forwarder, then `setTotalDeposit` from the platform's own wallet, crediting the Player.
  - That takes about 2 blocks of 2 s each and costs about **1.4 × 10⁻⁶ ETH per Player** at today's gas price.
  - The mock USDC has an ungated `mint()`, so collateral is effectively unlimited.
- **Solana devnet also works when sponsored**, as one atomic transaction that the platform and the Player both sign. It is slightly worse for the platform: it costs about **0.0045 SOL per Player** (mostly rent), devnet SOL is scarce, and the platform's supply of mock USDC is capped by the faucet.
- **The TOON gas station cannot bootstrap a new Player.** It will not relay `openChannel` or `INITIALIZE_CHANNEL`, and paying it requires a channel you already have.

## 1. What a Player needs before the first Pull

A Pull is a paid packet. To pay it, the Player needs a channel with the platform's connector, and that channel must hold enough collateral to cover the Pull. Claims cost no gas. Only open, deposit, close and settle are transactions (`toon-client/docs/channels.md`, "Payment channels" and "Gas"). The connector has **no public endpoint** that opens a channel for a buyer: "You open it, not the connector" (`toon-client/docs/channels.md`).

Each connector is its own settlement counterparty, so a channel opened with one node buys nothing at another (`toon-client/docs/devnet.md`, "Nodes"). The Player's channel therefore has to be with whichever connector terminates the Pull route.

## 2. Faucets

| Faucet | Asset | Amount / limit | Useful for TOON? | Source |
| --- | --- | --- | --- | --- |
| TOON faucet `POST /api/base-sepolia/request` | TOON mock USDC `0x49beE1…9Ce` | **1000 USDC** per drip, 24 h cooldown per address | Yes, it is the settlement token | `connector/packages/faucet/src/base-sepolia.js` (defaults); live `GET https://faucet.devnet.toonprotocol.dev/api/info` |
| same, ETH leg | Base Sepolia ETH | Best-effort, **disabled by default** (`BASE_SEPOLIA_ETH_AMOUNT='0'`); live `/api/info` reports `faucetBalances.eth: null` | No | `base-sepolia.js`; `toon-client/docs/devnet.md` "Faucet": "**Neither leg funds gas.**" |
| TOON faucet `POST /api/solana/usdc-request` | TOON mock USDC SPL `34eSxY…fQU` | **1000 USDC** per drip, 24 h cooldown; creates the recipient's ATA and pays its rent; **no SOL** | Yes | `connector/packages/faucet/src/solana.js` header; live `/api/info` (`cooldownHours: "24"`) |
| Coinbase CDP faucet | Base Sepolia ETH | 0.0001 ETH per claim, "1000" claims per 24 h (scope not stated) | Gas only | [CDP faucets](https://docs.cdp.coinbase.com/faucets/introduction/welcome) |
| Coinbase CDP / Circle faucet | **Circle** USDC | CDP: 1 USDC per claim, 10 per 24 h. Circle: "20 USDC on testnet every 2 hours, per address, and per blockchain" | **No.** TOON settles in its own mock USDC, not Circle's | [CDP](https://docs.cdp.coinbase.com/faucets/introduction/welcome), [faucet.circle.com](https://faucet.circle.com/) |
| faucet.solana.com | devnet SOL | "Maximum of 2 requests every 8 hours"; GitHub sign-in "to unlock a higher airdrop limit" | Gas only | [faucet.solana.com](https://faucet.solana.com/) |
| `requestAirdrop` RPC / `solana airdrop` | devnet SOL | "can be subject to rate limits when there is a high number of airdrops" | Gas only, unreliable | [Solana airdrop & faucets guide](https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets). The public devnet RPC also returned HTTP 429 to our read-only sampling |

Two points follow from this table:

- **The only USDC that counts is TOON's mock mint.** On Base Sepolia its `mint()` is ungated, so anyone, including the platform, can mint any amount without the faucet (`toon-client/docs/devnet.md`: "mock USDC, 6 decimals, ungated `mint()`"; `base-sepolia.js` header).
- **On Solana, the TOON faucet holds the mint authority** (`solana.js`: "This faucet's keypair is the mint's own MINT AUTHORITY"). A platform can only get Solana mock USDC in 1000-USDC-per-address-per-day drips unless the TOON operator grants more.

## 3. Channel open: steps, time and gas, measured

### Base Sepolia (`evm:84532`)

These are the live contracts that `GET https://proxy.relay.devnet.toonprotocol.dev/ilp` advertises. The deployment record is `connector/packages/contracts/deployments/base-sepolia.md` ("ADR 0059 cutover… CURRENT LIVE"):

- TokenNetwork `0xe9E05dfecfe165266C88d73e61D483612651952a`
- trusted ERC2771Forwarder `0x350fCd266F95B1f5B84944E0C7e06C16B837FCAA`

**Unsponsored flow** (what `toon-client` does today). The client sends `openChannel`, then, when it deposits, `approve` if the allowance is short, then `setTotalDeposit`. Each transaction waits for its receipt (`toon-client/packages/client/src/channel/evm/TokenNetworkClient.ts:403-470, 549-570`). That is 2–3 sequential transactions, all paid in the Player's own ETH.

**Measured** from 17 real open+deposit pairs on the live TokenNetwork between blocks 47.17M and 47.22M, read with `eth_getLogs` and receipts:

| Tx | Gas used | Fee (incl. L1 fee) |
| --- | --- | --- |
| `openChannel` (`0x24f453d1`) | 144,869–144,878 | ≈ 8.75 × 10⁻⁷ ETH |
| `setTotalDeposit` (`0x36bcdb80`) | 73,819–80,784 | ≈ 4.5–4.9 × 10⁻⁷ ETH |
| **open + deposit** | ≈ 225k | **≈ 1.4 × 10⁻⁶ ETH** |

The effective gas price was 0.006 gwei (base fee 0.005 gwei). Opens and deposits landed in **consecutive blocks**. The average block time was **2.0 s** over the last 1000 blocks. Base documents 2 s blocks with Flashblocks preconfirmations every 200 ms ([Base block building](https://docs.base.org/base-chain/network-information/block-building)). That page does not say whether Flashblocks run on Sepolia, so we treat them as **unverified** there.

The chain time for the unsponsored path is about 4–6 s. The bottleneck is getting ETH first.

**RPC caveat.** `https://sepolia.base.org` is a load balancer and is not read-after-write consistent. A `setTotalDeposit` that runs right after an open can revert with `InvalidChannelState()`. Use `https://base-sepolia-rpc.publicnode.com` (`toon-client/docs/channels.md`, "Choosing an EVM RPC").

### Solana devnet

Program `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` (`toon-client/docs/devnet.md`; live `/ilp`).

**Unsponsored flow.** `toon-client` sends `initialize_channel`, then a separate `deposit`, each at `confirmed` commitment (`toon-client/packages/client/src/channel/solana/payment-channel.ts:1160-1210`).

**Measured** from recent program transactions (read-only `getTransaction`):

| Tx | Fee | Payer lamport delta |
| --- | --- | --- |
| `initialize_channel` | 5,000 | **3,047,920**: rent for channel (178 B) 1,554,480 + vault (165 B) 1,488,440, plus the fee |
| `deposit` | 5,000 | 5,000 |
| init + deposit **in one tx** (seen on chain, `4Ttexfsz8B…`) | 5,000 | one tx is enough |

The rent figures are live `getMinimumBalanceForRentExemption` values. Older opens show a 4,174,040 delta, because devnet rent was higher then. `toon-client` still preflights with `MIN_LAMPORTS_FOR_CHANNEL_OPEN = 4_179_040n` (`payment-channel.ts:550`), which is now conservative. The base fee is 5,000 lamports per signature ([Solana fees](https://solana.com/docs/core/fees)). `getRecentPerformanceSamples` measured devnet at about 166 ms per slot during this research. Solana's usual figure is about 400 ms. Either way, a `confirmed` transaction lands in about a second.

## 4. Can the platform sponsor onboarding?

**The TOON gas station: no, not for a new Player.**

- Its EVM relay whitelist is exactly `setTotalDeposit`, `closeChannel` and `settleChannel`.
- Its Solana leg restricts channel-program instructions to deposit, close and settle.
- "Opening a channel and claiming from one are deliberately excluded" (`gas-station/README.md`, "The security property", rows (d) and (e)).
- It is also a paid TOON app ("They pay for it… over an ILP payment channel"), so reaching it needs the channel you are trying to fund. `connector/docs/research/x402-and-channel-funding.md` §5 calls this "the bootstrap loop".

**A Slop Machine platform doesn't need the gas station.** The contracts already let the platform do every step itself:

**EVM.**

- `TokenNetwork` is `ERC2771Context`: "an EOA holding zero native gas can still open, fund, close and claim channels via a relayer" (`connector/packages/contracts/src/TokenNetwork.sol:14-22`).
- `openChannel` takes the pair from `_msgSender()`, so the Player must sign, but only an EIP-712 `ForwardRequest`. Any relayer can submit it to the OpenZeppelin forwarder.
- `setTotalDeposit(channelId, participant, total)` pulls tokens from the **caller** and credits **any participant** (`TokenNetwork.sol:266-294`). The x402 research note calls this a delegate deposit: "Caller and credited participant are independent parameters" (`x402-and-channel-funding.md` §3.3).
- So the platform, from its own wallet (ETH for gas, freshly minted mock USDC, approved once with `U256::MAX`):
  1. relays the Player's signed `openChannel` through the forwarder, then
  2. calls `setTotalDeposit(channelId, player, X)`.
- The Player spends no gas, holds no USDC and makes one signature.
- The channel id is derivable (`keccak256(p1 ‖ p2 ‖ epoch)`, ADR 0059), so the Player's client can find its channel without being told.
- Alternatively, the **connector itself** can open the channel. Its operator API has an authenticated `POST /channels {counterparty_hex, chain, settlement_timeout_seconds}` (`connector/crates/connector-operator/src/lib.rs:843-880`). The connector is then `_msgSender()`, and the Player signs nothing at all. This only works if the platform runs its own connector.

**Solana.**

- `initialize_channel` needs only a signing **payer**. Neither participant has to sign (`connector/packages/solana-program/src/processor.rs:125-155`), so the platform or its connector can create the channel and pay the rent.
- `deposit` must be signed by a participant and is credited to whoever signs. There is no delegate deposit, "and adding one is not possible without changing the program" (`processor.rs:301-360`; `x402-and-channel-funding.md` §3.3). The Player's key must therefore sign the deposit, from the Player's own ATA.
- Solana lets the fee payer differ from the signers. So one atomic transaction can do all of this, signed by the platform (fee payer) and the Player:
  1. create the ATA idempotently (platform pays)
  2. transfer mock USDC from the platform to the Player's ATA
  3. `initialize_channel` (platform is the payer)
  4. `deposit` (Player signs)
- It costs the platform about 3,042,920 lamports of channel and vault rent, plus 1,488,440 for the ATA, plus 10,000 in fees. That is **≈ 0.0045 SOL per Player**, and the transaction confirms in about 1 s.

**Unverified, and to test before relying on it:**

- whether the claim gate accepts claims on a channel the **connector** opened toward a buyer (the connector's own channel bookkeeping lists "every channel this node opened itself")
- the extra gas the forwarder adds to a relayed `openChannel`
- whether a sponsored EVM open and deposit can land in the **same** block (sequential nonces from two senders, the relayer and the platform wallet)

## 5. Fastest "open link → first Pull"

| Path | Player steps | Chain time | Platform cost / Player | Meets ≤ 1 min? |
| --- | --- | --- | --- | --- |
| EVM, self-serve | get ETH from a third-party faucet (login), TOON USDC drip, 2–3 txs | ~4–6 s after funding | 0 | **No.** The ETH faucet step is minutes and needs an account |
| Solana, self-serve | SOL airdrop (2 per 8 h, 429-prone), TOON USDC drip, 1–2 txs | ~1–2 s after funding | 0 | **No.** The airdrop is unreliable |
| **EVM, sponsored (relay open + delegate deposit)** | generate key, sign 1 EIP-712 message | **~2–4 s** (2 blocks) | **≈ 1.4 × 10⁻⁶ ETH** + minted mock USDC (free) | **Yes** |
| Solana, sponsored (1 atomic tx) | generate key, co-sign 1 tx | **~1 s** | **≈ 0.0045 SOL** + 1000-USDC/day-capped mock USDC | Yes, but it is supply-constrained |

**Recommendation: Base Sepolia with platform-sponsored onboarding.**

- It is fast enough for the one-minute bar.
- Its per-Player cost is tiny: 0.01 Base Sepolia ETH funds about 7,000 Player onboardings at today's price.
- Its USDC is unlimited.
- The Player does nothing on-chain.

Solana is a working second chain, but it needs a devnet-SOL budget (0.0045 SOL × Players, from a faucet capped at 2 requests per 8 hours) and a mock-USDC arrangement with the TOON operator.

## 6. Facts for the payer decision

- Every Pull needs a channel with the **connector that terminates the Pull route**. Channels are per connector. The platform connector is the natural counterparty.
- On devnet a sponsored deposit is circular. The platform mints mock USDC, credits it to the Player, and receives it back through claims. The Creator split is paid out of that. This is fine under "devnet only", but a "free first N Pulls" hook costs nothing real.
- **The deposit size sets the Player's runway.** 100,000 base units is 0.10 USDC. At a 1,000-unit toll (0.001 USDC), that is 100 Pulls. A Pull that would exceed the deposit is refused `F03` and can be resent after a top-up (`toon-client/docs/channels.md`, "Collateral"). A top-up is another sponsored `setTotalDeposit` on EVM. On Solana it needs a Player-signed deposit.
- **Claims need a durable nonce watermark on the Player side.** If it is lost, every later claim is refused `F01`, and on EVM a re-open strands collateral (`channels.md`, "The watermark"). In a PWA, that state lives in browser storage.
- **`toon-client` is Node-only today.** Its keystore pulls in `node:crypto` and `node:fs` (`toon-client/docs/hidden-service.md`, "Browsers"; map #1). Sponsored onboarding needs browser-side EIP-712 signing of a ForwardRequest and of claims.
- The ERC-2771 forwarder exists on Base Sepolia but **not on Base mainnet** (`trustedForwarder == address(0)`, `connector/packages/contracts/deployments/base-mainnet.md`). This is irrelevant under "devnet only", but the EVM sponsorship path doesn't carry over to mainnet unchanged.
- The minimum settlement timeout is 1 h on EVM, and the default is 24 h (`channels.md`, "Closing and settling"). Abandoned sponsored channels keep their collateral locked until someone closes them. On devnet that costs nothing.

## Newly surfaced questions

1. **Does the platform run its own connector, and is it the Pull counterparty?** Sponsorship through the connector operator API (`POST /channels`) needs one. This ties into "Service decomposition" in the map.
2. **Browser signing.** Who provides EIP-712 ForwardRequest and claim signing, and durable watermark storage, in a PWA, given `toon-client` is Node-only?
3. **Sponsored-deposit abuse.** A Player can close a sponsored channel and settle the unspent collateral to themselves, and bots can farm onboarding. This is worthless on devnet, but it feeds "Abuse economics".
4. **Test the three unverified points in §4:** the connector-opened buyer channel, forwarder gas overhead, and same-block open and deposit.
