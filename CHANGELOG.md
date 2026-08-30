# @wojciechpiskorz/astroix

## 0.0.16

### Patch Changes

- 149b1dc: e2e settle-then-restore (#114): `restoreEntry` first waits out the auto-write debounce (entry file + data-store quiet together past the ~300ms window) before writing the original bytes back, closing the race where a late debounced write re-dirtied the fixture entry after the restore; the fixture dev script now heals any dirty fixture content (git restore, loud log per file) before the playwright-driven server boots.
- a11c110: Per-lane e2e ports (#120): both Playwright webServers (main fixture, npm-pack lane) read their ports from `ASTROIX_E2E_PORT` / `ASTROIX_E2E_PACK_PORT`, keeping 4314/4313 as canonical CI defaults — parallel local lanes no longer race for, or adopt, a sibling lane's dev server. The pack spec takes its base URL from the shared ports module instead of a hardcoded `:4313`.

## 0.0.15

### Patch Changes

- a7996db: Content tree sidebar + unrouted-entry affordance (#111): the Content list renders entry ids as a collapsible folder tree (folders derived from id path segments, open by default, collapsed state in the content store so it survives tab roundtrips; flat ids stay bare, entries labeled by basename), and entries with zero candidate routes carry a dimmed marker with a "no route renders this entry" tooltip — presentation only, clicks behave exactly as before.

## 0.0.14

### Patch Changes

- ec8fe6f: Chrome URL carries the canvas position (#110): every canvas load mirrors the iframe's path+search into a `?canvas=` param via `history.replaceState` (the builder marker never leaks in), boot with the param wins over deriving the iframe src from the chrome page's own URL — a refresh or shared link re-opens the builder with the canvas where it was, back button untouched.
- 9b334c1: feat: benign route plurality navigates — same-entry candidates pick the most specific route (#109)

## 0.0.13

### Patch Changes

- 68d99d4: Content auto-write loop (#74): drafts serialize to the entry file per pause — frontmatter spliced through the yaml Document API (untouched keys byte-identical, `image()` round-trips), body written below the closing delimiter — behind a ~300ms debounce with the `/edit`-style hash guard (`POST /__astroix/content-write`, 409 → reload from disk + banner), write-echo guards in the form, and core-first `astro:content-changed` freshness.

## 0.0.12

### Patch Changes

- b7a658a: chore: pre-commit hook now blocks on `tsc --noEmit` when the staged set touches `.ts`/`.tsx` (docs/changeset-only commits skip the run); closes the gap where a red typecheck could be committed mid-loop (#99 incident) — `scripts/setup-hooks.mjs` wiring message + AGENTS.md hook description synced

## 0.0.11

### Patch Changes

- 15d2c55: feat: content form generation — zod def-walk (`src/core/form-tree.ts`), `GET /__astroix/content-schema` + `POST /__astroix/content-validate` endpoints, TanStack Form chrome with widget mapping, raw-field YAML fallback and advisory inline validation (never gating); fixture schema grows enum/number/boolean/array/union/nested coverage

## 0.0.10

### Patch Changes

- a2685b4: feat: content list, reactive selection, entry→canvas navigation (#71)
  
  The Content sidebar becomes the collections→entries list with the active entry highlighted. Active entry is set manually (list click — the form opens first) or reactively: every canvas iframe `load` resolves the URL through the core route resolver, quietly regardless of the active tab (no tab yank — the entry is marked when you enter Content). Clicking an entry navigates the canvas when exactly one candidate route exists and the id is held by one collection, verified by forward match after the navigation; ambiguity or a failed verification keeps the form-only fallback. The editor pane now follows the active entry (the seam #72's form takes over).

## 0.0.9

### Patch Changes

- 7b5b094: feat: CM6 markdown body editor + toolbar for the Content vertical (#73)
  
  CodeMirror 6 markdown editor for `entry.body` in the shared `editor/` module, with a bold/heading/link toolbar emitting markdown around the selection. The content pane mounts it on the first body-bearing entry until #72's form owns the pane; the emitted-markdown seam (`onChange`) is what #74's auto-write loop connects. Native Cmd+Z undoes through toolbar and typed transactions.

## 0.0.8

### Patch Changes

- 197afce: Refactor: one `/__astroix` mount with a method+path handler table (same-origin guard enforced once, structurally) and a dedicated routes module out of `content.ts` — dissolves the CC-25 `handleApiRequest` into small handlers (`handleEdit` 9, `dispatchApi` 7, `handleFile` 6; baseline entry dropped). Byte-identical behavior from the chrome (#80).

## 0.0.7

### Patch Changes

- 033c558: Post-#61 grilling rulings (2026-08-29): ADR-0002 records the Base UI dialog-portal consequence (Tailwind resolves in `document.body` via dual sheet adoption; `.dark` token scope does not cross the shadow boundary — re-scope today, `container: ShadowRoot` the supported alternative at a future chrome-level wrapper); CONTEXT.md gains the smoke vocabulary (smoke gate, hint pill, wizard, copy report); the e2e suite guards `SMOKE_STEPS` against drift with `docs/manual-smoke.md` (ids compared in the spec — the unit doctrine stays pure-modules-over-fixtures).

## 0.0.6

### Patch Changes

- b084556: feat: chrome sidebar on the shadcn Sidebar primitive + theme preset b1Z6BvKCW (#81). The hand-rolled aside frame gives way to the generated Sidebar (Base UI variant, offcanvas collapse via rail or cmd/ctrl+b; the primitive writes its state cookie and the shell reads it back on boot, so the state survives reloads; provider row `relative` + sidebar `absolute` keep it below the chrome header; width 18rem preserved). Vertical tabs pin in the sidebar header, bodies render in the scrollable content area — behavior from #70 (activeVertical, dock swap, CSS-scoped select mode) unchanged behind the same data contracts. Theme preset b1Z6BvKCW lands as a value swap of both token blocks; touched shell surfaces (root, dock frame, header) convert from slate utilities to semantic tokens, feature bodies convert when their slices touch them. `workbench row` and `editor dock` join the glossary. New e2e: collapse/expand state preservation (incl. across reload) + theme resolution.
- 63af78d: In-chrome owner smoke checklist (fold-in of the #46 prototype, issue #61): wizard dialog behind a top-level `?astroix_smoke=1` gate — nothing renders without the param. Gated use shows a small hint pill and the `S` shortcut (typing-guarded) summons the wizard: one step per screen over the 8 steps mirrored from `docs/manual-smoke.md`, Back/Next with progress dots, a summary screen, and a Copy report (markdown: header with date/URL/UA, per-step checkboxes with notes, Result line, agent-paste footer). Checklist state is in-memory only. The Base UI dialog portal keeps the `.dark` token re-scope on portal content.

## 0.0.5

### Patch Changes

- 4171a29: Content read endpoints (wayfinder #68): `GET /__astroix/collections` (core-parsed entries via a fresh `runner.import('astro:content')` per request — stateless, no cross-request caching — plus schema presence from the content config) and `GET /__astroix/routes` (the `astro:routes:resolved` hook payload, re-captured on route-change restarts). Raw entry bytes continue through the root-confined `GET /__astroix/file`. E2e fixture grows a `blog` collection with nested-path ids (`2024/post`) and a `/blog/[...slug]` dynamic route.

## 0.0.4

### Patch Changes

- c5fd157: Core route-resolution module — the URL↔entry heuristic bridge (wayfinder #47, issue #69).
  
  - New pure module `src/core/route-resolver.ts`, zero IO: `resolveActiveEntry` (canvas URL → active entry) and `candidateRoutes` (entry id → plausible canvas routes).
  - Input is Astro's own parse, not a re-derived grammar (owner ruling, PR #77): `RouteInfo` carries `pattern` + `segments` (`RoutePart[][] {content, dynamic, spread}`) + `params` from `astro:routes:resolved`; contract: page routes only (the routes payload filters endpoint/redirect/fallback, #68).
  - Doctrine: a unique hit selects — exactly one single-param route pattern matching, entry id held by exactly one collection. Ambiguity (id collision across collections, overlapping patterns resolving to different entries, a static page shadowing the dynamic route), multi-param and embedded-param patterns, or no match — all stay silent; the heuristic never picks wrong, it picks nothing.
  - Rest params carry glob-loader ids (slugified paths: `2024/post.md` → id `2024/post` fits `/blog/[...slug]`).
- 2891ede: feat: chrome shell tabs — `activeVertical` + vertical-scoped select mode (#70). CSS|Content tabs at the top of the sidebar (first use of the shadcn `Tabs`), `activeVertical: 'css' | 'content'` in the app store, and the editor dock slot (shell-owned column frame, uniform width) swaps between the css rule editor and the content placeholder — `features/content/` is born with the two slot stubs that #71 (entries list) and #72 (generated form) fill. Select mode becomes a property of the CSS vertical: off-CSS it stays armed in the store but is suspended on the canvas (overlay stripped, toggle disabled) and restored on return. The ADR-0002 layer list and the AGENTS.md checklist gain `sidebar.tsx` as app shell.

## 0.0.3

### Patch Changes

- 025b42e: Crap4ts risk layer: static CRAP/CC checks wired into the review flow (dev-only tooling, no runtime surface).
  
  - New pure modules: `src/core/complexity.ts` (per-function cyclomatic complexity — oxc-parser engine with a tsc oracle, probe-pinned ESLint-classic counting) and `src/core/crap.ts` (istanbul join, CRAP score, Uncle-Bob bands, baseline-ratchet evaluation).
  - `bun run crap` — full risk report; `bun run preflight` — hard stop over the PR diff scope (CRAP ≥ 30 in src/core, CC ≥ 15 in src/node + src/client); pre-commit hook warns at CC ≥ 10 on staged functions (`bun run hooks` wires it, no hook manager).
  - CI (`ai-review.yml`) recomputes the table from scratch and feeds it to the advisory reviewer prompt; local runs are advisory.
  - Baseline calibrated once (`crap-baseline.json`); from here it only tightens. New devDeps: `oxc-parser`, `@vitest/coverage-v8`.
- 7ba79e4: Advisory GLM review on every PR (thermo-nuclear + unslop prompts through claude-code-action on the Z.AI endpoint). Deterministic gates unchanged.
- 504959f: Review loop protocol in AGENTS.md: three-tier scale for advisory review findings. The agent implements mechanical findings and merges; reshape-level findings stop and escalate to the owner; a rejection stands on written reasoning, and the owner's word on the PR thread settles any dispute.
- 26e4abf: refactor: chrome restructured to the ADR-0002 target layout (#58) — mechanical move, no behavior change. `app.tsx` becomes the thin shell, the css vertical lands in `features/css/` (ChromeHeader, Sidebar, RuleList, EditorPane, RuleEditor + its zustand store + `api.ts` with `useIndexPayload`), the canvas machinery moves to `canvas/`, and `store.ts` shrinks to the cross-vertical app store (selectMode/selection). The CodeMirror primitives (view setup, theme, range effects, `replaceDoc`) move to `editor/codemirror.ts`, and the raw `__astroix/file|edit` fetches move to `editor/api.ts` as-is — the Query conversion stays recorded debt per ADR-0002 Consequences.
- d2d0943: Preflight becomes a full-src ratchet and the generated ui/ tier goes watch-only (owner rulings, issue #62).
  
  - `bun run preflight` now evaluates all of `src/` against the baseline on every run — coverage regressions from test-weakening PRs fail even when no product function is touched; the diff survives only as `[PR touches this file]` annotations and the CI table's in-PR marks.
  - `src/client/components/ui/` (shadcn-generated, regenerated per ADR-0002) is watch-only: rows stay in the report and the CI table (`·gen`), the gate never blocks them (`stop: Infinity`), the baseline can never absorb them.
  - Glossary: `preflight` and `watchlist` rows updated to the ruled semantics.
- 7601671: Experimental release channel: manual `workflow_dispatch` snapshot publishing from CI (`changeset version --snapshot experimental` + `changeset publish --tag experimental --no-git-tag`) in an ephemeral workspace, so `latest` and the changeset queue on `main` stay untouched. Consumers opt in with `@wojciechpiskorz/astroix@experimental`.
- b5ca6dc: Stable release loop: the official `changesets/action` job on push to `main` (#59) — non-empty changeset queue → opens/updates the "Version Packages" PR; empty queue (version PR merged) → build, artifact + manifest gates, publish to `latest`, authenticated by the bypass-2FA `NPM_TOKEN` granular token (#48).
- 3ec30d7: Classic-stack additions (owner-approved 2026-08-28): publint gates the published manifest in CI (`bun run check:publint`, after the artifact check — the exports/types must be consumer-clean), and the pre-commit hook now blocks on staged lint/format errors (`biome check --staged`) before the CC-warn scan. New devDep: publint.
- c49df22: Wire shadcn (Base UI) into the chrome as the UI foundation.
  
  - shadcn `base-nova` (Base UI primitives): `components.json` + `package.json#imports` aliases (`#components/*`, `#lib/*`, `#hooks/*`) resolve identically in tsc, the source-mode dev server and the prebuilt chrome build — no host-side alias wiring.
  - Base component set in `src/client/components/ui/`: button, input, checkbox, select, dialog, tabs.
  - `chrome.css` carries the nova theme tokens (`:root, :host` + `.dark`), `tw-animate-css` and the `shadcn/tailwind.css` base layer; the Geist font import is dropped on purpose — the prebuilt chrome stays one self-contained ESM.
  - Dogfood: the header select toggle is a shadcn Button under the dark theme; e2e now asserts the theme tokens resolve inside the shadow tree.

## 0.0.2

### Patch Changes

- 0358385: Matcher core module (`src/core/matcher.ts`): given index payload records and a clicked canvas element, returns matching rules sorted by CSS specificity with the cascade winner marked (ties keep source order). Scoped rules match only via their effective selectors joined by the REST slice — the matcher never synthesizes cid forms, and scoped records without one (file not loaded on the route) never match. `@media` conditions pass through as badge data; selector-list specificity takes the most specific part; `:where` weighs zero and `:is`/`:not`/`:has` take their most specific argument.
- f707a88: Bidirectional sync (spec #13): the host watcher pushes `astroix:file-changed` over the Vite WebSocket (debounced per file, css/astro under the project src dir), and the chrome refetches — the open CodeMirror editor live-reloads external (IDE) edits when its document is clean, and the index payload refetches on every event. Chrome writes now carry the sha256 of the content they were based on; a disk mismatch answers 409 with the current contents, which the editor reloads ("changed on disk — reloaded") instead of splicing stale offsets into a shifted file. Manual-smoke sheet gains step 6b for the IDE round-trip.
- bd5d977: Rule list panel: on selection, the chrome runs the matcher over the index payload against the canvas element and renders matched rules — source-space selectors (cid hashes never displayed), file and one-based source line (derived in the indexer from the rule range), specificity-sorted with the cascade winner marked, `@media` condition badges (unevaluated), and a multi-place hint when one file styles the element in ≥2 places. Explicit empty state; the payload refetches on selection (the module-graph join can race the canvas page load).
- ae00910: Executable POC definition of done: `e2e/loop.spec.ts` runs the whole CSS editing loop in one deterministic test — default-on chrome → select mode → hover/click → rule list (hidden hash, ≥2 global, media badge, winner) → CodeMirror at the range → raw-text color edit → debounced write → byte-exact disk assertion → canvas reflection via HMR with a no-reload marker → `?builder=0` escape hatch. The owner's manual-smoke scenario lands as `docs/manual-smoke.md`, linked from the README as the human half of the DoD.
- f575f7a: REST endpoints on the Vite connect middleware: `GET /__astroix/index` serves the index payload — edit-truth records joined with compiled scoped selectors from the client module graph (rule-order correlation per style block; absent modules stay listed without an effective selector) — and `POST /__astroix/edit` applies a format-preserving splice to disk (path-confined to the project root, typed range validation). Same-origin enforcement via `sec-fetch-site`.
- 033789d: npm-pack smoke e2e (ADR-0001 consumer lane): a minimal pack fixture consumes the actual `npm pack` tarball; a second Playwright webServer builds, packs and installs it (stable `astroix-pack.tgz` name — no per-run package.json mutation) and boots the fixture on :4313. The spec proves the chrome mounts from the prebuilt bundle (zero `/src/client` requests — source mode structurally impossible) and runs the minimal loop — select → rule list → CodeMirror edit → byte-exact disk change → canvas reflection via HMR.
- 61b6892: `bun run smoke`: one command for the owner's manual-smoke environment — installs root + fixture, builds the package (node dist + chrome bundle), refreshes the fixture's `file:` dependency and boots the dev server on :4312 with pointers to `docs/manual-smoke.md`.
- e963815: CodeMirror 6 editor + write loop: clicking a rule opens a file editor pane (new `GET /__astroix/file` endpoint) scrolled to and highlighting the rule's range, with per-range chips jumping between the places one file styles the selection. Raw-text editing with a ~300 ms debounced auto-write — each pause diffs the document against the last-written snapshot (common prefix/suffix) and sends ONE contiguous edit through the splice endpoint, so everything outside the edit stays byte-identical; host HMR is the live preview and the payload refetches after every write. Playwright config moves to a single worker (specs share one dev server and edit fixture sources — determinism over wall-clock).
- 5f26426: Indexer core module (`src/core/indexer.ts`): scans project CSS sources (global `.css` + `.astro` style blocks) into the edit-truth index — per rule: verbatim source-space selector, file, character range, `@media` condition, scoped flag, and the module-graph style-block index (`null` for `is:inline`, which the compiler never extracts but the edit-truth scan sees).
- 3b1b71b: Prebuilt chrome bundle + package shape (ADR-0001): `vite build` compiles the chrome (`src/client/chrome.tsx`) into a single self-contained ESM at `dist/chrome.js` — react/react-dom, the Tailwind-compiled CSS and CodeMirror bundled inside, zero bare react imports. The virtual chrome module's prebuilt mode serves the real artifact (still failing loudly when a build omitted it); react/react-dom move to devDependencies. `bun run build` produces both outputs; a new `check:artifact` gate (run in CI) verifies the artifact's self-containment and the `npm pack` tarball (dist only, no chrome source).
- 6c89353: Chrome shell: the placeholder becomes a real app — React 19 (Compiler on, Oxc) in a shadow DOM root, header + sidebar + canvas layout, Tailwind 4 delivered per T1 (one constructed stylesheet adopted on both the document and the shadow root; `?inline` import with HMR `replaceSync`). Select mode (zustand, default off): hover outline and click-to-select with a stable descriptor; off restores the canvas untouched. TanStack Query fetches the index payload with a graceful empty state. Source mode now dedupes react/react-dom (the /@fs chrome made the optimizer mount two copies) and joins the checkout root to `server.fs.allow` (HMR re-fetches carry `?t=` which misses the import-chain exemption).
- ad6b1a4: Dogfood wiring: the e2e fixture consumes the local package via `file:../..` and registers `astroix()` in its `astro.config.mjs`; CI builds the package before the Playwright e2e job.
- 6165b5c: Splice-writer core module (`src/core/splice-writer.ts`): `spliceText` replaces a half-open character range with arbitrary text (bytes outside the range stay identical — no reprint), `appendRule` adds a rule at EOF with exactly one new line regardless of the file's trailing-newline convention. Invalid ranges throw a typed `SpliceRangeError` before any output is produced.
- 5a072d3: Environment separation between the owner's smoke and the bot e2e lanes: the main e2e lane moves to `:4314` (fixture dev script parametrized via `ASTROIX_E2E_PORT`, default `4312` stays the owner's smoke port), both Playwright lanes set `reuseExistingServer: false` (no zombie adoption), and `bun run smoke` fails fast with an actionable message when `:4312` is already occupied instead of letting astro fail cryptically.
- 309a6f0: Node integration: default-on builder chrome over every top-level dev URL with the `?builder=0` escape hatch (pre-internal Vite middleware, `server.transformIndexHtml`), the `virtual:astroix/chrome` module with the ADR-0001 mode switch (source mode in the dev checkout; prebuilt fails loudly until shipped), source-mode injections (`@vitejs/plugin-react` include-scoped, `@tailwindcss/vite` with a host double-registration guard), the canvas script hiding Astro's dev toolbar inside the iframe, and a warn-only React-19 guard in the chrome. Non-dev commands register nothing (dev-only guarantee).
- 4b398c9: E2E fixture CSS surface: a scoped `<style>` block on `.hero-title` (the `[data-astro-cid-*]` case), a second same-file rule and an `@media` rule in `home.css` (multi-range and badge cases for the rule list).

## 0.0.1

Initial publish, manual and outside the changesets loop: package scaffold — toolchain (TypeScript strict ESM, Biome, tsup), unit tests (vitest + happy-dom), e2e harness (Playwright + synthetic Astro 7 fixture), CI workflow. Per-PR changesets begin with 0.0.2.
