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
- `bun run test:e2e` — Playwright e2e; boots the fixture dev server on `http://localhost:4314` (npm-pack lane on :4313; source-mode lane on :4311; the owner's manual smoke owns :4312 — lanes never share servers). Parallel local lanes override the trio via `ASTROIX_E2E_PORT` / `ASTROIX_E2E_PACK_PORT` / `ASTROIX_E2E_SRC_PORT` (#120); 4314/4313/4311 stay canonical for CI.
- `bun run crap` — crap4ts risk report: CC per function, CRAP + Uncle-Bob bands where coverage is real (src/core); `--calibrate` (one-time, already done) / `--update-baseline` manage the ratchet baseline.
- `bun run preflight` — full-src CRAP ratchet (every run evaluates all of src/ against the baseline; owner ruling, issue #62); the agent runs it before `gh pr create`.
- `bun run hooks` — once per clone: wires `git config core.hooksPath scripts/hooks` (pre-commit: biome blocks on staged lint/format errors; the typecheck blocks when the staged set touches `.ts`/`.tsx`; the crap4ts CC scan warns). Not a postinstall on purpose — this package is published and must not touch consumers' git config.
- `bun run check:publint` — publint over the published manifest (needs `bun run build`; CI gates it after the artifact check).
- `bun run build` — tsup (node side) + vite build (the prebuilt chrome bundle `dist/chrome.js`) — chrome delivery is hybrid per `docs/adr/0001` (source-served in our dev checkout, prebuilt for consumers).

Package manager is **bun**. Run bun; never npm/pnpm/yarn.

## Repo layout

- `src/core/` — pure modules (indexer, matcher, splice-writer); no IO, unit-tested over fixtures
- `src/node/` — the integration: Vite plugin, middleware, watcher, REST endpoints (built by tsup → `dist/`)
- `src/client/` — the chrome (React 19, shadow DOM); hybrid delivery per ADR-0001. UI foundation is shadcn on Base UI (`base-nova`): components under `src/client/components/ui/`, imported through `package.json#imports` (`#components/*`, `#lib/*`, `#hooks/*`); theme tokens live in `src/client/chrome.css` — new components come from `bunx shadcn@latest add <name>`. Target module layout: ADR-0002, enforced by the Chrome architecture checklist below.
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

- Imports flow strictly downward: app shell (`app.tsx`, `sidebar.tsx`, `chrome.tsx`, `entry.tsx` + bootstrap helpers like `react-guard.ts`, `styles.ts`) → `features/<vertical>/` → shared modules (`canvas/`, `editor/`) → `components/ui/` → `lib/`; `src/core` is importable from anywhere, and the app store (`src/client/store.ts`) serves every layer except `components/ui/` and `lib/`. No sideways (feature ↔ feature, shared ↔ shared), no upward, no cycles.
- Vertical UI lands in its feature folder — components + its zustand store + its `api.ts`; a feature never imports another feature.
- Server/watcher-derived data goes through TanStack Query, colocated in the owning module's `api.ts` (feature or shared — `editor/` owns its own file hooks), query keys `['astroix', <resource>, …]`; chrome-only UI state goes zustand (per-feature store; cross-vertical state like `selection` lives in the small app store at `src/client/store.ts`, importable from anywhere like `src/core`).
- `components/ui/` is shadcn-generated and domain-deaf — extend by regeneration, never by hand-editing toward domain needs.
- Code with one consumer stays in the feature that needs it; a shared module beyond ui/lib is born only when 2+ verticals need it (a prospective need counts only if the owner rules it does), and stays as small as its job — first fire: `editor/write-status-badge.tsx` (WriteStatusBadge + WriteStatus) at the auto-write second consumer (#74, PR #107); the write loops stay feature-local. `lib/` stays helpers-only.
- One exported component per file, lowercase-dash name matching the component (`rule-list.tsx` ← `RuleList`); extract on multi-use, ~300 lines, or two distinct concerns in one file — the line count is a signal, not a gate. One exported component per file applies to domain components; a cohesive primitive/widget set may live in one file named after the set (`*-widgets.tsx`, e.g. `value-widgets.tsx`, `field-widgets.tsx`) — the set name, not the count, is the unit.

## Testing doctrine

- **Unit (vitest + happy-dom)**: pure modules only. The CSS indexer/matcher and splice-writer are pure functions over fixtures — test behavior (matched rules, output bytes), never index internals.
- **E2E (Playwright)**: the only source of truth for selector-engine behavior (`[data-astro-cid-*]` under the default `attribute` scopedStyleStrategy — `:where(...)` only when configured; verified vs locked astro@7.2.7, wayfinder T2) and full builder loops.
- On any red e2e run, local or CI: capture the full error output and keep `test-results/` before any cleanup — #129's one unexplained red went undiagnosed because truncation ate the error text.
- Author specs by exploring with Playwright MCP locally, then commit deterministic specs for CI.

## Crap4ts risk layer

Static and deterministic, upstream of the advisory AI review (wayfinder #55). Engine: `src/core/complexity.ts` (per-function CC, ESLint-classic counting pinned by the probe fixtures; oxc-parser primary, tsc oracle asserted equal in tests). Math: `src/core/crap.ts`. CLI: `scripts/crap.mjs`.

- **Metric honesty**: full CRAP (CC² × (1−cov)³ + CC) only in `src/core`, where per-function unit coverage is real; `src/node` + `src/client` are a CC-only watchlist.
- **Stops**: preflight is a full-src ratchet — CRAP ≥ 30 (src/core) / CC ≥ 15 (src/node + src/client) evaluated over all of src/ against the baseline on every run, so coverage regressions from test-weakening PRs fail too (#62); the pre-commit hook warns at CC ≥ 10 on staged functions and never blocks. The generated `src/client/components/ui/` tier is watch-only: rows visible, never gated.
- **Baseline ratchet** (`crap-baseline.json`): calibrated once 2026-08-28; entries only tighten or drop — after refactoring a pinned function, `bun run crap --update-baseline`. New violations fail preflight: refactor them, the baseline never absorbs them.
- **CI** recomputes the table from scratch (`bun run crap:ci` in `ai-review.yml`) and feeds it to the advisory reviewer prompt; local runs are advisory.

## PR & release

- Every PR touching code needs a changeset (patch by default).
- Conventional-commit titles (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep PRs surgical: every changed line should trace to the task.
- Run `bun run preflight` before `gh pr create` — the CRAP gate is a full-src baseline ratchet.
- Release-loop ops for agent sessions (approve ritual, merge conventions, brownout ladder, publish verification) live in `docs/agents/release-loop.md`.

## Parallel sessions & worktrees

Lanes run concurrently — the owner steers several agent sessions at once — so checkout territory is explicit:

- A session that branches works from its own worktree (`git worktree add ../astroix-<issue-or-pr> <branch>`), never by switching the shared main checkout: two sessions ping-ponging one checkout is how commits land on the wrong branch (the `b1d1ee6` incident, PR #88 thread).
- At lane close, the worktree is always removed and the branch deleted. Canonical sequence: exit the worktree first (`git worktree remove` refuses the one you are standing in), remove it, then `gh pr merge <n> --delete-branch` — merge, local + remote delete, and prune in one step. The `changeset-release/*` branch is never deleted; it belongs to the release loop.
- macOS fallback (`File name too long`, #125): on any lane that installed the fixtures, `git worktree remove` can fail — git's recursive delete chokes on the deep `node_modules` nesting. Recover with `rm -rf ../astroix-<lane>` + `git worktree prune`; the worktree must be gone before `gh pr merge --delete-branch` (its local branch delete also fails while the worktree exists — git never deletes a checked-out branch; that refusal is universal, not the macOS long-path failure), so if the merge already ran, finish with `git branch -D <branch>`.

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
- Invest in mobile or narrow-viewport chrome affordances — the chrome is desktop-only per `docs/adr/0003-chrome-viewport-scope-desktop-only.md`; revisiting that is an owner ruling, not a PR decision.
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

CI runs the advisory AI review on every PR (`.github/workflows/ai-review.yml`, `claude-code-action@v1` on the Z.AI GLM endpoint): thermo-nuclear + unslop applied to the diff, read-and-comment tools only, never auto-commits, never gates the merge; the deterministic gates in `ci.yml` stay the source of truth for merge status. Skips: drafts, forks, and the changesets-generated Version Packages PR (`changeset-release/*`).

The agent session working the PR owns the findings on a three-tier scale:

1. Clean run, or mechanical findings only (punctuation, comment fixes, small guards, naming): implement on the same PR, let the review run again, and merge once the deterministic gates are green and the latest run raises nothing untriaged. A finding counts as triaged when it is implemented, or rejected under tier 3.
2. Findings that would reshape the change (behavior redesign, new structure or dependency, anything touching `docs/spec.md`, `docs/stack.md`, `docs/adr/` or a wayfinder decision): stop and hand the finding to the owner instead of deciding alone; if it needs a real decision, it opens as a grilling session or a ticket.
3. A finding the agent rejects gets written reasoning on the PR and stands rejected; the merge is not held for it — the advisory review never gates. Review rounds read the PR thread (`ai-review.yml`), so the written reasoning carries into later rounds; a settled finding surfacing again is a prompt defect to fix, never a merge blocker. The owner's word on the PR thread settles the dispute in either direction and binds future sessions.

### Issue tracker

Issues live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

Lane close-out files its findings as issues before the session ends. See "Lane close-out" in `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
