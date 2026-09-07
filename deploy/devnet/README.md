# The devnet node

**A hub and a station, side by side, on a local chain.**

This is the third deploy bundle in this repository and a **sibling** of the other two, not a
variant of either. [`../`](../) runs one broadcaster's station node and [`../hub/`](../hub/) runs
one hub operator's hub node; this directory is the only place the two node shapes are described
together, because seeing a viber's packet cross a hub to reach a broadcaster needs both of them and
a chain to settle on.

```
                          ╔═══════════════════════════════════════════════════╗
  driver ──paid pull────────▶ hub-connector ──carries──▶ station-connector     ║
   (a viber, a             ║      :3000                       :3000           ║
    broadcaster)           ║        │      │                    │             ║
                           ║   hub-slot-app │              station-origin      ║
                           ║      :3200     │              :3100  :1935       ║
                           ║           hub-relay                              ║
                           ║         :3100  :7100                             ║
                           ║                                                  ║
                           ║   chain :8545  (anvil, contracts deployed at run  ║
                           ╚═══════════════════════════════════════════════════╝

     off-box    nothing at all
     loopback   8545 (the chain), 3000 (the hub's edge), 3001 (the station's edge),
                1935 (the broadcaster's own RTMP ingest), 7100 (the relay's free reads)
     neither    3200 (the slot app), 3100 (the segment port, and the relay's paid write port)
```

## Nothing in `../` or `../hub/` changes

The station bundle's apex is frozen to the `demo` placeholder by its own guard, and both bundles
publish the same connector edge port. A devnet assembled out of their local overlays would be
fighting two guards to prove a third thing, so it writes its own configuration instead: both
`connector.toml` files, every key, and the station's stream key are **generated at run time** into
`./run/`, which git ignores.

The one thing it does not write for itself is the connector build. That pin lives in
[`../docker-compose.yml`](../docker-compose.yml)'s connector `image:` and may be named nowhere else
in this repository, so `DEVNET_CONNECTOR_IMAGE` here is a **required variable with no default**: the
driver reads the pin of record and passes it in. The devnet therefore runs exactly the connector the
two shipped bundles pin, with no third copy to drift.

## Nothing is reachable off-box

There is no Caddy here, no certificate and no public name — a laptop topology terminates no TLS —
so every publish is `127.0.0.1`-qualified, and each exists only so somebody **on this machine** can
reach the one surface they are entitled to. Two connectors share a machine, so their host ports
differ (`3000` and `3001`) while both containers keep `3000` inside; that is the concrete reason
this bundle could not have been assembled from the two overlays.

The two rules the shipped bundles are held to hold here unchanged, with no local-topology
exception: **the slot app's port and the origin's segment port are published on no interface, in
any form, not even on loopback.** Both are payment-oblivious surfaces — they hand out the very
things a viber and a broadcaster are supposed to pay for, and they have no key on them — so a
devnet that published either would be proving the paid path over a topology with a free door in it.

**The ingest port is the one publish that is not the driver's.** It belongs to the station half and
to nothing else — a hub carries no vibes of its own — and it is published on loopback so the
_broadcaster's own encoder_ can reach the ingest it is entitled to. An OBS on this machine is what
a broadcaster actually holds, and the shipped station bundle publishes this same port for this same
party. It is not a fourth free door: ingest is **authenticated**, on the stream key checked before
a byte is transcoded, and it is the **unpaid** direction by design — supplying vibes costs a
broadcaster nothing per second, so there is nothing behind that port to get for free. The run's own
ffmpeg still pushes from inside this network over the same `station-origin:1935` it always used.

## Running it

```
pnpm test:devnet
```

There is deliberately no `docker compose up -d` recipe. The chain has to be up and the settlement
contracts deployed before either connector will boot — both are fail-closed on their settlement
configuration — and every credential and both `connector.toml` files are generated per run.

A run brings the chain up from the digest-pinned image, replays the connector's own deploy script
onto it with `viem` from the trimmed artifacts in [`contracts/`](contracts/) — the mock token at six
decimals, the registry, and a token network created through it — and **asserts the addresses**
against the deterministic ones the rest of the fleet commits, so a configuration copied from a
sibling repo is either right here or loudly wrong. Then it tears everything down, volumes included,
so a second run starts where the first did. A failure prints every node's logs first, so a red CI
job is diagnosable without re-running it locally.

