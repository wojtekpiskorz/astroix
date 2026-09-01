# Astroix — Stack

Technology decisions of record for the Electron parent-app rewrite (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210), 2026-09-01). Each retained decision keeps its research or product rationale; each replaced decision names its ruling. Governing rulings: runtime/packaging [#207](https://github.com/wojtekpiskorz/astroix/issues/207), migration/toolchain [#190](https://github.com/wojtekpiskorz/astroix/issues/190) + [#200](https://github.com/wojtekpiskorz/astroix/issues/200), runtime topology [#202](https://github.com/wojtekpiskorz/astroix/issues/202), protocol [#204](https://github.com/wojtekpiskorz/astroix/issues/204). Standing rule from the core-reuse research: **if Astro/Vite core already provides it, we do not build it** — inventory by seam class in `docs/core-reuse.md`.

Transitional note: until the isolated npm-migration lane (charter A2) merges, the repository still runs on bun (`package.json` pins `bun@1.3.14`) and still has the integration-era one-package layout. That is a migration state, not a decision; **npm workspaces + Node 24 are the stack of record** from this document on.

---

## Summary

| Layer | Choice |
| --- | --- |
| PM / runner | **npm** (workspaces), never bun/pnpm/yarn — chartered by [#190](https://github.com/wojtekpiskorz/astroix/issues/190), landed by charter lane A2 |
| Runtime / tooling floor | **Node 24 LTS** for all new repository tooling and runtime packages (bundled stock Node `24.20.0` in the artifact; per-pin lease requalification per [#209](https://github.com/wojtekpiskorz/astroix/issues/209)) |
| Repo shape | **npm workspaces, deployment-oriented**: `packages/core` · `packages/protocol` · `packages/runtime` · `packages/app-shell` · `apps/web` · `apps/desktop`; `e2e/fixture` a standalone plain Astro project outside the workspaces |
| Workspace ranges | npm-compatible semver ranges, **never `workspace:*`** ([#200](https://github.com/wojtekpiskorz/astroix/issues/200)) |
| Desktop host | **Electron 44.1.0**, packaged by exact-pinned **Electron Forge 7.11.2** (Packager + Fuses plugin + ZIP maker) — ADR-0008 |
| Language / package format | **TypeScript strict, ESM-only**, `moduleResolution: bundler` |
| Deep runtime seams | `ProjectRegistry` · `SessionSupervisor` · `ProjectRuntime` · `EditAuthority` inside `packages/runtime` — deep modules, not packages ([#200](https://github.com/wojtekpiskorz/astroix/issues/200)) |
| Kernel leases | stock Node `node:sqlite` `DatabaseSync` (`allowExtension: false`, `BEGIN IMMEDIATE`, lifetime-held) on two fixed files — [#209](https://github.com/wojtekpiskorz/astroix/issues/209) |
| UI app shell | **React 19 + React Compiler**, `createRoot(shadowRoot)` |
| Styling | **Tailwind 4 + shadcn/ui on Base UI primitives** (`base-nova`), shadcn themes |
| Forms | **TanStack Form** (+ zod) |
| Data / shell state | **TanStack Query** (keys `['astroix', runtimeEpoch, generation, …]`) + **zustand** (UI state) |
| Transport | **`/__astroix/api/v1/` (fetch, JSON) + same-origin SSE at `/__astroix/events`**; Vite HMR the only transparent WebSocket — protocol v1, [#204](https://github.com/wojtekpiskorz/astroix/issues/204) |
| Editors | **CodeMirror 6** (markdown, raw CSS) |
| CSS parsing | **postcss** (plain CSS) |
| Frontmatter | **`yaml` Document API** (format-preserving) |
| Unit tests | **vitest + happy-dom** |
| E2E | **@playwright/test** (CI, source of truth, against the web host) + **Playwright MCP** (locally) |
| Lint/format | **Biome** |
| Publication | **paused** — npm dormant through the rewrite; pre-alpha delivery is a checksummed unsigned macOS ZIP via GitHub draft releases (ADR-0008); Changesets live only until the retirement lane deletes them (ADR-0010) |
| Effect | **rejected** (rationale below) |

## Decisions and rationale

1. **npm workspaces + Node 24 replace bun + one package.** Ruled by [#190](https://github.com/wojtekpiskorz/astroix/issues/190) (toolchain research) and [#200](https://github.com/wojtekpiskorz/astroix/issues/200) (migration strategy). The integration-era "one package until a second consumer" assumption dies with the public package: the product is a standalone app, so the repo is split along deployment seams from the rewrite on. Bun is not the runner of record; the migration lane converts locks, scripts, hooks, CI, and fixture commands in isolation while the current integration stays green. New tooling and runtime packages require Node 24 LTS. Workspace dependency ranges are npm-compatible semver — `workspace:*` is banned. The retired integration keeps its existing engine metadata only until retirement.

2. **Deployment-oriented workspace ownership** ([#200](https://github.com/wojtekpiskorz/astroix/issues/200)): `packages/core` (pure editing-domain behavior), `packages/protocol` (closed wire schemas, `SessionRef`, envelopes, limits, query-key rules), `packages/runtime` (control plane and project plane entry points; `ProjectRegistry`, `SessionSupervisor`, `ProjectRuntime`, `EditAuthority` as deep module seams inside it — none becomes its own package), `packages/app-shell` (renderer UI), `apps/web` (diagnostic and Playwright host), `apps/desktop` (Electron host and packaging). `e2e/fixture` becomes the sole tracked plain Astro project, outside the workspaces; remaining integration-oracle runs use disposable copies. A physical move updates TypeScript, Vitest, coverage, CRAP scope, baseline keys, builds, and CI in the same PR — test counts recorded before and after, and no command may hide a missing workspace with `--if-present`.

3. **Electron 44.1.0 + Forge 7.11.2, stock Node 24.20.0 bundled** ([#207](https://github.com/wojtekpiskorz/astroix/issues/207), ADR-0008): one macOS `arm64` artifact, minimum macOS 13.5 (the official Node 24 floor). Control-plane and project-plane processes execute with bundled stock Node, never Electron-as-Node (`runAsNode` fuse disabled in release). A dependency that cannot run under the bundled runtime fails before activation with a clear diagnostic and no managed-project mutation — no developer-Node, `nvm`/`fnm`, shell discovery, Rosetta, first-run download, or native-rebuild fallback. Every pin change requires packaged requalification.

4. **React 19 + Compiler** (retained): lowest risk, deepest ecosystem. The decisive product argument stays: the Content vertical is a fully dynamic form generator over zod schemas, and React has the deepest form ecosystem (TanStack Form + shadcn). Compiler removes memo ceremony. Shadow DOM via `createRoot(shadowRoot)` remains the documented pattern. Solid 2.0 and Svelte 5 remain rejected on the original facts.

5. **Tailwind 4 + shadcn on Base UI** (retained): StyleX stays rejected (maintainer-discouraged in shadow DOM, pre-1.0, thin agent fluency). The verified zero-build shadow-DOM mechanism carries over to the app shell: single constructed stylesheet adopted on both `document` and `shadowRoot` (`@property` requires it), `:root, :host` emitted upstream, entry CSS with `@import "tailwindcss" source(none); @source "./"` (auto-detection would scan `node_modules`).

6. **TanStack everywhere it fits** (retained): Form for dynamic zod-first fields; Query for server-derived state with declarative invalidation — now keyed `['astroix', runtimeEpoch, generation, …]` and reset wholesale at session commit; Router still no (the app shell is a panel, not a navigation app). zustand for client-only state (selection, tabs, modes).

7. **Protocol v1 transport: fetch + SSE, not Vite WS custom events** ([#204](https://github.com/wojtekpiskorz/astroix/issues/204)): the integration rode the host's Vite WebSocket (`server.ws.send('astroix:…')`) — that channel dies with the in-project integration. The app shell talks to the control plane over `/__astroix/api/v1/` request/response and same-origin SSE at `/__astroix/events`; server-to-renderer events are revisioned invalidations and structured diagnostics. Vite HMR remains a separate, transparently proxied WebSocket. Own WebSocket: still rejected — bidirectionality nobody needs.

8. **vitest + happy-dom (unit), Playwright (truth), Playwright MCP (interactive)** (retained): no agent tool replaces `@playwright/test` in CI. The web host (`apps/web`) is the deterministic full-behavior surface. Electron wiring may use a separately marked instrumented build, never release evidence (ADR-0008).

9. **Biome** (retained): one tool for formatter + lint, TS-first, instant — a feature for agentic iteration. No eslint/prettier configs.

10. **Effect: no** (retained rejection): v4 was in RC with the wrong project shape (~90% pure functions and UI); models write excellent plain async/TS and lottery-quality Effect. Small own `Result` in core if needed.

11. **CodeMirror 6** (markdown + raw CSS), **postcss** (plain CSS), **`yaml` Document API** (format-preserving frontmatter) — all retained, same rationale: modular editing, pure-CSS parsing, comment/order/quoting-preserving serialization consistent with the splice philosophy.

12. **Publication paused; delivery is a packaged artifact.** npm stable and snapshot publication pause in the npm lane (A2) and stay paused: the desktop app gets the private `@wojciechpiskorz/astroix@0.1.0` manifest when its workspace is created; npm stays dormant. Pre-alpha delivery is a tagged, checksummed (SHA-256) unsigned ZIP through access-limited GitHub draft releases — smoke-before-publish on the exact candidate bytes, never a post-smoke rebuild (ADR-0008). Changesets remain only until the retirement lane removes Changesets, publint, npm artifact staging, the integration release workflows, and the obsolete release instructions (ADR-0010).

## Rejected alternatives (current)

- **bun** — replaced by npm per [#190](https://github.com/wojtekpiskorz/astroix/issues/190); the checkout migrates in the isolated A2 lane.
- **One-package repo** — replaced by deployment-shaped npm workspaces per [#200](https://github.com/wojtekpiskorz/astroix/issues/200).
- **Electron `runAsNode` / `ELECTRON_RUN_AS_NODE`** — proof-only; binds execution to Electron fuse/ABI/BoringSSL behavior; rejected for the artifact ([#201](https://github.com/wojtekpiskorz/astroix/issues/201), [#207](https://github.com/wojtekpiskorz/astroix/issues/207)).
- **Custom Node selection / runtime managers / first-run downloads** — rejected by the packaged-runtime boundary ([#207](https://github.com/wojtekpiskorz/astroix/issues/207)).
- **`workspace:*` ranges** — npm-incompatible; banned ([#200](https://github.com/wojtekpiskorz/astroix/issues/200)).
- **Solid 2 / Svelte 5 / StyleX / Effect v4 / own WebSocket / jsdom / Monaco / gray-matter** — rejected on the original facts (above and in git-history stack revisions).

Historical rejections with their full rationale (Solid 2 RC-ecosystem, StyleX shadow-DOM discouragement, Effect RC, etc.) remain provenance in git history; the conclusions that still bind are restated above.
