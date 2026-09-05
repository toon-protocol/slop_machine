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
    broadcaster)           ║        │                           │             ║
                           ║   hub-slot-app                station-origin      ║
                           ║      :3200                    :3100  :1935       ║
                           ║                                                  ║
                           ║   chain :8545  (anvil, contracts deployed at run  ║
                           ╚═══════════════════════════════════════════════════╝

     off-box    nothing at all
     loopback   8545 (the chain), 3000 (the hub's edge), 3001 (the station's edge)
     neither    3200 (the slot app), 3100 (the segment port), 1935 (ingest)
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

Not two doors, as a hub has, and not three, as a station has: **zero**. There is no Caddy here, no
certificate and no public name — a laptop topology terminates no TLS — so every publish is
`127.0.0.1`-qualified and exists only so the driver can speak to what it is driving. Two connectors
share a machine, so their host ports differ (`3000` and `3001`) while both containers keep `3000`
inside; that is the concrete reason this bundle could not have been assembled from the two overlays.

The two rules the shipped bundles are held to hold here unchanged, with no local-topology
exception: **the slot app's port and the origin's segment port are published on no interface, in
any form, not even on loopback.** Both are payment-oblivious surfaces, and a devnet that published
either would be proving the paid path over a topology with a free door in it.

The RTMP ingest port belongs to the station half and to nothing else — a hub carries no vibes of
its own — and it is `expose:`d rather than published, because the vibes are pushed by an ffmpeg
inside the origin's own image, on this network.

## Running it

```
pnpm test:devnet
```

There is deliberately no `docker compose up -d` recipe. The chain has to be up and the settlement
contracts deployed before either connector will boot — both are fail-closed on their settlement
configuration — and every credential and both `connector.toml` files are generated per run.

[`bundle.test.ts`](bundle.test.ts) is this bundle's guard, the sibling of
[`../bundle.test.ts`](../bundle.test.ts) and [`../hub/bundle.test.ts`](../hub/bundle.test.ts). It
reads the real committed files, keeps every expected value as a literal declared in the test, needs
no Docker daemon, and runs in `pnpm test` with everything else — so a broken topology fails fast
rather than after a chain has booted.