Both nodes then boot from **generated** configuration. Every credential a run needs — both
connectors' signer and settlement keys, both bearer tokens and allowlists, the slot app's operator
signing seed, the station's stream key, the relay's Nostr identity and the broadcaster's own
announcement keypair — is fresh material written into `./run/`, and both
`connector.toml` files are rendered there from the templates in [`templates/`](templates/): the
chain repointed at the compose service, this run's replayed registry and token addresses at six
decimals, EVM only, plaintext peer endpoints allowed, and each node's endpoint named at its own
compose service. The two settlement keys are funded on chain with gas and minted the token they
will front, and each node's self-description is then read back and asserted.

The station is rendered first at a **placeholder apex it was never granted**, which is the state a
broadcaster's node is in before they pull a quote — and what makes the documented order (quote,
configure, restart) something a run walks rather than describes.

Then a broadcaster's vibes go in — a generated test pattern pushed into the station's ingest over
RTMP by **the ffmpeg inside the origin's own image**, so the devnet introduces no image to encode
with — and the run walks the order [`../README.md`](../README.md) gives a broadcaster, rather than
describing it: **quote, configure, restart.** A payer opens and funds one channel with the hub,
pulls a paid quote, reads the prefix the hub would grant, re-renders the station's configuration
at it, restarts the node, and re-reads what the station now publishes.

Once the slot is bought, the broadcaster makes their station **found** as well as reachable:
[ADR 0004](../../docs/adr/0004-a-station-announces-itself-in-four-events.md)'s four events — a
standard kind 0 profile, a replaceable station announcement carrying the granted ILP address, the
ladder at the station's own per-segment prices and its free-form categories, a short-expiry
heartbeat whose unexpired existence _is_ liveness, and one NIP-94-style event per clip — each
signed with a per-broadcaster Nostr keypair the run mints, and each an ordinary **paid write**
through the hub's `announce` route to the stock relay image the hub runs. The suite then reads
every one back off the relay's **free NIP-01 surface** — the seam a discovery client will consume —
and watches the heartbeat lapse: a station that stops heartbeating reads as off the air, with no
sign-off event anywhere, because none exists.

