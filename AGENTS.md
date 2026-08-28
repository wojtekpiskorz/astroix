# AGENTS.md

Astroix is a dev-only Astro 7 integration — a visual builder with a chrome over a same-origin iframe canvas for editing Content Collections content and repo-mapped CSS. **Scaffold stage:** toolchain, CI and the e2e fixture are in place; `docs/` remains the source of truth for behavior.

## Read the docs first

- `docs/spec.md` — product spec: user stories, implementation decisions, testing seams
- `docs/stack.md` — technology choices with rationale
- `docs/core-reuse.md` — Astro/Vite core APIs we reuse instead of building

When your work touches an architectural decision, these files win over your priors. If your change contradicts one, surface the conflict explicitly instead of silently overriding.

## Commands

- `bun install` — install dependencies (also in `e2e/fixture/`, which is its own package).
- `bun run check` — Biome lint + format check; `bun run check:write` autofixes.
- `bun run typecheck` — `tsc --noEmit`.
- `bun run test` — unit tests (vitest + happy-dom); `bun run test:watch` for watch mode.
- `bun run test:e2e` — Playwright e2e; boots the fixture dev server on `http://localhost:4314` (npm-pack lane on :4313; the owner's manual smoke owns :4312 — lanes never share servers).
- `bun run build` — tsup (node side) + vite build (the prebuilt chrome bundle `dist/chrome.js`) — chrome delivery is hybrid per `docs/adr/0001` (source-served in our dev checkout, prebuilt for consumers).

Package manager is **bun**. Run bun; never npm/pnpm/yarn.

## Repo layout

- `src/core/` — pure modules (indexer, matcher, splice-writer); no IO, unit-tested over fixtures
- `src/node/` — the integration: Vite plugin, middleware, watcher, REST endpoints (built by tsup → `dist/`)
- `src/client/` — the chrome (React 19, shadow DOM); hybrid delivery per ADR-0001. UI foundation is shadcn on Base UI (`base-nova`): components under `src/client/components/ui/`, imported through `package.json#imports` (`#components/*`, `#lib/*`, `#hooks/*`); theme tokens live in `src/client/chrome.css` — new components come from `bunx shadcn@latest add <name>`. Target module layout per ADR-0002: app shell → `features/<vertical>/` → shared `canvas/` + `editor/` → `components/ui/` → `lib/`.
- `e2e/fixture/` — synthetic Astro 7 project (hero collection + co-located CSS) driven by Playwright; its own package
- `.changeset/` — changesets config; every code PR adds one
- `docs/` — spec, stack, core-reuse: the decision record
- `docs/agents/` — agent-workflow config (issue tracker, triage labels, domain docs)
- `docs/adr/` — architecture decision records; read those touching your area before proposing changes
- `CONTEXT.md` — domain glossary (ubiquitous language); use its terms in issues, tests, proposals
- `.out-of-scope/` — knowledge base of triaged-out requests, with reasons

## Code style (agreed, lands with the scaffold)

- TypeScript strict, ESM-only, `moduleResolution: bundler`
- Biome is canonical for lint + format. Do not introduce eslint/prettier configs.
- React 19 + React Compiler: no manual memoization. TanStack (Form/Query) where applicable; zustand for client-only UI state.
- Plain async/TS. No Effect — decision recorded in `docs/stack.md`.

## Chrome architecture (ADR-0002 — living checklist)

Rationale and trade-offs live in `docs/adr/0002-chrome-module-architecture.md`; this checklist is what every PR is held to, maintained as the layout evolves.

- Imports flow strictly downward: app shell (`app.tsx`, `chrome.tsx`, `entry.tsx`) → `features/<vertical>/` → shared modules (`canvas/`, `editor/`) → `components/ui/` → `lib/`; `src/core` is importable from anywhere except `components/ui/`, which stays domain-deaf. No sideways (feature ↔ feature, shared ↔ shared), no upward, no cycles.
- Vertical UI lands in its feature folder — components + its zustand store + its `api.ts`; a feature never imports another feature.
- Server/watcher-derived data goes through TanStack Query, colocated in the feature's `api.ts`, query keys `['astroix', <resource>, …]`; chrome-only UI state goes zustand (per-feature store; cross-vertical state like `selection` lives in the small app store).
- `components/ui/` is shadcn-generated and domain-deaf — extend by regeneration, never by hand-editing toward domain needs.
- Code with one consumer stays in the feature that needs it; a shared module beyond ui/lib is born only when 2+ verticals need it, and stays as small as its job. `lib/` stays helpers-only.
- One exported component per file, lowercase-dash name matching the component (`rule-list.tsx` ← `RuleList`); extract on multi-use, ~300 lines, or two distinct concerns in one file.

## Testing doctrine

- **Unit (vitest + happy-dom)**: pure modules only. The CSS indexer/matcher and splice-writer are pure functions over fixtures — test behavior (matched rules, output bytes), never index internals.
- **E2E (Playwright)**: the only source of truth for selector-engine behavior (`[data-astro-cid-*]` under the default `attribute` scopedStyleStrategy — `:where(...)` only when configured; verified vs locked astro@7.2.7, wayfinder T2) and full builder loops.
- Author specs by exploring with Playwright MCP locally, then commit deterministic specs for CI.

## PR & release

- Every PR touching code needs a changeset (patch by default).
- Conventional-commit titles (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep PRs surgical: every changed line should trace to the task.

## Boundaries

Always:

- Check `docs/core-reuse.md` before building any mechanism — if Astro/Vite core already provides it, use it.
- Use glossary terms from `CONTEXT.md`.

Ask first:

- Adding dependencies.
- Changing anything recorded in `docs/stack.md` (these are research-backed — bring evidence).

Never:

- Support Astro < 7, Vite < 8, or zod 3. Out of scope by spec; close such issues as wontfix with a pointer to `docs/spec.md`.
- Break the dev-only guarantee: astroix must not exist in production builds.
- Force-push (`main` is protected).
- Weaken, skip, or regenerate tests to make a failing suite pass.

## Gotchas (from core-reuse research)

- Astro dev pages never pass through Vite's HTML middleware: the `transformIndexHtml` plugin hook is useless here — use `server.transformIndexHtml()` inside middleware.
- Astro dev generates no CSS sourcemaps: the static postcss index is the edit-truth.
- Never splice from `convertToTSX` `metaRanges` — positions are in TSX-output space.
- Full trap list: `docs/core-reuse.md`.

## Agent skills

### Review skills

Vendored in `.agents/skills/` (`thermo-nuclear-code-quality-review`, `unslop`): byte-identical upstream copies with provenance and refresh instructions in `.agents/skills/README.md`. Review flows invoke these; the SKILL.md files are never edited in place.

CI runs the advisory AI review on every PR (`.github/workflows/ai-review.yml`, `claude-code-action@v1` on the Z.AI GLM endpoint): thermo-nuclear + unslop applied to the diff, read-and-comment tools only, never auto-commits, never gates the merge; the deterministic gates in `ci.yml` stay the source of truth for merge status.

The agent session working the PR owns the findings on a three-tier scale:

1. Clean run, or mechanical findings only (punctuation, comment fixes, small guards, naming): implement on the same PR, let the review run again, and merge once the deterministic gates are green and the latest run raises nothing untriaged. A finding counts as triaged when it is implemented, or rejected under tier 3.
2. Findings that would reshape the change (behavior redesign, new structure or dependency, anything touching `docs/spec.md`, `docs/stack.md`, `docs/adr/` or a wayfinder decision): stop and hand the finding to the owner instead of deciding alone; if it needs a real decision, it opens as a grilling session or a ticket.
3. A finding the agent rejects gets written reasoning on the PR and stands rejected; the merge is not held for it, because a re-raise carries no memory of the triage. The owner's word on the PR thread settles the dispute in either direction and binds future sessions.

### Issue tracker

Issues live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
