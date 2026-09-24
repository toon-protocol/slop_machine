# A Slop is a Creator's listing; its Versions live on Arweave through paid store uploads

A Slop is an addressable Nostr listing signed by its Creator's key, keyed by a Creator-chosen `d` slug. The listing points at the Slop's current **Version**, which is one ar.io path manifest uploaded through the TOON store (one `kind:5094` write per file plus one for the manifest). When the Creator republishes, `slop publish` uploads a new Version and moves the pointer, so the Slop keeps its identity, its share link (`/s/<npub>/<slug>`) and its place in the Feed. A Version can still be opened on its own at `/s/<txid>`.

The Creator pays the store and the relay directly, from a devnet wallet derived from their own seed. No platform publish service is involved.

Arweave only works if the fleet turns on the store's paid uploads, which means funding the store's key with **mainnet $ARIO**. The free tier caps each file at ~105 KB and allows about 10 MiB for the whole fleet, which is about five real games. That is real money, and it breaks the "devnet only, no mainnet money" rule on purpose. The rule protects Players and Creators from real payments. A few dollars of infrastructure storage (~$0.08/MiB at 2026-09 Turbo prices) spent by the operator is a different category, and the TOON store is half of what the showcase shows. The Version caps (1.5 MiB per file, 10 MiB and 200 files per Version) bound that spend.

## Considered Options

- **An immutable Slop, one per upload.** Rejected. Every bug fix would make a new Slop, leave the old one in the Feed, and break share links.
- **Stay inside the free tier.** Rejected. It allows only single-file Slop of about 100 KB, and the fleet-wide 10 MiB still runs out.
- **The platform uploads through its own funded Turbo key or a publish endpoint.** Rejected. It costs the same real $ARIO, it adds a platform service, and it hides the TOON store from Creators.
- **Self-host Slop on a Slop-only domain for devnet.** This is the fallback if the fleet won't fund paid uploads. It gives real takedowns, header and CSP control, and a Public Suffix List entry, but it drops the store from the showcase.

## Consequences

- MVP publishing depends on a fleet decision outside Slop Machine. The fleet said yes (slop_machine#18): $5 of mainnet $ARIO on the store key, `STORE_TURBO_MAX_ARIO_PER_UPLOAD=120`, topped up by hand.
- Versions are permanent. `slop unpublish` deletes the listing (NIP-09), which only takes the Slop out of the Feed.
- Feed entries and share links address the listing (`<kind>:<pubkey>:<slug>`), not a single event id.
- store#132 (refused writes are still charged) makes resumable, content-hash-deduplicated uploads a requirement of `slop publish`, not a nicety.