The payer is [`toon-client`](https://github.com/toon-protocol/toon-client), the fleet's own client
side, pinned to an exact release and a **development dependency of the devnet only** — a dependency
of neither package, in no published image, imported by nothing under `packages/`. Neither app in
this repository may hold payment code, which is exactly why the payer comes from outside it. The
announcement signer, `nostr-tools`, is held to the same terms for the same shape of reason:
announcing is the broadcaster's client-side act, and neither app may grow a voice.

The prerequisite is **Docker and this repository's own toolchain, and nothing else** — no account,
no faucet, no testnet, no real money, and no Foundry, Rust or submodules. anvil runs in the pinned
image; the only binary a run ever executes on the host is `docker`. With no daemon answering, the
run refuses in one sentence that says so rather than failing somewhere further in.

## Seeing it — `pnpm demo`

The run above is the **evidence**: every value it expects is a literal, it asserts the money on
chain, and it goes red. It is not a thing you can watch. `pnpm demo` is the other half — the same
topology, the same credentials and the same paid requests
([`paid.ts`](paid.ts), shared so that what is demonstrated is the thing that is proved), with two
differences that are the whole point of it: **the vibes come from your own OBS**, and nothing is
torn down after the purchase.

```
pnpm demo
```

It brings the chain and both nodes up, walks the documented broadcaster order — quote, configure,
restart — buys the slot, and then prints the Server and Stream Key pair OBS asks for:

```
  Service      Custom…
  Server       rtmp://127.0.0.1:1935/live
  Stream Key   (generated for this run, printed once, never committed)
```

Set the **keyframe interval to 2 seconds** — the origin cuts 2-second segments on keyframes — and
hit Start Streaming. Within a couple of seconds the station is on the air, and a page at
<http://127.0.0.1:8088> is showing your broadcast coming back **one paid packet at a time**:

- a **viber**, a different party with its own channel, buying `/now` and then every segment as it
  plays, at both rungs;
- what each rung costs and how that splits — what the station charges to terminate, what the hub
  keeps for carrying — derived from the two nodes' own published prices rather than from a number
  the demo holds;
- a running total of what the viber has spent and what the broadcaster has banked off chain;
- and a **Redeem on chain** button, which turns the newest claim into money on anvil while the
  channel stays open and the vibes keep flowing.

Every `.ts` file the page plays arrived as the body of a fulfilled packet that spent a claim, so
the playlist it plays is one **the station never sent** — no playlist is served from a station,
which is why the client daemon synthesizes one over loopback and why the smallest possible stand-in
for it lives in [`player.ts`](player.ts) rather than in either app.

The player also serves the **playback contract**
([ADR 0005](../../docs/adr/0005-the-budget-lives-on-the-paying-side-of-the-loopback-line.md)) —
the versioned loopback surface under `/contract/v1/` the guide will stand on and the eventual
toon-client daemon implements from the record: initiate and stop vibing, select a rung, read
state. The budget lives on the paying side of that line and no request across it can raise it;
[`contract.test.ts`](contract.test.ts) boots the player standalone (no Docker) in `pnpm test` and
holds that by literal, and the devnet run drives the same surface with real money underneath.

```
pnpm demo -- --pattern      the run's own ffmpeg test pattern, for nobody at the keyboard
pnpm demo -- --port 9000    where the page is served
pnpm demo -- --anyone       host the hub behind an Anyone-network hidden service
```

Ctrl-C prints what the viber paid, what the broadcaster earned, what the hub carried it for, and
tears everything down.

The demo **asserts nothing**. It is here so that a thing which is true can also be seen by somebody
who has not read the test.

## Hosting over a hidden service — `pnpm demo --anyone`

The demo above is one machine talking to itself. `--anyone` makes it a **broadcast anybody can pay
for**: the hub's client edge and the chain's RPC are fronted by ONE hidden service on the
[Anyone Protocol](https://github.com/anyone-protocol) overlay, and every payer — the broadcaster,
the demo's own viber, and remote viewers — pays over the circuit at `http://<address>.anyone`.
The station stays internal: its only client is the hub, one compose network away, and a viber never
reaches a station directly in any mode.

Be clear about what this rides on: **the Anyone network is a live third-party network.** First
bootstrap takes a minute or two, circuit latency is real (a pull's round trip is tens of
loopback's, which is why the viber's preroll and drift window widen in this mode), and a bad
network day is a bad demo day. The daemon is anon v0.4.10.2, built by
[`anon/Dockerfile`](anon/Dockerfile) because ghcr publishes no image for the release that routes
`.anyone` — the only hidden-service TLD the payer routes.

**The host:**

```
pnpm demo --pattern --anyone      (or without --pattern, with OBS at the keyboard)
```

The run brings the daemon up first — the hub's configuration has to advertise the `.anyone`
address, and the address does not exist until the daemon has generated it — waits for
`Bootstrapped 100%`, and then walks the demo exactly as before, every paid request now riding the
circuit through the daemon's SOCKS side on `127.0.0.1:9050`. Once the slot is bought it prints a
**Remote viewers** block: the hub's `.anyone` address, the station's granted prefix, the seal-to
key (the station's public edge identity, handed out because a viewer cannot read the station's own
self-description), three private keys funded with gas and token on this run's chain, and the exact
`pnpm demo:viewer` command. **The address is stable across runs**: it lives in `run/hub-anon/hs/`,
which is a bind mount the teardown and the next run's credential sweep both deliberately leave in
place — delete that directory and the next run mints a new address.

**A viewer**, on any machine with Docker and a checkout of this repository:

```
pnpm demo:viewer -- \
  --connector http://<56-char-address>.anyone \
  --station   g.toon.slopmachine.<handle> \
  --seal-to   <hex> \
  --price audio=200 --price 480p=1000 --price now=50 \
  --key 0x…
```

(every value copied from the host's printed block). The viewer builds the daemon image on first
use, runs its own SOCKS-only anon beside it, opens its **own payment channel with the hub over the
circuit** — chain RPC rides the proxy too, through the hidden service's port 8545, so the viewer's
settlement address is never broadcast from its own IP — discovers the ladder from the first paid
`/now`, and then buys the broadcast one paid packet at a time into the same page, at
<http://127.0.0.1:8088>. `--price` pairs are optional and only feed the broadcaster/hub split
display; `--socks socks5h://…` skips the managed daemon when one is already running. Ctrl-C prints
what was paid and removes the daemon container.

And that is the whole story for the hosted guide too: **run the command, open
<https://toon-protocol.github.io/slop_machine/>.** With `--guide-origin` naming a `.anyone` guide,
the viewer also stands a tiny forwarder on its own `127.0.0.1:7100` — each connection hand-carried
through the viewer's SOCKS proxy to the guide service's relay forward — so the hosted page's
`ws://127.0.0.1:7100` relay reads ride the viewer's own circuit, the grid lights up, and the page
vibes against this viewer's own paying side at `127.0.0.1:8088`. Free reads only; nothing about
the forwarder touches payment or the budget. On the demo **host** that port is already the compose
bundle's own relay publish — the forwarder says so and stands down, because the hosted guide reads
it directly there.

Running the viewer **on the same machine as the host** — the full-circuit rehearsal — works too:
the viewer's daemon takes its own SOCKS port so it never fights the host's 9050, but the page
defaults to the same 8088 the host's page holds, so add `--port 8090`.

### The guide, over the circuit

The same daemon hosts a **second** hidden service: the guide — the discovery grid, categories and
broadcaster pages of [`packages/guide`](../../packages/guide/) — at its own stable `.anyone`
address (persisted in `run/hub-anon/guide-hs/`, exactly like the hub's). The service's port 80
forwards to a small static server the **driver** runs on the host (the compose network's gateway
address, `10.213.0.1:4173`), and its port 7100 forwards to the relay's **free NIP-01 reads**, so
the page's websocket works from anywhere — free reads over the circuit are the design working:
reads are free by design, and being reachable is what costs.

**The build is yours, once per address.** The driver spawns nothing but docker, and the build
bakes the relay URL — which is this run's own guide address — so the demo prints the one-liner
when `packages/guide/dist` is missing (or whenever the address changed):

```
VITE_RELAY_URL=ws://<guide-address>.anyone:7100 pnpm --filter @toon-protocol/guide build
```

then re-run the demo. `VITE_PLAYBACK_URL` is deliberately **not** baked: its default,
`http://127.0.0.1:8088`, is each reader's _own_ paying side — the host's demo player, or a remote
viewer's `pnpm demo:viewer` on its default port — which is ADR 0005's seam working: the page
travels, the budget stays home. (A viewer whose player was moved with `--port` — the same-machine
rehearsal above uses 8090 — will see the hosted-mode explanation instead of the theater, because
the page probes 8088.)

**Viewing it**: Firefox → Settings → Network Settings → Manual proxy configuration → SOCKS v5
Host `127.0.0.1`, Port `9050` (the host's own daemon; a remote viewer uses their `demo:viewer`
daemon on `9250`), and check **Proxy DNS when using SOCKS v5**. Firefox does not proxy loopback,
which is exactly right: the page and the relay ride the circuit while the guide's contract calls
to your own `127.0.0.1:8088` stay direct. The demo adds the guide's origin to its player's
allowlist at runtime, and a remote viewer passes the printed `--guide-origin` flag so their own
paying side does the same — the allowlist is the paying side's own configuration, and no request
across the line can extend it.

Port 4173 is also the guide harness's own vite origin, so `pnpm test:guide` and an `--anyone`
demo's guide server cannot run at the same time; the demo says so and continues without the page
rather than dying over it.

**A host firewall can silently cut the guide's last hop.** The daemon forwards the guide service
to a server the _host_ runs on the bridge gateway address, and that container-to-host traffic goes
through the host's INPUT chain — which a default-deny firewall (ufw on this repo's first live box)
drops, so the page times out over the circuit while everything container-to-container (the hub,
the chain, the relay) keeps working. The fix is one rule scoped to the pinned subnet and the one
port:

```
sudo ufw allow from 10.213.0.0/16 to any port 4173 proto tcp comment 'slopmachine devnet: guide over the hidden service'
```

The probe that tells this apart from descriptor propagation: from inside the daemon's container,
`bash -c 'exec 3<>/dev/tcp/10.213.0.1/4173'` — blocked means the firewall, open means keep
waiting for the descriptor.

[`bundle.test.ts`](bundle.test.ts) is this bundle's guard, the sibling of
[`../bundle.test.ts`](../bundle.test.ts) and [`../hub/bundle.test.ts`](../hub/bundle.test.ts). It
reads the real committed files, keeps every expected value as a literal declared in the test, needs
no Docker daemon, and runs in `pnpm test` with everything else — so a broken topology fails fast
rather than after a chain has booted.
