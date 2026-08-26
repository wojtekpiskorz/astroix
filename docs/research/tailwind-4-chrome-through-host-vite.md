# T1 · Research: Tailwind 4 (latest) for the source-served chrome through the host's Vite

Resolved: 2026-08-26 · Ticket: [#2](https://github.com/wojtekpiskorz/astroix/issues/2) · Branch: `research/tailwind-4-chrome-through-host-vite`
Verified against: `tailwindcss@4.3.3` / `@tailwindcss/vite@4.3.3` (latest at research time), Vite 8 docs + source (`main`), Astro integrations reference, real Chromium via Playwright.

## Question

How exactly do the chrome's Tailwind 4 styles get compiled and applied when the chrome is served from source via a virtual module in the host's Vite 8? Including: scoping the plugin to chrome sources only, shadow-DOM quirks, the `adoptedStyleSheets` mini-build zombie from stack #5, and how the CSS entry is referenced from the virtual module.

## Verdict (TL;DR)

**The plugin route works and is the winner.** Inject `@tailwindcss/vite` into the host's Vite via `updateConfig` (guarded when the host already registered it), give the chrome its own CSS entry containing `@import "tailwindcss" source(none); @source "./";` — that is the documented, per-entrypoint scoping mechanism. Import that entry from the chrome's source with `?inline`, then at runtime build **one** `CSSStyleSheet` and adopt it on **both** `document.adoptedStyleSheets` and the chrome `shadowRoot.adoptedStyleSheets`. Verified end-to-end in Chromium with the real compiled v4.3.3 output: utilities match inside the shadow tree, theme variables resolve, and `@property` registrations take effect. The stack #5 "separate build injected via `adoptedStyleSheets`" idea is dead as a *build* strategy (contradicts the no-client-build decision, stack #10) — but `adoptedStyleSheets` survives as the zero-build *delivery* mechanism inside the source-served flow.

## Verified mechanism, end to end

### 1. Plugin injection: `updateConfig` in `astro:config:setup`

Same pattern as the planned `@vitejs/plugin-react` injection (core-reuse §1). Astro merges injected `vite.plugins` with the user's config, and Vite optimizes them like user-written plugins ([Astro integrations reference — `updateConfig`](https://docs.astro.build/en/reference/integrations-reference/)):

```ts
updateConfig({ vite: { plugins: [/* … */] } })
```

`@tailwindcss/vite@4.3.3` declares `peerDependencies: { vite: "^5.2.0 || ^6 || ^7 || ^8" }` (read from the installed `package.json`) — Vite 8 is officially in range. Vite 8 ships Rolldown as its single bundler ("the most significant architectural change since Vite 2") and states most existing Vite plugins work out of the box ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8)); the Tailwind plugin already uses the Rolldown-compatible object-form `transform: { filter, handler }` hook (verified in [its source](https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-vite/src/index.ts)) and contains no Rollup-specific branching.

**Guard against the host's own instance.** If the host project already uses `@tailwindcss/vite`, astroix must not add a second instance. The plugin has **no `include`/files option at all** — its factory accepts only `PluginOptions = { optimize?: boolean | { minify?: boolean } }` (verified in `dist/index.d.mts` of 4.3.3). Scoping is therefore not a plugin-level concern:

