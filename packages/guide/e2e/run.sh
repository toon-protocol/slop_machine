#!/usr/bin/env bash
#
# The guide's opt-in Playwright harness — what `pnpm test:guide` runs.
#
# Playwright is a GLOBAL on the box (via `mise`), never a dependency of this
# repository, and the test runner resolves `playwright/test` from wherever a
# spec imports it — which, with no manifest entry, is nowhere. This script is
# the bridge: it finds the global runner's own node_modules and hands it to
# the specs over NODE_PATH. That is also why `e2e/package.json` pins the
# directory to CommonJS — NODE_PATH reaches CommonJS resolution only, and the
# runner compiles the specs either way.
#
# Prerequisite: `pnpm demo --pattern` is running (the first spec says so too,
# with this command in its failure message). The guide itself is served by
# the Playwright config's own web server; nothing else needs starting.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v playwright >/dev/null 2>&1; then
  echo "playwright is not on PATH. It is a global on the box, never a dependency of this repository:" >&2
  echo "  mise use -g npm:playwright && playwright install chromium" >&2
  exit 1
fi

# The real cli.js lives inside the global installation's node_modules; a mise
# shim resolves to the mise binary instead, so ask mise where the real one is
# in that case.
cli="$(readlink -f "$(command -v playwright)")"
case "$cli" in
  */node_modules/*) ;;
  *) cli="$(readlink -f "$(mise which playwright)")" ;;
esac
modules="${cli%/node_modules/*}/node_modules"

NODE_PATH="$modules" exec playwright test --config "$here/playwright.config.ts" "$@"
