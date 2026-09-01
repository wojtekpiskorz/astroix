# Astroix — Core Reuse Map

Rewritten for the Electron parent-app (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210), 2026-09-01; supersedes the integration-era map in full — git history is provenance). Standing rule: **if Astro/Vite core already provides a mechanism, we do not build it.** Authority: runtime/introspection ruling [#202](https://github.com/wojtekpiskorz/astroix/issues/202), adapter proof [#206](https://github.com/wojtekpiskorz/astroix/issues/206) (certified pair `astro@7.2.10 + vite@8.2.2`).

In the parent app there is no host integration to ride: Astroix composes the project's real Astro/Vite itself, in the disposable project plane, through the **`AstroProjectAdapter`** — the single internal module behind which every version-sensitive behavior lives (Astro internal imports, `virtual:astro:*` identifiers, module-runner behavior, module-graph reads, compiled-CSS shapes). The adapter never guesses routes, schemas, or selectors; an unknown shape fails closed. `docs/adr/0005` records the contract; this file inventories the seams by class.

## Seam classes

Every Astro/Vite mechanism the adapter touches belongs to exactly one class. The class decides the compatibility contract:

1. **Public seam** — documented, stable API. Used directly; safe across certified minor versions.
2. **Certified exact-pair seam** — documented but experimental or newly stabilized; usage is proven only for the exact certified Astro/Vite pair and re-proven for every new pair.
3. **Fail-closed private seam** — internal or output-shape-coupled. Used only behind the adapter's shape probes: the adapter verifies the exact expected shape and **fails closed** (clear diagnostic, no guessing) when the observed shape differs. No private seam may be reported as a compatibility contract.

| Seam | Class |
| --- | --- |
| `astro/config#getViteConfig()` | Public |
| Astro integration hooks (`astro:config:setup`, `astro:routes:resolved`, …) | Public |
| Vite `createServer()` + per-environment module graphs | Public |
| Vite module runner lifecycle: `import()`, `close()`, `isClosed()` | Public |
| Vite root-exported `createServerModuleRunner(environment)` | Certified exact-pair (experimental) |
| Astro internal CSS utility (core CSS collection, ~60-line `collectCSSWithOrder` analog) | Fail-closed private |
| `virtual:astro:routes` | Fail-closed private |
| `virtual:astro:dev-css:*` | Fail-closed private |
| Route and CSS export shapes (module export contracts) | Fail-closed private |
| SSR hot transport emitter | Fail-closed private |
| Client-environment module-graph ownership | Fail-closed private |
| Vite `__vite__css` sentinel | Fail-closed private |
| Compiler-source ↔ source/compiled rule correlation | Fail-closed private |
| Astro compiler `TransformResult.scope` (scoped-style hash) | Certified exact-pair (verified against the locked pair) |
| `@astrojs/compiler-binding` `extractStylesSync` | Certified exact-pair |

Certification policy ([#202](https://github.com/wojtekpiskorz/astroix/issues/202), [#206](https://github.com/wojtekpiskorz/astroix/issues/206)): acceptance is driven by **certified exact Astro/Vite pairs** resolved from the managed project's own installation — never by trust in broad semver ranges. The first certified pair is `astro@7.2.10 + vite@8.2.2`. An uncertified pair fails **before project config executes**, reporting the detected pair, the certified pairs, and the rejected contract. A new pair enters the set only after the compatibility fixture and migration oracle pass.

## What we reuse, by concern

### Project composition

- ✅ **External composition via `getViteConfig()`**: the composition inspector loads the project's real Astro configuration from the project installation and composes its Vite config through `astro/config#getViteConfig()` — public seam, proven by the #189/#206 spikes. `configFile: false` is **not** a full-fidelity fallback and may never be reported as equivalent introspection.
- ⚠️ **Duplicate hooks are accepted**: the managed Astro dev server and the composition inspector both load the real project config, so project integrations execute twice. Explicit, accepted pre-alpha cost, confined to the disposable project plane. Startup evidence must include a non-idempotent integration case with a clear failure diagnostic.
- ✅ **Managed dev server**: Astroix starts the project's own dev server as an exact child handle (argument array, `shell: false`, canonical cwd, minimal environment without app-private authority material). We never reimplement dev serving — every non-reserved request streams to it (ADR-0005 proxy contract).

### Content

- ✅ **Collection reads through the module runner**: `createServerModuleRunner(server.environments.ssr)` → `runner.import('astro:content')` → `getCollection()` returns entries with parsed `entry.data`, `entry.body`, `entry.filePath` — exactly how core reads content. Certified exact-pair seam (`createServerModuleRunner` is experimental at the certified pin).
- ✅ **Fresh runner per inspection pass, closed in `finally`**: never cache the runner between passes (core clears its cache on invalidation); never leave it open — the constructor pins a `send` listener on the SSR hot channel and holds the evaluated module graph in memory; leaks surface as `MaxListenersExceededWarning` from the 11th unclosed runner. Runner `close()` may reset `process.setSourceMapsEnabled` — a dev-only global, inactive in practice. `ssrLoadModule` is on Vite 8's removal list: do not use.
- ✅ **Collection schemas**: `runner.import(contentConfigPath)` → `.collections: Record<string, {schema?, loader?, type?}>`; a schema may be a function `({image}) => …` — invoke with our own `image()` stub. Config-change subscription: `globalContentConfigObserver` (`@internal` — treat as fail-closed private).
- ✅ **`astro/zod` re-exports `zod/v4`** — the same zod instance the project uses: introspection via `.def.*` without instanceof hell; `z.toJSONSchema()` (zod 4) helps form generation.
- ✅ **Content freshness**: observe the project's content **data-store file** — the exact "content synced" signal core itself uses (post-sync, no loader races).
- 🔨 **Entry writes are ours**: core only parses. Serializer (yaml Document API + slug rules mirroring `generateIdDefault`) and image handling stay Astroix's.
- ✅ **Body preview**: `render(entry)` from core.

### Routes

- ✅ **Route table via the `astro:routes:resolved` hook** — `IntegrationResolvedRoute[]` (`pattern`, `entrypoint`, `params`, `generate()`, type); re-runs in dev when route files change. The runtime `virtual:astro:routes` module and its export shape are a fail-closed private seam behind the adapter.
- 🔨 **Route resolution** (URL↔entry bridging) stays a pure Astroix module (`packages/core`): route patterns × entry ids, unique-hit-or-silence. No instrumentation of sources.

### CSS: index, scoped, splicing

- ✅ **Live per-route CSS** via `virtual:astro:dev-css:{route-component}` — exports the `css` set (`{id, url, content}`) Astro actually injects in dev. Scoped `<style>` blocks are real CSS modules: id `{file}.astro?astro&type=style&index={N}` — stripping the query maps back to the `.astro` file. Graph walk via per-environment `environment.moduleGraph` (mixed `server.moduleGraph` is deprecated in Vite 8). All of these are fail-closed private seams.
- ✅ **Scoped hash**: `data-astro-cid-*` comes from the compiler's `TransformResult.scope` — we never compute it. Default `scopedStyleStrategy: "attribute"` emits bare `[data-astro-cid-*]`; `:where(...)` only when the project configures it. Both strategies are certified behavior, proven by #206's matched-node parity.
- ✅ **`<style>` block positions** via `extractStylesSync(source)` from `@astrojs/compiler-binding`; offset via `source.indexOf(block.content)` (the `enhanceCSSError` technique).
- 🔨 **Static source index is ours — the edit-truth**: Astro dev generates no CSS sourcemaps (`css.devSourcemap` is never set), so rule→(file, range) mapping is our own postcss pass over source files. It is the only path that supports splicing and the only one that sees `is:inline`.
- 🟡 **Hybrid architecture**: static index (edit: file+range) × module graph (liveness + compiled scoped-selector forms for `el.matches()`), joined per route and revisioned.

### Liveness and events

- ✅ **Watcher signals**: watch the project through the composition server's watcher (one FS subscriber per process, debounced reindex) — the same discipline core follows; never `addWatchFile` for files that do not restart the server.
- ✅ **Invalidation convergence** (a certified #206 rule): after content/route/style source changes, inspection results must converge to fresh values; revisions increase monotonically; subscriptions emit revisioned invalidations over the protocol's SSE stream.

## What died with the integration (do not rebuild)

These integration-era mechanisms are dead in the parent app; they are listed so no lane reinvents them. Their full mechanics remain readable in git history.

| Dead mechanism | Why it died |
| --- | --- |
| Vite-middleware interception of the host's pages (`configureServer` body registration, `server.transformIndexHtml()` in middleware) | The app shell is served by the control plane on Astroix's own origin (`/__astroix/app/`); the project's pages are never intercepted — they stream through the proxy untouched. |
| Virtual chrome module + hybrid prebuilt/source chrome delivery (ADR-0001) | Superseded — the renderer ships inside the app (ADR-0008); there is no foreign host to protect against. |
| `injectScript` iframe script | The canvas needs no injected script: same-origin `iframe.contentDocument` is read directly by the app shell. |
| Custom Vite WS events (`astroix:*`), the chrome-reload-shield `send` patch, `import.meta.hot` bridges | Replaced by protocol v1 (fetch + SSE) on Astroix's own listener; the HMR WebSocket is only transparently proxied. |
| `?builder=0`/`?builder=1` entry mechanics | No injection, no query flags: the canvas is the project's natural URL. |
| Dev-toolbar CSS hiding inside the iframe | The managed dev server runs with its natural toolbar behavior; nothing is hidden from the project. |

## Traps that still bind

- **Never splice from `convertToTSX` `metaRanges`** — positions are in TSX-output space, not source space.
- **Astro dev generates no CSS sourcemaps** — the static postcss index is the edit-truth; this is why the indexer/splice-writer survive the rewrite unchanged.
- **Always close fresh runners in `finally`** — see the runner lifecycle above.
- **Unknown private shapes fail closed** — the adapter reports the expected/observed shape and stops; it never heuristically parses a drifted output. A seam drift is a compatibility event (diagnosed from the diagnostic, not a bisect).
- **`virtual:astro:*` identifiers, internal imports, and export shapes are pin-sensitive** — every touch goes through the adapter; a direct import anywhere else is a boundary violation.

## Unproved (carried from #206)

Every other Astro/Vite pair; arbitrary third-party integration side effects; CSS preprocessors, CSS Modules, Tailwind-specific output, custom Vite CSS plugins, multiple scoped style blocks, other selector transforms; other content loaders/types/schema factories/plugins; alternative config filenames and unusual config-loading effects; Windows, Linux, Intel macOS, performance budgets, watcher-burst stress, arbitrary crash timing; production builds. The packaged-runtime matrix adds its own qualified-environment floor ([#209](https://github.com/wojtekpiskorz/astroix/issues/209)).

Sources: docs.astro.build and vite.dev (public seams); `withastro/astro` and `withastro/compiler` internals (private seams, verified against the certified pin); proof evidence in [#206](https://github.com/wojtekpiskorz/astroix/issues/206) (`spikes/issue-206-astro-project-adapter`, commit `274beac`) and [#208](https://github.com/wojtekpiskorz/astroix/issues/208) (`docs/research/issue-208-service-worker-origin.md`, commit `de59167`).