- **Compilation gating is content-based.** The plugin (two `enforce: 'pre'` plugins, `apply: 'serve'` / `apply: 'build'`) transforms ids matching `/\.css(?:\?.*)?$/` (excluding `raw`/`url`/`worker`/`commonjs-proxy` queries and Vite's `.vite/` cache), then a second gate returns early unless the CSS actually contains Tailwind features (`Features.Utilities | Variants | AtApply | ThemeFunction | JsPluginCompat`). Host CSS with no Tailwind directives is never compiled — no `include` needed for safety.
- **Source scoping is per-stylesheet.** Content detection is configured *in the CSS file*, not in Vite: `@import "tailwindcss" source(none); @source "./";` disables automatic detection for that entry and registers explicit roots. The Tailwind docs describe exactly this as the multi-entrypoint mechanism ("multiple Tailwind stylesheets where you want to make sure each one only includes the classes each stylesheet needs") and show the node_modules case verbatim (`@source "../node_modules/@acme/ui"`) — [detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files). This matters doubly for astroix: automatic detection scans the **current working directory** (the host project) and **excludes `node_modules`** — the chrome's source (inside the installed astroix package) is invisible to it by default. `@source` is the documented way in, and `@source` paths resolve **relative to the stylesheet**, so `"./"` in `src/client/chrome.css` self-referentially scopes to the chrome's own files no matter where the package is installed.
- **One instance, many entries.** Each qualifying CSS id gets its own compiler + scanner (per-environment `Map<id, Root>` in the plugin source). A host's own Tailwind entry and astroix's chrome entry coexist with independent source sets. If the host already registered the plugin, the host's instance compiles the chrome entry identically — the scoping rides along in the CSS itself. Detection of an existing instance: flatten `config.vite.plugins` and look for `name.startsWith('@tailwindcss/vite')` (the plugin's three sub-plugins are named `@tailwindcss/vite:scan`, `@tailwindcss/vite:generate:serve`, `@tailwindcss/vite:generate:build`).

Note the plugin `realpathSync`s the CSS id (verified in its source). With the e2e fixture's `file:../..` install (symlinked by bun), `@source` relative resolution follows the real path inside the package — consistent either way since the CSS and the sources it references live in the same tree.

### 2. The CSS entry, referenced from the virtual chrome module

The chrome entry (the module behind `virtual:astroix/chrome`, i.e. `src/client/chrome.tsx`) imports the CSS entry as a sibling source file:

```css
/* src/client/chrome.css */
@import "tailwindcss" source(none);
@source "./";          /* scan chrome sources only (relative to this file) */
/* @source not "./chrome.css"; — unnecessary: CSS files are skipped by the scanner anyway */
```

```tsx
// src/client/chrome.tsx (the virtual module's target)
import chromeCss from './chrome.css?inline';
```

