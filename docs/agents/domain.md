# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

**This repo is single-context**: one `GLOSSARY.md` at the root plus `docs/adr/`. There is no monorepo signal (no `pnpm-workspace.yaml`, no `workspaces` field, no `packages/*`), so no `GLOSSARY-MAP.md`.

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/                      ← ADRs (lazy; absent until a decision qualifies)
│   ├── agents/                   ← this file + issue-tracker.md + triage-labels.md
│   └── specs/                    ← specs written by /to-spec
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Domain invariants worth knowing before touching this codebase

These are not terms; they are load-bearing constraints the code depends on. Violating them breaks the build or the product in ways the type checker will not catch.

- **`GLOSSARY.md` must stay committed.** `.gitignore` ignores `*.md` broadly to keep AI scratch files out; `GLOSSARY.md`, `docs/agents/*.md`, `docs/specs/*.md`, and `docs/adr/*.md` are explicitly un-ignored. If you widen an ignore rule, re-check these still track.
- **The worker source is a template string.** All JSON logic lives inside a backtick string in `main.ts` (the function that returns the worker code), so it escapes TypeScript type-checking entirely. `scripts/verify-compact.mjs` locates that string by marker and instantiates it in a sandbox; it depends on the template being a pure literal with no backticks or interpolations inside. Editing the delimiters silently breaks that script.
- **Build output is a single HTML file** with everything inlined. Any new runtime dependency or any API needing a polyfill violates a stated product constraint, not just a style preference.
- **No automated test suite exists.** "Tests pass" is never a claim this repo can make; verification is static assertions plus a manual checklist.