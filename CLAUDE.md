## Agent skills

### Issue tracker

Issues live in GitHub Issues for toon-protocol/slop_machine (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## The AFK factory

`ready-for-agent` is the factory's queue (`docs/agents/triage-labels.md`). When an issue
carries it and its blockers are closed, `.github/workflows/agent-implement.yml` runs
`.sandcastle/agent-implement-issue.ts`, which runs `/mattpocock-skills:implement`
(Sonnet 5.5), then `/mattpocock-skills:code-review` against `main` in a fresh session
(Opus 5.5), then the gate, then pushes `sandcastle/issue-N` and opens a PR labelled
`ready-for-human`. A failed run moves the issue to `needs-triage`. Specs, blocked issues
and issues with an open PR are skipped. The `wayfinder:*` tickets are planning work for a
human, never queued: only `ready-for-agent` starts the factory.

Only `ready-for-agent` starts it; ready-issues.ts also refuses any issue labelled `wayfinder:*`.

**The gate reads its steps from CI.** The gate is the `run:` steps of the `gate` job
(else the `checks` job) of `.github/workflows/ci.yml` **on `main`**, in order. If there is
no `ci.yml`, no such job, or no runnable step, the gate runs nothing and logs that loudly.
There is no `ci.yml` yet, so today the review is the only check. When the first CI job
lands, name it `gate` (or `checks`) and the factory gates on it with no further change.
The rule lives in one place, `gateFromCi` in `.sandcastle/run-gate.ts`, tested by
`.sandcastle/run-gate.test.ts`.

The runner's own commands, from `.sandcastle/`: `npm ci`, `npm test`, `npm run typecheck`.
The sandbox image is the shared `ghcr.io/toon-protocol/sandcastle-agent`; this repo has no
Dockerfile for it. `close-linked-issues.yml` is identical in every factory repo, so change
it in `toon-protocol/provider` first.