Why `?inline`: in dev, a normal CSS import is injected by Vite as a `<style>` into the **document head** ([Vite features — CSS](https://vite.dev/guide/features)) — and document-level selectors do not match elements inside a shadow root, so the chrome's shadow tree would see nothing. With `?inline`, Vite's CSS plugin returns `export default ${JSON.stringify(css)}` and injects nothing (verified in [Vite's `plugins/css.ts`](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/css.ts)). Crucially, `?inline` still passes the Tailwind plugin's transform filter — the filter's `include` regex is `/\.css(?:\?.*)?$/` and the excluded special queries are only `worker|sharedworker|raw|url`. (`?raw` would be useless here: it is excluded by the Tailwind plugin, so the CSS would arrive uncompiled.)

The alternative of making the CSS itself a virtual module (`virtual:astroix/chrome.css`) buys nothing: the real file works, stays debuggable from the host project, and `@source "./"` needs a real filesystem location to resolve against.

### 3. Delivery into the shadow DOM: one sheet, two adoptions

The chrome runtime builds a single constructed stylesheet and adopts it twice:

```ts
const sheet = new CSSStyleSheet();
sheet.replaceSync(chromeCss);                          // fully compiled CSS — @import already inlined
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
```

Why both:

- **Shadow-root adoption alone is not enough**: `@property` rules in shadow-tree stylesheets are ignored — registered properties are document-scoped (CSS Properties and Values API; future support tracked in [w3c/css-houdini-drafts#1085](https://github.com/w3c/css-houdini-drafts/issues/1085), Tailwind tracking issue [tailwindcss#15005](https://github.com/tailwindlabs/tailwindcss/issues/15005), still open). Without registration, `--tw-shadow`/`--tw-ring-*` composition breaks (e.g. [tailwindcss#16772](https://github.com/tailwindlabs/tailwindcss/discussions/16772) — `box-shadow` broken in shadow DOM).
- **Document adoption alone is not enough**: class selectors in a document stylesheet do not match shadow-tree elements — utilities would never apply inside the chrome.
- **Dual adoption of the same constructed sheet solves both**, and this is safe for astroix specifically because the chrome document is *our own* dev-only page (the host page under edit lives in the separate same-origin iframe canvas — a different document entirely). Nothing of the host is touched. A constructed sheet can be adopted by multiple roots and updates propagate to every adopter ([MDN: Document.adoptedStyleSheets](https://developer.mozilla.org/en-US/docs/Web/API/Document/adoptedStyleSheets), [web.dev: Constructable Stylesheets](https://web.dev/articles/constructable-stylesheets)).

**Browser-verified (Playwright, headless Chromium, this research):**

1. Synthetic probes — `@property` in a constructed sheet: adopted at `document` → initial value observable (`45deg`); adopted at shadow root only → **not** registered (empty). Same sheet adopted at both → registration, `:root,:host` variables, and utility selectors all work inside the shadow tree.
2. The **real compiled output** of `@import "tailwindcss" source(none)` + utilities (`flex items-center gap-2 bg-red-500/50 shadow-lg p-4 underline rotate-3`), compiled with `@tailwindcss/cli@4.3.3`, dual-adopted:

| Check (computed style inside the shadow tree) | Result |
| --- | --- |
| `.flex` applies | `display: flex` |
| `.rotate-3` applies | `rotate: 3deg` |
| `.shadow-lg` composes via `--tw-*` vars | `box-shadow` set |
| `--spacing` theme var resolves | `0.25rem` |
| `--color-red-500` theme var resolves | `oklch(63.7% 0.237 25.331)` |
| `@property --tw-shadow` registered (initial value present) | yes |

Reproduce: `bunx @tailwindcss/cli@latest -i in.css -o out.css` (with `source(none)` + `@source`), then adopt `out.css` as above in any Chromium and read `getComputedStyle`.

### 4. HMR

Two layers, both provided by the host Vite — astroix writes no watcher:

- **Candidate changes** (add/remove a utility class in chrome sources): the Tailwind plugin's serve transform registers the scanner's files and `@source` globs via `this.addWatchFile` (verified in its source), so Vite invalidates the CSS module and it recompiles with the new candidate set.
- **CSS module update → chrome**: `?inline` modules are explicitly **not** self-accepting (`!inlineRE.test(id)` in Vite's `cssAnalysisPlugin` — verified in source), so the update propagates to importers. The chrome module accepts the dependency and swaps the sheet in place:

```ts
import.meta.hot.accept('./chrome.css?inline', (mod) => {
  if (mod?.default) sheet.replaceSync(mod.default); // live-updates BOTH adoption contexts, canvas iframe untouched
});
```

`replaceSync` on an adopted constructed sheet updates every adopter synchronously — no FOUC, no reload, and the canvas iframe is unaffected. Fallback if the accept pattern misbehaves: let it bubble to a full chrome-document reload — a dev-only cost of a few hundred ms, never touching the host project. React fast-refresh for chrome components is unaffected (separate concern, `@vitejs/plugin-react` scoping per core-reuse §1).

### 5. Shadow-DOM quirks vs the latest output — current status

Ground truth from compiling v4.3.3 (the `:root`→`:host` story has changed since stack #5 was written):

- **`:root` → `:host`: solved upstream.** v4.3.3 emits `@layer theme { :root, :host { … } }` for theme variables and `html, :host` in preflight (verified in compiled output; preflight's `:host` dates to v3.4.0 per the [changelog](https://github.com/tailwindlabs/tailwindcss/blob/main/CHANGELOG.md), theme `:host` observed since v4 beta-9 in [discussion #15556](https://github.com/tailwindlabs/tailwindcss/discussions/15556) — which stays open only for want of an official confirmation). **No rewriting, no PostCSS string surgery needed.**
- **`@property`: the one real quirk, and only when it matters.** The compiled output contains `@property` rules only for `--tw-shadow*`/`--tw-ring*` internals and only when shadow/ring utilities are used (verified: 14 rules with `shadow-lg`, 0 without). shadcn/ui components use `ring-*` focus states, so expect them in practice. Dual adoption (§3) neutralizes the quirk entirely — verified. Bonus: v4.3.3 also emits an `@supports` fallback block inside `@layer properties` that sets unregistered `--tw-*` defaults via `*` selectors — a graceful-degradation path for contexts without registration.
- **Preflight isolation: a non-issue in this architecture.** The chrome document contains only the chrome (plus the canvas iframe). Host-page styles cannot leak into the chrome and vice versa *by construction* — the page under edit is a separate document in the iframe. The shadow root additionally isolates the chrome's own (preflight-ed) document from the chrome UI tree. Inherited properties flowing from the chrome document into the shadow tree are harmless — it is our document.
- **`@import` ignored in constructed stylesheets** ([web.dev](https://web.dev/articles/constructable-stylesheets)): irrelevant — the CSS is fully compiled and inlined by the plugin long before adoption.
- **Cascade layers** (`@layer properties; @layer theme, base, components, utilities;`): work in adopted sheets; both adoption contexts get identical layer order from the same sheet.

### 6. The stack #5 zombie — buried (with a surviving organ)

- **Dead**: the "separate chrome build injected via `adoptedStyleSheets`" as a *build* strategy. It contradicts stack #10 / core-reuse §1 (chrome is served from source through the host Vite; there is no client build to hang a Tailwind mini-build off). It dies for exactly the same reason the chrome JS prebuild died.
- **Alive (renamed)**: `adoptedStyleSheets` as the *delivery* mechanism inside the source-served flow — no build, just runtime adoption of the `?inline` string (§3). The quirks stack #5 worried about are handled at runtime adoption time, not "in the chrome build config" as spec.md's risk list still says.

**Conflict to surface for the charting session (not changed in this branch):** `docs/stack.md` #5 ("osobny build chroma wstrzykiwany przez `adoptedStyleSheets`" as the Tailwind-in-shadow-DOM answer) and the matching risk line in `docs/spec.md` ("quirki Tailwind 4 w shadow DOM … do zrobienia raz w build configu chroma") are stale: the build is gone, `:root`→`:host` is solved upstream, and the remaining `@property` quirk is solved by dual adoption at runtime. This file is the evidence for that amendment.

## Config sketch for `src/node` (when the integration lands)

```ts
// src/node/index.ts — sketch for the future integration task, NOT implemented in this branch
import tailwindcss from '@tailwindcss/vite';
import type { AstroIntegration, AstroConfig } from 'astro';

type VitePluginLike = { name?: string };

function hasHostTailwind(viteConfig: AstroConfig['vite']): boolean {
  const plugins = typeof viteConfig?.plugins === 'function' ? [] : (viteConfig?.plugins ?? []);
  return plugins
    .flat(Infinity)
    .some((p) => typeof p === 'object' && p !== null &&
      (p as VitePluginLike).name?.startsWith('@tailwindcss/vite'));
}

function astroix(): AstroIntegration {
  return {
    name: 'astroix',
    hooks: {
      'astro:config:setup'({ config, updateConfig, command }) {
        if (command !== 'dev') return;                       // dev-only guarantee
        updateConfig({
          vite: {
            plugins: hasHostTailwind(config.vite) ? [] : [tailwindcss()],
          },
        });
      },
      // … middleware / virtual module per docs/core-reuse.md §1
    },
  };
}
```

Client side (source-served, no build):

```css
/* src/client/chrome.css */
@import "tailwindcss" source(none);
@source "./";
```

```tsx
// src/client/chrome.tsx
import chromeCss from './chrome.css?inline';

export function mountChrome(host: HTMLElement): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(chromeCss);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; // @property + :root vars

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.adoptedStyleSheets = [sheet];                                   // utilities + preflight

  createRoot(shadow).render(/** … */);

  import.meta.hot?.accept('./chrome.css?inline', (mod) => {              // swap without reload
    if (mod?.default) sheet.replaceSync(mod.default);
  });
}
```

## Open risks

1. **`import.meta.hot.accept` with a query-suffixed dep** (`./chrome.css?inline`) — the [HMR API docs](https://vite.dev/guide/api-hmr) don't explicitly cover query suffixes (the dep must match the import specifier; Vite resolves it relative to the importer). Verify at implementation; fallback is a full chrome-document reload (acceptable dev-only).
2. **Packaging** — `files: ["dist"]` today, but the chrome (including `chrome.css` and the sources `@source` must scan) is served *from source*, so the published package must ship the client source tree. The `file:../..` fixture install is symlinked (plugin `realpathSync`s ids — fine), but the real npm path (packed copy, no symlink) needs one e2e run against `npm pack` to prove `@source "./"` resolves in a real install.
3. **New-file HMR** — utilities introduced in files created after the first compile depend on the plugin's `addWatchFile` of `@source` globs (verified in source); add an e2e regression that creates a new chrome component file and expects its utilities to appear without a restart.
4. **Host on Tailwind v3 (PostCSS pipeline)** — v3 `@tailwind base;` directives are not v4 features, so the plugin's content gate leaves host CSS alone; but such hosts are out of spec scope anyway (Astro 7-only, new projects). No action.
5. **Two plugin instances** if a host registers `@tailwindcss/vite` as a `function` returning plugins (`vite.plugins` can be a function) — the guard reads the static array case only. Rare; revisit if a real host trips it (symptom would be double-compilation churn, not corruption — the content gate makes the second pass a no-op on already-compiled CSS only if ordering cooperates; unverified corner).

## Evidence index

- Tailwind docs: [installation via Vite](https://tailwindcss.com/docs/installation/using-vite) · [detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files) (`source(none)`, `@source`, node_modules case, monorepos)
- `@tailwindcss/vite` source (`main`): [packages/@tailwindcss-vite/src/index.ts](https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-vite/src/index.ts) — hooks, filters, per-id Roots, `addWatchFile` HMR, `realpathSync`, no `include` option (`dist/index.d.mts` of 4.3.3)
- Local ground truth: compiled `tailwindcss@4.3.3` via `@tailwindcss/cli` (`source(none)` + `@source`) — output quoted in §5; peer range `vite ^8` read from installed `package.json`
- Shadow DOM: [tailwindcss#15005](https://github.com/tailwindlabs/tailwindcss/issues/15005) (@property in shadow roots — open) · [discussion #15556](https://github.com/tailwindlabs/tailwindcss/discussions/15556) (`:root, :host` shipped; @property remains) · [discussion #16772](https://github.com/tailwindlabs/tailwindcss/discussions/16772) · [issue #15799](https://github.com/tailwindlabs/tailwindcss/issues/15799) · [w3c/css-houdini-drafts#1085](https://github.com/w3c/css-houdini-drafts/issues/1085) · [MDN @property](https://developer.mozilla.org/en-US/docs/Web/CSS/@property) · [MDN Document.adoptedStyleSheets](https://developer.mozilla.org/en-US/docs/Web/API/Document/adoptedStyleSheets) · [web.dev Constructable Stylesheets](https://web.dev/articles/constructable-stylesheets)
- Chromium behavior (this research, Playwright headless): probes + real v4.3.3 output dual-adopted — table in §3
- Vite: [features — CSS, `?inline`](https://vite.dev/guide/features) · [plugins/css.ts source](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/css.ts) (`export default` for inline, not self-accepting, special-query exclusions) · [HMR API](https://vite.dev/guide/api-hmr) · [Vite 8 announcement](https://vite.dev/blog/announcing-vite8) (Rolldown unified, plugin compat)
- Astro: [integrations reference — `updateConfig`](https://docs.astro.build/en/reference/integrations-reference/)
