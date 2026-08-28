# Chrome module architecture: layered verticals with one-way imports

Status: accepted (2026-08-28, wayfinder #45 · map #39)

The chrome grew as a POC flat layout, and that was fine while there was one vertical. `app.tsx` held five components, `editor.tsx` held two, plus one global zustand store. v1 has two (CSS tab + Content tab), and a third tab would double `app.tsx` again. This ADR fixes the target module architecture so every PR moves toward it instead of accumulating accidents. The owner settled this in a grilling session after the shadcn wiring (#44), so the ADR describes a layout the codebase can actually reach.

## The layers

A module may import only from modules strictly below it — downward only, no sideways, no upward, no cycles. `src/core` is importable from anywhere (pure domain, no IO).

1. **App shell** — `app.tsx`, `chrome.tsx`, `entry.tsx`: bootstrap, layout, tab composition, the editor dock slot. Thin; composes features, owns no vertical logic.
2. **`features/<vertical>/`** — one folder per vertical: `features/css/` first, `features/content/` next. Inside: the vertical's components, its zustand store, and its `api.ts`. A feature is self-sufficient: everything it needs travels through its folder or the layers below.
3. **Shared infrastructure modules** — `canvas/` (iframe, select mode, hover/selection overlay, the re-matching effect after reindex) and `editor/` (CodeMirror infrastructure: view setup, themes, range effects, programmatic doc modeling — primitives up to composed components). Both serve multiple verticals; both are domain-aware but vertical-agnostic.
4. **`components/ui/`** — shadcn primitives, CLI-generated, domain-deaf: no imports from features, stores, shared modules, or core. Changed by regeneration, never hand-edited toward domain needs.
5. **`lib/`** — shared pure helpers (`cn` today).

Sideways imports are forbidden at every level: features never import each other; shared modules never import each other (if `canvas` ever needs `editor`, the shared piece drops to `lib/` or a module is promoted). Code with one consumer stays in the feature that needs it; a shared module is born only when 2+ verticals need it — whatever it shares, UI or otherwise — and stays as small as its job. `lib/` stays helpers-only.

## State

Two state systems with a one-line rule: **server/watcher-derived data is TanStack Query; chrome-only UI state is zustand.**

- **zustand, per concern**: a small app-level store holds cross-vertical state — `selectMode`, `selection`, (the active tab once tabs land). Each feature owns its store (`EditorSpec` and open/close live in the css store; the future content store holds the open entry, dirty form state, …). Selection is zustand, not Query, because it holds a live DOM element, not data — and it sits app-level because canvas, sidebar, and editors consume it in both verticals. The re-matching effect after reindex lives in `canvas/` and writes the new selection into the app store.
- **TanStack Query, colocated**: query hooks live in the feature's `api.ts` (`features/css/api.ts` will hold `useIndexPayload`, moved out of `app.tsx` by the restructure; `features/content/api.ts` will export `useEntries`, `useSaveEntry`, …). Query keys are namespaced `['astroix', <resource>, ...]` as today. Mutations follow the same colocated pattern.

## Files

One exported component per file, filename lowercase-dash matching the component (`rule-list.tsx` ← `RuleList`) — consistent with the shadcn `ui/` and the existing style. Private helpers stay next to their component; helpers used across modules go to `lib/`. A file earns extraction when any of these holds: its component is used by 2+ parents, it passes ~300 lines, or it carries two distinct concerns. The number is a signal, not a gate — a cohesive 320-line file stays; a 200-line file holding two concerns splits.

## Considered Options

- **Flat layout as-is** (`app.tsx` + siblings): rejected — `App` doubles at the Content tab and discoverability dies; the convention would be a dead letter from day one.
- **Functional grouping** (`views/`, `panels/`, `hooks/`): rejected — grouping by role instead of vertical invites weak cross-feature coupling; at two verticals, cohesion by feature reads better than cohesion by kind.
- **One global ChromeStore**: rejected — becomes a grab-bag as verticals land and re-renders every subscriber on each set. Cross-vertical state is real (selection), which is exactly why it gets a *small* dedicated app store instead of the whole state.
- **Query hooks centralized** (`src/client/api.ts` or `hooks/`): rejected — features lose self-sufficiency and the central file grows linearly with the product. The `#hooks/*` package alias stays reserved for shadcn-generated hooks; hand-written hooks colocate in their module.
- **Canvas inside `features/css/` or the app shell**: rejected — the canvas renders under both verticals and select mode + overlay + re-matching are cross-vertical machinery; the app shell would stop being a thin bootstrap.
- **CodeMirror owned by the css feature**: rejected by the owner — CM will render CSS files, `.astro` files, and programmatically modeled documents (slicing portions of files). It is infrastructure spanning primitives → composed components, needed by content editing too.
- **Tool-enforced boundaries** (dependency-cruiser, or a custom import-lint script): rejected for now — a new dependency to police a five-layer graph. The living checklist in AGENTS.md is read by the advisory AI review on every PR (#42), which covers drift at the current size. A conscious gap: revisit if the graph grows or Biome gains boundary rules.
- **Hard line limit as the extraction gate**: rejected — mechanically checkable but forces artificial cuts of cohesive files.
- **PascalCase filenames**: rejected — breaks consistency with the shadcn `ui/` and the existing files for zero gain.

## Consequences

- The current layout does **not** yet conform; the ADR describes the target. A mechanical restructure (component moves, store split, import rewiring — no behavior change) lands as its own PR before Content-tab work starts, so the vertical's first code lands in the target shape.
- The editor dock slot is app-shell; what renders inside it is feature-owned and chosen by the active tab. `EditorSpec` and its actions migrate to the css feature store on restructure.
- Boundary violations are caught by review (AGENTS.md checklist + advisory AI review), not tooling — recorded above as a conscious gap.
- A new shared module needs the 2+-verticals test stated out loud in review, not assumed; `lib/` stays helpers-only.
