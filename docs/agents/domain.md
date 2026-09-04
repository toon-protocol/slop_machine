# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is single-context, and the layout below is what is actually on disk:

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md
│   │   ├── 0002-bitrate-follows-the-vibers-budget.md
│   │   └── 0003-a-slot-is-bought-a-peering-is-still-only-created.md
│   └── placeholder-numbers.md
└── (no src/ yet — see CLAUDE.md's status section)
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Cross-repo authority

This repo does not own all of its vocabulary or all of its decisions.

- **Vocabulary**: where `CONTEXT.md` here and
  [`connector/CONTEXT.md`](https://github.com/toon-protocol/connector/blob/main/CONTEXT.md)
  disagree, the connector's wins. `CONTEXT.md` states this itself.
- **Decisions**: connector ADRs are normative here. All three of this repo's ADRs are written
  against specific ones (ADR 0065 on pricing as a schedule over inbound payload; ADRs 0006 and 0043
  on the connector being mechanism, not policy), so "flag ADR conflicts" above includes conflicts
  with ADRs in that repo, not only with the three here.
- **Canonical cross-repo context** lives in `toon-protocol/toon-meta` under `context/`.
