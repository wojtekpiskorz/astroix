# Additive migration and integration retirement

Status: accepted (2026-09-01, [Grilling: ratify the additive migration and cutover strategy](https://github.com/wojtekpiskorz/astroix/issues/200) as scheduling-superseded by the final charter [Grilling: charter atomic rewrite lanes through the Electron pre-alpha](https://github.com/wojtekpiskorz/astroix/issues/203); recorded by lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210))

## Context

Astroix pivoted before a user-facing release, so the in-project integration is not a supported legacy product, compatibility target, or permanent migration workspace — but it still holds the only executable proof of the editing behavior the rewrite must preserve. The migration had to extract that value before deleting the integration, without a side-by-side parity cutover and without deleting early.

## Decision

### Migration premise

The integration's remaining value is temporary evidence. Before deletion, the rewrite extracts:

- reusable Content, route, CSS, matching, and writer modules with their tests;
- explicit **behavior contracts** for payloads, selector matches, conflicts, and output bytes;
- the reusable UI primitives, theme, editor widgets, and pure presentation code;
- one canonical plain Astro fixture.

After the **retirement gate**, the integration runtime and its executable delivery lanes disappear **before** the replacement runtime is implemented. There is no side-by-side parity cutover. Git history remains provenance.

### Repository and runtime rulings

- The first implementation lane rewrites the normative specification, stack, core-reuse record, glossary, and required ADRs (this ADR set; lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210)).
- Bun-to-npm migration is isolated from workspace and source moves. New repository tooling and runtime packages require **Node 24 LTS**; the retired integration keeps its existing engine metadata only until retirement.
- npm workspaces use npm-compatible semver ranges, never `workspace:*`.
- A physical move updates TypeScript, Vitest, coverage, CRAP scope, baseline keys, builds, and CI in the same PR; test counts are recorded before and after; no command may hide a missing workspace with `--if-present`.
- `e2e/fixture` becomes the sole tracked plain Astro project; remaining integration-oracle runs use disposable copies with test-owned integration configuration, so the canonical project stays injection-free.
- Stable and snapshot **npm publication pauses** in the npm lane. Changesets remain only until the retirement lane, which then removes Changesets, publint, npm artifact staging, the integration release workflows, and the obsolete release instructions.
- The desktop app receives the private `@wojciechpiskorz/astroix@0.1.0` manifest when its workspace is created. Pre-alpha delivery is a tagged, checksummed unsigned app artifact through GitHub (ADR-0008); npm stays dormant.
- Electron lands after the runtime, session, proxy, app-shell, and canvas foundation, but before the Content and CSS verticals. Web mode remains the full behavioral test host.
- CSS precedes Content in the default schedule because it exercises the highest-risk joined contract (real Astro output, scoped selectors, same-origin DOM matching, grant-bound byte writes, HMR) — superseded as a hard ordering only after both verticals' shared contracts and the early packaged-host smoke are complete (charter [#203](https://github.com/wojtekpiskorz/astroix/issues/203)).

### Workspace ownership

Deployment-oriented: `packages/core` (pure editing-domain behavior), `packages/protocol` (closed wire schemas and shared client/server types), `packages/runtime` (control-plane and project-plane entry points plus internal modules), `packages/app-shell` (renderer UI), `apps/web` (diagnostic and Playwright host), `apps/desktop` (Electron host and packaging), `e2e/fixture` (standalone plain Astro project outside the workspaces). `ProjectRegistry`, `SessionSupervisor`, `ProjectRuntime`, and `EditAuthority` are deep module seams inside `packages/runtime` — none becomes a package.

### Gate meanings

- **Retirement gate**: deletion is permitted only after reusable behavior and UI value have moved, the canonical fixture is plain, quality gates cover the new paths, and all remaining tests are non-empty. The gate deletes the integration runtime, injected chrome, the remaining old client, the delivery lanes (including ADR-0001's three e2e lanes), staging scripts, npm artifact checks, Changesets, publishing workflows, and old release-loop instructions; the root becomes private.
- **No-E2E interval**: between retirement and the first web-host slice there is explicitly no product E2E lane; CI states that and never presents the interval as a passing E2E.
- **Web checkpoint**: the complete replacement is proved against the extracted behavior contracts (behavior contracts, security negatives, zero injection, repeated switching, deterministic cleanup).
- **Pre-alpha qualification gate**: the packaged Electron host — Service Worker bypass, native lifecycle, security controls, cleanup — plus the final manual smoke (ADR-0008; `docs/manual-smoke.md`).

### Execution order

The original 33-lane sequence is architectural provenance and a content-preservation constraint: the final charter's 51-ticket native dependency DAG ([#203](https://github.com/wojtekpiskorz/astroix/issues/203)) is execution authority, preserving every lane's contents and every gate above while superseding only global-serial execution, the one-active-ticket-across-the-program rule, and CSS-before-Content as a hard post-contract dependency. Each session owns exactly one issue, one issue-specific worktree branch, and one PR; any number of unassigned issues with zero open native blockers may run concurrently, subject to declared path ownership and shared-seam restrictions.

## Consequences

- The integration-era documentation, ADR authority, README, smoke guide, and release guidance were rewritten by the first executable lane (this ADR set, `docs/spec.md`, `docs/stack.md`, `docs/core-reuse.md`, `CONTEXT.md`, `AGENTS.md`, `README.md`, `docs/manual-smoke.md`, `docs/agents/release-loop.md`); no normative document presents Astroix as a public npm integration.
- Historical release notes stay untouched as provenance; the npm publish machinery's fate is decided by the migration tickets (A2 pauses publication mechanically; the retirement lane deletes the machinery).
- ADR-0001 is superseded (its delivery lanes die at the retirement gate); ADR-0002 survives amended for the retained app-shell UI; ADR-0003 is reaffirmed.
