# The settlement contracts, as trimmed artifacts

`{ abi, bytecode }` and nothing else — the `metadata`, `ast` and `deployedBytecode` sections of a
forge artifact are dropped — so [`chain.ts`](../chain.ts) can replay the connector's own deploy
script onto a fresh anvil with `viem` and **no Foundry, no Rust and no submodules on the machine**.
Docker and this repository's own toolchain are the whole prerequisite.

That is the `swap` repo's approach, taken deliberately over the two alternatives. A `forge script`
run inside a container needs the contracts tree and two submodules; a vendored `anvil --dump-state`
snapshot is coupled to the anvil version, and its mock token has no `mint`, which a devnet that has
to fund a viber needs. The replay runs in the driver's own process, so it adds no service, no image
and no published port for [the bundle guard](../bundle.test.ts) to weigh.

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| Source     | [toon-protocol/connector](https://github.com/toon-protocol/connector) → `packages/contracts/` |
| Via        | [toon-protocol/swap](https://github.com/toon-protocol/swap) → `packages/swap/tests/e2e/fixtures/evm/`, which vendored them first and documents their provenance |
| Contracts  | last changed at `d578bde70dfd993c74fef607a7f3d07ea59102ac`; artifacts taken from a `forge build` of connector `5c1b222f` |
| Compiler   | `solc 0.8.26+commit.8a97fa7a`                                                  |

| file                        | contract                                    | source                        |
| --------------------------- | ------------------------------------------- | ----------------------------- |
| `MockERC20.json`            | `MockERC20` — six decimals, ungated `mint`  | `test/mocks/MockERC20.sol`    |
| `TokenNetworkRegistry.json` | `TokenNetworkRegistry`                      | `src/TokenNetworkRegistry.sol` |

## Why the addresses are asserted rather than read back

Deploying these three things in this order from anvil's account zero — the mock token, the registry,
and a token network created through it — lands them at addresses the rest of the fleet **commits**,
in `local/solo/connector.toml` and in every sibling repo's own devnet. A replay that drifts from
those addresses would still work here and would quietly stop matching a configuration copied from a
sibling, so [`devnet.test.ts`](../devnet.test.ts) holds them as literals and fails naming both
addresses. The deployment's own return value is what the rest of the run then uses.

## Regenerating them

```sh
cd /path/to/connector/packages/contracts && forge build
python3 - <<'PY'
import json
for n in ['MockERC20', 'TokenNetworkRegistry']:
    j = json.load(open(f'out/{n}.sol/{n}.json'))
    json.dump({'abi': j['abi'], 'bytecode': j['bytecode']['object']},
              open(f'/path/to/slop_machine/deploy/devnet/contracts/{n}.json', 'w'), indent=1)
PY
```

New bytecode moves every deterministic address, so regenerating these means updating the literals
in `devnet.test.ts` in the same commit — which is the failure the guard is there to make loud.
