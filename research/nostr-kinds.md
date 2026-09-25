# Research: Nostr kinds for the Slop listing and the operator lists

Ticket: [Which Nostr kinds do the Slop listing and the operator lists use?](https://github.com/toon-protocol/slop_machine/issues/33) (part of map #1). Researched 2026-09-24.

**Question.** Which event kind numbers do these use?

1. The **Slop listing**: addressable, Creator-signed, `d` = slug, tags `d`/`title`/`version`/`image`/`orientation`/`flicks`/`payout`/`summary`/`t`.
2. The operator **blocklist**: Slop addresses (`<kind>:<pubkey>:<slug>`), Version Arweave txids and Creator pubkeys.
3. The operator **featured list**: Slop addresses.

Both lists are operator-signed, replaceable and NIP-51-style. Kind numbers are hard to change once Creators publish, because Feed entries, share links and the `payout` lookup all embed `<kind>:<pubkey>:<slug>`.

## TL;DR

| Event | Kind | Class | Address / identity |
|---|---|---|---|
| Slop listing | **`37567`** | addressable | `37567:<creator pubkey>:<slug>` |
| Operator blocklist | **`17567`** | replaceable (one per operator key) | `17567:<operator pubkey>:` |
| Operator featured list | **`17568`** | replaceable (one per operator key) | `17568:<operator pubkey>:` |

- **All three numbers are free.** They appear in neither the NIPs README kinds table nor the machine-readable registry of kinds, and nowhere in the TOON fleet.
- **`7567` spells SLOP on a phone keypad** (S=7, L=5, O=6, P=7). The three numbers form one family, the way TOON Network groups its kinds on a `…432` suffix.
- **No existing kind fits as-is.** The mute list (`10000`) is a person's own list, which any Nostr client rewrites, and it has no slot for Slop addresses or Arweave txids. The generic sets (`30000`, `30003`, `30004`) and app curation sets (`30267`) each define different entries. NIP-78 (`30078`) and NIP-89 (`31990`) have the wrong meaning for a listing, and `30078` is already shared by three fleet apps.
- **Two replaceable kinds, not one set kind with two `d` tags.** NIP-51 gives a *standard list* (replaceable, one per pubkey) its meaning through the kind, and deprecated the old pattern of carrying a list's meaning in `d` (`30000` + `d=mute`).
- **The TOON relay treats no kind range differently on the paid path.** One flat-priced route covers every write, and the connector never learns a kind. The relay stores anything non-ephemeral, and its only kind quirks (the ephemeral lane, the `10032`–`10099` carve-out) don't touch these numbers.

## 1. What the TOON fleet already uses

Grepped every sibling repo under `TOON-Protocol/` (source, docs and fixtures, excluding `node_modules`) for kinds in `10000`–`19999` and `30000`–`39999`. Nearly every hit is a standard NIP kind. The TOON-specific allocations are:

| Kinds | Owner | Source |
|---|---|---|
| `4433`, `10432`–`10433`, `30432`–`30437` (blocks `10432`–`10441`, `30432`–`30441` reserved) | TOON Network | `TOON_Network/docs/spec/toon-network-v1.md:60-83` (@d5a1963) |
| `11750`, `11751` | vibe_station announcement and heartbeat | `vibe_station/deploy/devnet/announce.ts:48-49`; `vibe_station/docs/adr/0004-a-station-announces-itself-in-four-events.md:40,72,137` |
| `19843`, `39841`, `39842` (plus `19844`, `39844` specced) | rig, NIP-C1 CI | `rig/packages/rig/src/ci/nip-c1-events.ts:33-47`; `rig/docs/specs/nip-c1.md:16` |
| `30617`, `30618` | rig, NIP-34 | `rig/packages/rig/src/nip34-events.ts:31` |
| `30032` | swap orders | `swap/packages/swap/src/wire.ts:40` |
| `30078` | console lease vault and chain seed; toon_world claims | `console/packages/daemon/src/lease-vault.ts:79`, `console/packages/daemon/src/chain-seed.ts:77`, `toon_world/slice/src/nostr/claim-event.js:25` |
| `31036` | toon-client renderer events | `toon-client/packages/client/CHANGELOG.md:1768` |
| `10032` (retired), `10035`, `10036` (retired) | connector announce, SkillDescriptor, seed relay list | `connector/packages/announcer/src/event.ts:25`; `toon-meta/context/glossary.md:50`; `toon-meta/skills/relay-discovery/SKILL.md:30` |
| `5320`/`30320` (Lading), `38383`–`38386` (Paygress, not reused) | third parties checked by TOON Network | `TOON_Network/docs/spec/toon-network-v1.md:88-96` |

There is **no fleet-wide kind registry**. TOON Network's §3.1 is the closest thing: it reserves one contiguous block per class and records what it checked against (`toon-network-v1.md:62-96`). vibe_station picked `11750` "high in the simple-replaceable range, clear of the NIP-51 list block that grows upward from `10000`" (ADR 0004:63-66).

A search for `3756x` and `1756x` across the fleet finds only substrings of hashes in test fixtures, and no kinds.

## 2. The public NIP registry

Checked against [`README.md` at nips `master` @62d5fed](https://github.com/nostr-protocol/nips/blob/62d5feddb1a12f4d454af3890af5253e7292f1d2/README.md) (2026-09-24) and [`schema.yaml` at registry-of-kinds `master` @5cf2b84](https://github.com/nostr-protocol/registry-of-kinds/blob/5cf2b84eaa4871fd2071cc6dc18975db53e7fc33/schema.yaml) (2026-09-22).

- **`37567`**: the nearest assigned kinds are `37515`/`37516`/`37517` below it (registry `schema.yaml:3121,3198`; README `:295-296` lists NIP-CC's `37516` Geocache Listing and `37517` Geocache Curation List) and `38000` above. Nothing between them is taken.
- **`17567`, `17568`**: the nearest assigned kinds are `15128`/`15129` (nsite) and `17375` (Cashu wallet) below (README `:233-234`, registry `:890,1970,3858`). Nothing above them is assigned before `19843` (NIP-C1, not yet merged upstream).
- NIP-01 classes: `10000 <= n < 20000` is replaceable per `(pubkey, kind)`, and `30000 <= n < 40000` is addressable per `(kind, pubkey, d)` ([`01.md:97-99`](https://github.com/nostr-protocol/nips/blob/62d5feddb1a12f4d454af3890af5253e7292f1d2/01.md)). A replaceable event's `a` coordinate keeps a trailing colon, `<kind>:<pubkey>:` (`01.md:80-82`).

NIP-CC's `37516` listing plus `37517` curation list is upstream precedent for a fresh listing kind paired with a fresh curation-list kind.

## 3. Could the listing reuse an existing kind?

No. Each candidate either means something else or forces the Feed index to filter through other apps' events:

- **`32267` Software Application** (README `:287`; registry `:3085`, no NIP). This is Zapstore's app listing. `d` = a package id, and it is paired with `30063` release artifact sets (NIP-51 `51.md:71`). Reusing it would put Slop in native app stores that can't run it. It would also mean the index's subscribe-by-kind (spec §7.1) pulls in every Zapstore app, so a marker tag would need to tell Slop apart.
- **`30078` NIP-78 app data.** "Not meant to be used as a generic interchange format for data that should be public or exchanged between different applications. Applications that need such interoperability should use dedicated kinds instead" ([`78.md:13`](https://github.com/nostr-protocol/nips/blob/62d5feddb1a12f4d454af3890af5253e7292f1d2/78.md)). A listing is public and read by the index, the Feed, the treasury service and share-link crawlers. The fleet already writes `30078` for console's lease vault and chain seed and for toon_world claims (§1), so a `{kinds:[30078]}` subscription would sweep those too.
- **`31990` NIP-89 handler information** describes an app that *handles* other kinds (`k` tags, [`89.md:50-62`](https://github.com/nostr-protocol/nips/blob/62d5feddb1a12f4d454af3890af5253e7292f1d2/89.md)). A Slop is content, not a handler.
- There is no "game" or "web game listing" kind in either registry. A search of `schema.yaml` and the README for `game` finds nothing.

A fresh addressable kind it is. `37567` also sits clear of the ranges that NIP-29 (`39000`–`39009`) and the TOON Network block (`30432`–`30441`) claim.

## 4. Do existing NIP-51 lists fit the operator lists?

NIP-51 ([`51.md`](https://github.com/nostr-protocol/nips/blob/62d5feddb1a12f4d454af3890af5253e7292f1d2/51.md)) splits lists into **standard lists** ("normal replaceable events, meaning users may only have a single list of each kind. They have special meaning", `:19`) and **sets** ("users are expected to have more than one set of each kind, therefore each of them must be assigned a different `"d"` identifier", `:53`).

| Candidate | Defined entries | Fit |
|---|---|---|
| `10000` Mute list (`:26`) | `p`, `t`, `word`, `e` | **No.** It's "things the user doesn't want to see in their feeds": a person's own list. It defines no `a` (Slop address) or Arweave-txid entry. If the operator key is ever logged into a normal Nostr client, that client edits the same event, and Takedowns silently vanish or pick up personal mutes. |
| `30000` Follow sets (`:61`) | `p` only | No: pubkeys only. |
| `30003` Bookmark sets (`:63`) | `e` (kind 1), `a` (kind 30023) | No: semantics are bookmarks. |
| `30004` Curation sets (`:64`) | `a` (kind 30023 articles), `e` (kind 1) | Close for *featured*, but it is defined over articles. |
| `30267` App curation sets (`:72`) | `a` (software application, `32267`) | Close for *featured*, but its entries are defined as `32267` events, which a Slop isn't (§3). |

Nothing fits the **blocklist**: it mixes Slop addresses, Creator pubkeys and Arweave txids, which aren't Nostr ids. The **featured list** could squeeze into `30004` or `30267`. Nothing is gained by that, though, because no outside client knows how to render a `37567` address. It would split the operator's two lists across unrelated kind families, and a curation-set reader would find entries it can't resolve.

**One set kind with `d=blocklist` / `d=featured`?** It would work mechanically, but NIP-51 already moved away from this. Its "Deprecated standard lists" table retires `30000` + `d=mute` and `30001` + `d=pin`/`bookmark`/`communities` in favour of dedicated replaceable kinds (`51.md:77-86`). The operator lists are standard lists in NIP-51's sense: one of each per operator, each with a special meaning that the index and the Feed rely on. So two replaceable kinds follow the NIP's current shape. The index still reads both with one filter, `{kinds:[17567,17568], authors:[<operator>]}`.

## 5. Does the TOON relay price, filter or refuse any kind range differently?

No, not on the paid write path. Checked at relay `origin/main` @bf05d1f, connector `origin/main` @7f523d23.

- **Price.** The relay's connector config has one paid route, `g.toon.relay` → `/write`, at `price = 1` (1 micro-USDC per write), for every kind (`relay/deploy/connector.toml:65-77`). The only other route is the free ephemeral lane (`:88-100`). There is no per-kind price anywhere. The "ADR 0020" the ticket cites is **connector** ADR 0020: "a price is flat per packet… pricing granularity is handler granularity" and "the connector must never learn what a Nostr kind is (ADR 0006)" (`connector/docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md:7-9,19-21,39-44`). ADR 0065 amends "flat" to a schedule over payload length, still kind-blind (`:27-35`). The relay repo has no ADR directory of its own.
- **Refusal.** The paid `/write` handler skips Schnorr verification only for ephemeral kinds, and stores everything else (`packages/relay/src/launcher/handlers/write-handler.ts:55-59,167-187`). The free `/write-ephemeral` lane accepts only `20000`–`29999` (`write-ephemeral-handler.ts:58-62,214-220`). The operator blocklist is event ids from process config, never kinds or pubkeys (`packages/relay/src/nips/blocklist.ts:18-27`).
- **Storage quirk to steer around.** `SqliteEventStore` (the store the launcher uses, `launcher/relay.ts:612`) treats **`10032`–`10099` as parameterized-replaceable, keyed on `d`**, not plain replaceable (`packages/relay/src/storage/SqliteEventStore.ts:145-158`). A relay-side doc calls `10033`–`10099` "unallocated TOON" slots (`relay/docs/mina-zkapps-nostr-relay.md:228-232`). A replaceable list placed there would behave off-spec on the TOON relay, so the lists must avoid it. `17567`/`17568` fall in the plain replaceable branch (`:148-150`), and `37567` in the addressable one (`:156-157`).
- **Deletions.** NIP-09 `a`-coordinate deletions parse any numeric kind (`packages/relay/src/nips/deletion.ts:59-81`), so a Creator's kind-5 deletion of `37567:<pubkey>:<slug>` works as spec §7.1 expects.

## 6. Recommendation and reasons

- **Listing `37567`.** It's a fresh addressable kind, unassigned upstream and in the fleet, clear of every reserved block. No existing kind has a listing's meaning without dragging in other apps' events.
- **Blocklist `17567`, featured list `17568`.** They're fresh replaceable kinds, one per operator key, which is NIP-51's standard-list shape. Both sit high in `10000`–`19999`, clear of the NIP-51 block that grows upward from `10000` (the same reasoning as vibe_station ADR 0004) and of the relay's `10032`–`10099` carve-out.
- **One mnemonic family.** `…7567` = SLOP on a keypad, so `3…` is the listing and `1…` the lists. Future Slop kinds can take `…7569` and up in the matching class, in the TOON Network style of one block per class.
- **Stability.** Like vibe_station's `11750`/`11751`, these are this repo's to keep stable. They are unassigned upstream, and if a NIP ever lands on one, moving is a schema change with its own record. The numbers are pure choice once collisions are ruled out, and the keypad mnemonic is the tie-breaker.

## Not decided here

The kind numbers only. Tag names for the blocklist's three entry types (e.g. `a` / `p` and whatever carries an Arweave txid), and whether NIP-51 private (encrypted) entries are ever used, are left to the implementation. The Feed app reads the blocklist publicly, so its entries are public tags.
