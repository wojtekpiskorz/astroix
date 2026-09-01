# AGENTS.md

Astroix is being rewritten from a dev-only Astro integration into a **standalone Electron parent app** for registered existing Astro projects — one active project session, zero managed-project injection, web behavioral hosting, unsigned macOS pre-alpha delivery. Authority: map #197 + rewrite charter #203; the architecture decisions live in `docs/adr/0004`–`0010`. The integration-era code still in `src/` is a **retirement-bound migration oracle** (ADR-0010): it is the source for behavior-contract extraction and reusable-core/UI extraction, not the product and not a compatibility contract.

## Read the docs first

- `docs/spec.md` — product spec: boundary, user stories, implementation decisions, testing doctrine
- `docs/stack.md` — technology choices with rationale (npm workspaces + Node 24 are the stack of record)
- `docs/core-reuse.md` — Astro/Vite seams by class: public / certified exact-pair / fail-closed private
- `CONTEXT.md` — the settled vocabulary; use its terms exactly
- `docs/adr/` — decision records 0004–0010 govern the rewrite

When your work touches an architectural decision, these files win over your priors. If your change contradicts one, surface the conflict explicitly instead of silently overriding.

## Rewrite DAG rules

Implementation runs as the chartered 51-ticket native DAG (map #197). Every session owns exactly one issue, one issue-specific worktree branch, and one PR. GitHub native `blocked_by` relations are readiness authority — never start a lane whose blockers are open, never absorb a sibling lane's scope or owned paths, and reconcile the frontier (issues newly unblocked by your merge) at lane close. Findings that outlive your PR become issues before the session ends.

## Commands

The repo runs on npm workspaces + Node 24 (chartered by lane A2, ruling [#190](https://github.com/wojtekpiskorz/astroix/issues/190); the workspaces globs `packages/*`/`apps/*` await the physical moves). **Run npm, never bun/pnpm/yarn**, and Node 24.

- `npm install` — install dependencies (`e2e/fixture/` and `e2e/src-fixture/` stay standalone packages with their own committed lockfiles; `e2e/pack-fixture/` is installed by its staging script).
- `npm run check` — Biome lint + format check; `npm run check:write` autofixes.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — unit tests (vitest + happy-dom); `npm run test:watch` for watch mode.
- `npm run test:e2e` — Playwright e2e against the integration-era fixture lanes (:4314 main, :4313 npm-pack, :4311 src; the owner's manual smoke owns :4312 — lanes never share servers; parallel local lanes override via `ASTROIX_E2E_PORT` / `ASTROIX_E2E_PACK_PORT` / `ASTROIX_E2E_SRC_PORT`). These lanes are migration-oracle assets: they exist until the retirement gate (ADR-0010) deletes them, and the interval after retirement with no product E2E is explicit — CI must not present it as a pass.
- `npm run crap` — crap4ts risk report; `--update-baseline` manages the ratchet baseline after refactoring a pinned function.
- `npm run preflight` — CRAP ratchet (every run evaluates `src/` + `packages/core` + `packages/app-shell` (CC-only watchlist there) against the baseline; owner ruling, issue #62); a future workspace package joins `RISK_ROOTS` in the PR that lands it, together with its coverage-tier decision; the agent runs it before `gh pr create`. Scope and baseline keys move with the physical workspace moves, in the same PR as the move.
- `npm run hooks` — once per clone: wires `git config core.hooksPath scripts/hooks`. Not a postinstall.
- `npm run build` — tsup (node side) + vite build (the prebuilt chrome bundle). Integration-era only: ADR-0001 is superseded and these build surfaces die at the retirement gate.
- `npm run smoke` — the integration-era owner smoke (see `docs/manual-smoke.md` for what replaces it).

## Repo layout

Current (transitional — the migration oracle):

- `packages/core/` — the reusable pure editing-domain modules (collections, entry-writer, form-tree, indexer, matcher, route-resolver, splice-writer); no IO; unit-tested over fixtures. `src/core/` keeps only the CRAP tooling layer (`complexity.ts`, `crap.ts`) plus one-line compatibility re-export shims that die at the retirement gate.
- `src/node/` — the integration (Vite plugin, middleware, watcher, REST endpoints); retirement-bound.
- `src/client/` — the integration chrome (React 19, shadow DOM); retirement-bound. Its foundation now lives in `packages/app-shell/` (domain-deaf: shadcn on Base UI `base-nova` primitives under `packages/app-shell/src/components/ui/`, theme tokens in `packages/app-shell/src/chrome.css`, generic editor infrastructure); regeneration runs from `packages/app-shell/` via its own `components.json` + package-level `imports` map (`#components/*`, `#hooks/*`, `#lib/*`), `npx shadcn@latest add <name>`. The legacy `src/client` paths are one-line compatibility re-export shims (plus `styles.ts`, which consumes the moved css) until the retirement gate. Target layout: ADR-0002 (amended), enforced by the app-shell checklist below.
- `e2e/fixture/` — synthetic Astro 7 project; becomes the canonical plain Astro project (disposable copies serve the remaining oracle runs).
- `docs/` — spec, stack, core-reuse: the decision record; `docs/adr/` the architecture authority; `docs/agents/` agent-workflow config.
- `CONTEXT.md` — domain glossary (ubiquitous language).
- `.changeset/` — changesets config; every code PR adds one **until the retirement lane removes Changesets** (docs-only PRs do not need one).
- `.out-of-scope/` — knowledge base of triaged-out requests, with reasons.

Target (chartered by ADR-0010; lanes create these): `packages/core` · `packages/protocol` · `packages/runtime` (with `ProjectRegistry`, `SessionSupervisor`, `ProjectRuntime`, `EditAuthority` as deep seams inside it) · `packages/app-shell` · `apps/web` (the behavioral test host) · `apps/desktop` (Electron host and packaging) · `e2e/fixture` standalone outside the workspaces.

## Code style

- TypeScript strict, ESM-only, `moduleResolution: bundler`.
- Biome is canonical for lint + format. Do not introduce eslint/prettier configs.
- React 19 + React Compiler: no manual memoization. TanStack (Form/Query) where applicable; zustand for client-only UI state.
- Plain async/TS. No Effect — decision recorded in `docs/stack.md`.
- npm-compatible semver ranges in workspaces, never `workspace:*`.

## App shell architecture (ADR-0002, amended — living checklist)

Rationale and trade-offs live in `docs/adr/0002-chrome-module-architecture.md` (read the Amendments section — the Electron-rewrite deltas are binding); this checklist is what every PR touching retained UI is held to, maintained as the layout evolves.

- Imports flow strictly downward: app shell (`app.tsx`, `sidebar.tsx`, `chrome.tsx`, `entry.tsx` + bootstrap helpers like `react-guard.ts`, `styles.ts`) → `features/<vertical>/` → shared modules (`canvas/`, `editor/`) → `components/ui/` → `lib/`; `src/core`/`packages/core` is importable from anywhere, and the app store (`src/client/store.ts` → `packages/app-shell`) serves every layer except `components/ui/` and `lib/`. No sideways (feature ↔ feature, shared ↔ shared), no upward, no cycles.
- Vertical UI lands in its feature folder — components + its zustand store + its `api.ts`; a feature never imports another feature.
- Server-derived data goes through TanStack Query, colocated in the owning module's `api.ts`, with **generation-scoped query keys** `['astroix', runtimeEpoch, generation, …]` (ADR-0006: the whole cache dies with the session at commit — never key cross-session data without the pair); transport is protocol v1 (`/__astroix/api/v1/` fetch + SSE at `/__astroix/events`), never Vite WS events. Shell-only UI state goes zustand (per-feature store; cross-vertical state like `selection` lives in the small app store).
- `components/ui/` (now physically in `packages/app-shell/src/components/ui/`) is shadcn-generated and domain-deaf — extend by regeneration from the package, never by hand-editing toward domain needs.
- Code with one consumer stays in the feature that needs it; a shared module beyond ui/lib is born only when 2+ verticals need it (a prospective need counts only if the owner rules it does), and stays as small as its job. The **shared edit drain/fence seam** (admission, debounce scheduling, ordering, fencing, draining, conflict reporting, revocation) is the chartered first fire — content serialization and CSS splice planning stay domain-specific inside their features. `lib/` stays helpers-only.
- One exported component per file, lowercase-dash name matching the component (`rule-list.tsx` ← `RuleList`); extract on multi-use, ~300 lines, or two distinct concerns in one file — the line count is a signal, not a gate. One exported component per file applies to domain components; a cohesive primitive/widget set may live in one file named after the set (`*-widgets.tsx`) — the set name, not the count, is the unit.

## Testing doctrine

- **Unit (vitest + happy-dom)**: pure modules only. Indexer/matcher/splice-writer/route-resolution are pure functions over fixtures — test behavior (matched rules, output bytes), never index internals.
- **Web host (Playwright)**: web mode is the deterministic full-behavior test host and the only source of truth for selector-engine behavior (`[data-astro-cid-*]` under the default `attribute` scopedStyleStrategy — `:where(...)` only when configured; certified pair `astro@7.2.10 + vite@8.2.2`) and full builder loops, including A-to-B-to-A switch races, stale-authority rejection, and zero-injection byte/metadata snapshots.
- **Behavior contracts** (ADR-0010): payloads, selector matches, conflicts, and output bytes captured from the integration oracle bind the replacement — a replacement result that drifts from a captured contract is a defect, not a redesign license.
- **Electron**: an early packaged-host smoke precedes vertical work; an instrumented Electron build may test wiring but is never release evidence. Packaged qualification (ADR-0008) runs at candidate checkpoints only.
- On any red e2e run, local or CI: capture the full error output and keep `test-results/` before any cleanup — #129's one unexplained red went undiagnosed because truncation ate the error text.
- Author specs by exploring with Playwright MCP locally, then commit deterministic specs for CI.

## Crap4ts risk layer

Static and deterministic, upstream of the advisory AI review (wayfinder #55). Engine: `src/core/complexity.ts` (per-function CC, ESLint-classic counting pinned by the probe fixtures; oxc-parser primary, tsc oracle asserted equal in tests). Math: `src/core/crap.ts`. CLI: `scripts/crap.mjs`.

- **Metric honesty**: full CRAP (CC² × (1−cov)³ + CC) only where per-function unit coverage is real (`src/core` tooling + `packages/core`); the runtime and shell tiers are a CC-only watchlist.
- **Stops**: preflight is a ratchet — CRAP ≥ 30 (core) / CC ≥ 15 (elsewhere) evaluated over `src/` + `packages/core` + `packages/app-shell` (app-shell a CC-only watchlist, per its coverage-tier decision) against the baseline on every run, so coverage regressions from test-weakening PRs fail too (#62); a new workspace package joins the roots in its landing PR; the pre-commit hook warns at CC ≥ 10 on staged functions and never blocks. The generated `components/ui/` tier is watch-only: rows visible, never gated.
- **Baseline ratchet** (`crap-baseline.json`): calibrated once 2026-08-28; entries only tighten or drop — after refactoring a pinned function, `npm run crap --update-baseline`. New violations fail preflight: refactor them, the baseline never absorbs them. Physical module moves retarget scope and baseline keys in the move PR.
- **CI** recomputes the table from scratch (`npm run crap:ci` in `ai-review.yml`) and feeds it to the advisory reviewer prompt; local runs are advisory.

## PR & release

- Every PR touching code needs a changeset (patch by default) while Changesets exist; docs-only PRs do not.
- Conventional-commit titles (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep PRs surgical: every changed line should trace to the ticket.
- Run `npm run preflight` before `gh pr create` — the CRAP gate is a baseline ratchet over `src/` + `packages/core` + `packages/app-shell`.
- **npm publication is paused by the rewrite** (ADR-0010): do not publish, do not add changesets whose intent is a release, and expect the retirement lane to delete the machinery. Pre-alpha delivery is the packaged artifact path (ADR-0008, `docs/agents/release-loop.md`).

## Parallel sessions & worktrees

Lanes run concurrently — the owner steers several agent sessions at once — so checkout territory is explicit:

- A session that branches works from its own worktree (`git worktree add ../astroix-<issue-or-pr> <branch>`), never by switching the shared main checkout: two sessions ping-ponging one checkout is how commits land on the wrong branch (the `b1d1ee6` incident, PR #88 thread).
- At lane close, the worktree is always removed and the branch deleted. Canonical sequence: exit the worktree first (`git worktree remove` refuses the one you are standing in), remove it, then `gh pr merge <n> --delete-branch` — merge, local + remote delete, and prune in one step. The `changeset-release/*` branch is never deleted while the release loop exists; it belongs to the release loop.
- macOS fallback (`File name too long`, #125): on any lane that installed the fixtures, `git worktree remove` can fail — git's recursive delete chokes on the deep `node_modules` nesting. Recover with `rm -rf ../astroix-<lane>` + `git worktree prune`; the worktree must be gone before `gh pr merge --delete-branch` (its local branch delete also fails while the worktree exists — git never deletes a checked-out branch; that refusal is universal, not the macOS long-path failure), so if the merge already ran, finish with `git branch -D <branch>`.

## Boundaries

Always:

- Check `docs/core-reuse.md` before building any mechanism — if Astro/Vite core provides it within a usable seam class, use it; private seams go through `AstroProjectAdapter` and fail closed.
- Use glossary terms from `CONTEXT.md`.

Ask first:

- Adding dependencies.
- Changing anything recorded in `docs/stack.md` or an accepted ADR (these are research- or ruling-backed — bring evidence or a ruling).

Never:

- Support Astro < 7, Vite < 8, or zod 3. Out of scope by spec; close such issues as wontfix with a pointer to `docs/spec.md`.
- Break the **zero-injection guarantee**: nothing of Astroix — dependency, integration, bridge, config or manifest mutation, control file — ever enters a managed project, and Astroix never exists in a managed project's production build.
- Present Astroix as a public npm package or integration: the integration is retired (ADR-0010); publication is paused; treat such issues as wontfix with a pointer to `docs/spec.md`.
- Invest in mobile or narrow-viewport shell affordances — the app shell is desktop-only per `docs/adr/0003-chrome-viewport-scope-desktop-only.md` (reaffirmed); revisiting that is an owner ruling, not a PR decision.
- Force-push (`main` is protected).
- Weaken, skip, or regenerate tests to make a failing suite pass.

## Gotchas (from core-reuse research — binding subset)

- Astro dev generates no CSS sourcemaps: the static postcss index is the edit-truth.
- Never splice from `convertToTSX` `metaRanges` — positions are in TSX-output space.
- Always close fresh module runners in `finally` — an unclosed runner leaks a hot-channel listener and the evaluated module graph.
- Unknown `virtual:astro:*` / internal shapes fail closed — never heuristically parse drifted output; a seam drift is a compatibility event.
- Duplicate project hook execution is accepted pre-alpha behavior, not a bug to "fix" by falling back to `configFile: false`.
- Full trap list: `docs/core-reuse.md`.

## Agent skills

### Review skills

Vendored in `.agents/skills/` (`thermo-nuclear-code-quality-review`, `unslop`): byte-identical upstream copies with provenance and refresh instructions in `.agents/skills/README.md`. Review flows invoke these; the SKILL.md files are never edited in place.

CI runs the advisory AI review on every PR (`.github/workflows/ai-review.yml`, `claude-code-action@v1` on the Z.AI GLM endpoint): thermo-nuclear + unslop applied to the diff, read-and-comment tools only, never auto-commits, never gates the merge; the deterministic gates in `ci.yml` stay the source of truth for merge status. Skips: drafts, forks, and the changesets-generated Version Packages PR (`changeset-release/*`).

The agent session working the PR owns the findings on a three-tier scale:

1. Clean run, or mechanical findings only (punctuation, comment fixes, small guards, naming): implement on the same PR, let the review run again, and merge once the deterministic gates are green and the latest run raises nothing untriaged. A finding counts as triaged when it is implemented, or rejected under tier 3.
2. Findings that would reshape the change (behavior redesign, new structure or dependency, anything touching `docs/spec.md`, `docs/stack.md`, `docs/adr/` or a ruling decision): stop and hand the finding to the owner instead of deciding alone; if it needs a real decision, it opens as a grilling session or a ticket.
3. A finding the agent rejects gets written reasoning on the PR and stands rejected; the merge is not held for it — the advisory review never gates. Review rounds read the PR thread (`ai-review.yml`), so the written reasoning carries into later rounds; a settled finding surfacing again is a prompt defect to fix, never a merge blocker. The owner's word on the PR thread settles the dispute in either direction and binds future sessions.

### Issue tracker

Issues live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

Lane close-out files its findings as issues before the session ends. See "Lane close-out" in `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
