# Research: core-reuse §1 + §4 verified against the fixture's locked astro

Ticket: #3 (T2). Date: 2026-08-26. Method: primary sources only — the fixture's `bun.lock` plus the **installed** `node_modules` sources, verified directly and with a live compiler probe. `docs/core-reuse.md` (researched against `withastro/astro@main`) was the claim list; this doc records per-claim verdicts against the exact locked versions.

## 1. Locked versions (facts, not assumptions)

From `e2e/fixture/bun.lock` (path: `e2e/fixture/bun.lock`) and the installed packages:

| Package | Resolved | Evidence |
| --- | --- | --- |
| astro | **7.2.7** (spec `^7.2.7`) | `bun.lock:269`; `node_modules/astro/package.json` confirms 7.2.7 installed |
| vite | **8.2.2** (spec `^8.0.13`) | `bun.lock:571`; `node_modules/vite/package.json` |
| @astrojs/compiler-rs | **0.4.0** | `bun.lock:33`; `node_modules/@astrojs/compiler-rs/package.json` |
| @astrojs/compiler-binding (napi layer of compiler-rs) | **0.4.0** (+ platform pkgs, e.g. `compiler-binding-darwin-arm64@0.4.0`) | `bun.lock:13-31` |
| Go/WASM `@astrojs/compiler` | **not present** | absent from the lock — compiler-rs is the only compiler in the fixture |

Astro's compile path imports `transform`, `preprocessStyles` from `@astrojs/compiler-rs` (`node_modules/astro/dist/core/compile/compile.js:2`).

## 2. Verdict table

Verdicts: **confirmed** · **changed** (mechanism exists, details differ) · **gone** (does not hold on locked versions).

| # | Claim (core-reuse §) | Verdict |
| --- | --- | --- |
| 1 | Body-of-`configureServer` middleware runs before Astro's handler; `astroDevHandler` registered in post-hook, never calls `next()` (§1) | **confirmed** (+ note: 4 Astro pre-middlewares are unshifted in front) |
| 2 | `server.transformIndexHtml(url, html)` is the injection path; the `transformIndexHtml` plugin hook is useless for Astro pages (§1) | **confirmed** (strengthened: hook never fires at all — `appType: "custom"`) |
| 3 | `injectScript('page')` works, no per-route filtering, applies on build unless `command === 'dev'`-guarded (§1) | **confirmed** |
| 4 | Keep `devToolbar.enabled: true` because `data-astro-source-*` depends on it; hide toolbar via CSS (§1/§5) | **changed/broken**: gating real, but `annotateSourceFile` is an unimplemented stub in compiler-rs 0.4.0 — attributes are **not emitted at all** |
| 5 | `extractStylesSync` from `@astrojs/compiler-rs` gives splice-able style blocks; `parse()` positions incomplete; `convertToTSX` metaRanges in TSX space — never splice (§4) | **changed**: fn exists+works but lives in `@astrojs/compiler-binding`, not compiler-rs; `convertToTSX` **throws**; `parse()` now oxc AST with `start`/`end` |
| 6 | `virtual:astro:dev-css:{route-component}` exporting `css` = Set of `{id, url, content}` (§4) | **confirmed** (+ bonus `dev-css-all`) |
| 7 | `TransformResult.scope` carries the `data-astro-cid-*` hash = xxhash64(normalized filename) (§4) | **changed**: scope field confirmed, but hash is Rust `DefaultHasher` (SipHash-1-3), not xxhash64; and default scoped strategy emits plain `[data-astro-cid-*]`, not `:where(...)` |
| 8 | Per-environment `environment.moduleGraph` current; mixed `server.moduleGraph` deprecated in Vite 8; `collectCSSWithOrder` in core (§4) | **confirmed** ("deprecated" = future-deprecation warning `removeServerModuleGraph`; `collectCSSWithOrder` is ~23 lines, unexported) |

## 3. Claim-by-claim evidence

All file paths below are inside the installed fixture tree (relative to `e2e/fixture/node_modules/`). Live-probe results were produced by running the installed compiler via bun from `e2e/fixture/`.

### Claim 1 — body middleware before Astro's handler — CONFIRMED

- `astro/dist/vite-plugin-astro-server/plugin.js:77-146` — `configureServer` **returns** a function (the post-hook). Inside it, line 135: `viteServer.middlewares.use(async function astroDevHandler(request, response) {…})`. The handler takes **no `next` parameter** and always delegates to `ssrHandler.handler(request, response)` (line 141-143) — it can never continue the chain. (The separate prerender handler, lines 99-131, does call `next()` — registered before `astroDevHandler`.)
- Vite 8.2.2 stack assembly, `vite/dist/node/chunks/node.js:26630-26655` (function `_createServer`):
  - line 26631: `for (const hook of config.getSortedPluginHooks("configureServer")) postHooks.push(await hook.call(…, reflexServer))` — **hook bodies run first** (any middleware they `use()` joins the stack at that point);
  - lines 26632-26653: Vite's internal middlewares are installed;
  - line 26654: `postHooks.forEach((fn) => fn && fn())` — post-hook middlewares (incl. `astroDevHandler`) land **after** everything.
  - Connect runs the stack in insertion order → a middleware registered in a `configureServer` **body** runs before `astroDevHandler` and can terminate the request.
- **Note (new detail vs doc):** in 7.2.7 the post-hook also `unshift`s four pre-middlewares to the very front of the stack (`plugin.js:81-96`, final order: secFetch → routeGuard → trailingSlash → base). Verified they all `next()` past our case: `route-guard.js:26-28` skips URLs containing `?` (so `?builder=1` passes); `sec-fetch.js:9-10` passes `same-origin`/`none` (same-origin iframe canvas is fine — but note `sec-fetch.js:29-36` 403s cross-origin subresource requests); `base.js`/`trailing-slash.js` pass normal non-base-mismatched paths. The interception design is unaffected; the chrome iframe must stay same-origin (it is, by spec).

### Claim 2 — `server.transformIndexHtml` is the injection path — CONFIRMED (strengthened)

- API exists in vite 8.2.2: `vite/dist/node/index.d.ts:2724` (`transformIndexHtml(url, html, originalUrl?)`); impl at `chunks/node.js:26484` delegating to `createDevHtmlTransformFn` (`chunks/node.js:25504`).
- `devHtmlHook` in that chain injects the client: `chunks/node.js` (~25678-25682) adds `<script type="module" src="{base}/@vite/client">` (`CLIENT_PUBLIC_PATH = '/@vite/client'`, `chunks/node.js:635`).
- Plugin `transformIndexHtml` hooks (pre/normal/post from `resolveHtmlTransforms(config.plugins)`) run **inside** that same chain (`chunks/node.js:25505-25516`) — so `@vitejs/plugin-react`'s preamble hook fires exactly when astroix calls `server.transformIndexHtml`. (plugin-react is not installed in the fixture; structural evidence from the vite pipeline.)
- **Strengthened vs doc:** the doc says the hook is useless "for Astro pages". In fact it never fires for **any** request in Astro dev: Astro passes `appType: "custom"` (`astro/dist/core/create-vite.js:123`, `astro/dist/core/createMinimalViteDevServer.js:9`), and Vite installs `indexHtmlMiddleware` (the only other caller of the html transform) only for `appType === "spa" || "mpa"` (`chunks/node.js:26655-26659`). Additionally, `grep -r transformIndexHtml astro/dist` → **zero hits**: Astro 7.2.7 never calls it itself either. Astro injects its own `/@vite/client` via SSR `headElements` instead (`astro/dist/vite-plugin-app/environment.js:101`).

### Claim 3 — `injectScript('page')` semantics — CONFIRMED

- `astro/dist/integrations/hooks.js:170-172`: `injectScript: (stage, content) => { updatedSettings.scripts.push({ stage, content }) }` — no filtering metadata accepted at all.
- Dev injection — `astro/dist/vite-plugin-app/environment.js:126-131`: every `page`-stage script becomes `/@id/${PAGE_SCRIPT_ID}` on **every** `.astro` page (gate is `isPage(filePath, settings)` only; no route or query filtering → the script must self-check `location.search`, as the doc says).
- Build applies too — `astro/dist/core/build/static-build.js:295` adds `PAGE_SCRIPT_ID` to the client build input; `astro/dist/core/build/environment.js:92-105` injects the built asset into head elements for pages. Hence the `if (command === 'dev')` guard in `config:setup` is required, exactly as documented.

### Claim 4 — devToolbar.enabled ⇄ data-astro-source — gating CONFIRMED, mechanism BROKEN

- Gating is real: `astro/dist/core/compile/compile.js:39` — `annotateSourceFile: viteConfig.command === "serve" && astroConfig.devToolbar && astroConfig.devToolbar.enabled && toolbarEnabled`. `devToolbar.enabled` defaults `true` (`astro/dist/core/config/schemas/defaults.js:26-28`; fixture config is empty `defineConfig({})`).
- **But** the option is a stub in the locked compiler: `@astrojs/compiler-binding/index.d.ts:116-121` — `annotateSourceFile?: boolean; /** … **Stub**: not yet implemented. */`.
- **Live probe (bun, installed packages):** compiling `<h1 class="hero">…</h1><style>.hero{color:red}</style>` with `annotateSourceFile: true` vs `false` yields **byte-identical output; zero `data-astro-source-*` attributes either way** (elements get only the scope class/attribute). Nothing in the runtime writes them either — the only references in astro 7.2.7 are reads by the toolbar's audit app (`astro/dist/runtime/client/dev-toolbar/apps/audit/annotations.js:6-7,20`).
- Consequence: core-reuse §5's "element→source: `data-astro-source-file` for free (dev-toolbar mechanism)" **does not work on astro 7.2.7 / compiler-rs 0.4.0**. See deltas #1.
- Keeping `devToolbar.enabled: true` and hiding via CSS is still the right call (toolbar script injection is gated by `manifest.devToolbar.enabled`, `vite-plugin-app/environment.js:105-110`) — but the doc's stated justification is void on the locked version.

### Claim 5 — extractStylesSync / parse() / convertToTSX — CHANGED

- `extractStylesSync(sourceText): Array<StyleBlock>` exists and works — but in `@astrojs/compiler-binding` (`index.d.ts:234-243`), **not** re-exported by `@astrojs/compiler-rs` (its `dist/index.mjs` exports only `transform`, `parse`, `convertToTSX`, `preprocessStyles`; `dist/utils.d.mts` exports only `serialize`).
- `StyleBlock = { index, content, attrs }` (`index.d.ts:321-337`): `content` is exactly the text between `<style>` and `</style>`. **Live probe:** for the fixture-style source above, `block.content === '.hero { color: red; }'` and `source.indexOf(block.content) === 35` — the splice-offset technique from the doc works verbatim.
- `parse()` changed shape: returns an **oxc ESTree-compatible AST** (`ast.type === 'AstroRoot'`), serialized JSON in the binding layer. **Live probe:** nodes carry `start`/`end` span fields — the Go-compiler-era "positions incomplete" caveat does not carry over verbatim. It remains the wrong tool for splicing (spans are not a sanctioned edit-truth; extractStylesSync is).
- `convertToTSX` is **gone** on the locked version: `dist/index.mjs` — `throw Error('convertToTSX() is not yet implemented')`; `dist/async.d.mts:7` types it as `Promise<never>`. The doc's "never splice from `metaRanges`" trap is moot — there is nothing to mis-splice from. Any backlog item assuming TSX-space tooling is dead until compiler-rs implements it.

### Claim 6 — virtual:astro:dev-css — CONFIRMED (+ bonus)

- `astro/dist/vite-plugin-css/const.js:3-4` — `MODULE_DEV_CSS_PREFIX = "virtual:astro:dev-css:"` (+ `virtual:astro:dev-css` and `virtual:astro:dev-css-all`).
- `astro/dist/vite-plugin-css/index.js:102-140` — `load` resolves the route component, walks the module graph via `ensureModulesLoaded`, runs `collectCSSWithOrder`, and emits:
  `export const css = new Set(${JSON.stringify(cleanedCss)})` where entries are exactly `{ content, id, url }` (lines 132-139). `content` is hydrated from `cssContentCache`, populated by the plugin's own `transform` hook on CSS requests (lines 144-160).
- Scoped-style module id shape confirmed by live compile output: `import "/project/src/pages/index.astro?astro&type=style&index=0&lang.css"` — `{file}.astro?astro&type=style&index={N}` as documented (plus `&lang.css`).
- **Bonus:** `virtual:astro:dev-css-all` (index.js:163-192) exports `devCSSMap = Map<route.component, () => import('virtual:astro:dev-css:{component}')>` over all routes — handy for bulk indexing without per-route requests.

### Claim 7 — TransformResult.scope — PARTIALLY CONFIRMED / CORRECTED

- The field exists and is the scope hash: `@astrojs/compiler-binding/index.d.ts:167-168` (`scope: string`, "CSS scope hash for the component"). **Live probe:** `transform(...)` → `scope: "lcdefpme"`; identical from raw `compileAstroSync`; stable across calls. Astro passes `normalizedFilename` for hash generation (`astro/dist/core/compile/compile.js:31,92-100`). "Don't compute it yourself" stands.
- **xxhash64 is wrong for the locked version.** Upstream `withastro/compiler-rs@v0.4.0`, `crates/astro_codegen/src/printer/mod.rs:282-296`: the scope is `DefaultHasher` (Rust std = **SipHash-1-3 with fixed keys**) over `normalizedFilename` (fallback `filename`, fallback source text for `<stdin>`), then `to_base32_like` (mod.rs:337-346): 8 chars, alphabet `abcdefghijklmnopqrstuvwxyz234567`, 5 bits/char, LSB-first. The xxhash64 description came from the Go `@astrojs/compiler`; astro's own `xxhash-wasm` dependency is unrelated to scoping. (Verified empirically: xxhash64 of the probe's normalized filename does not produce `lcdefpme` in any base encoding.)
- Stability nuance: fixed-key SipHash is deterministic per compiled binary (stable across reloads), but Rust reserves the right to change `DefaultHasher`'s algorithm between std versions — cross-compiler-release stability is **not** guaranteed. Reinforces "always read `TransformResult.scope`".
- **Selector-shape correction (matters to the selector engine):** astro 7.2.7's default `scopedStyleStrategy` is **`"attribute"`** (`astro/dist/core/config/schemas/base.js:49`), not `"where"`. Live probe with defaults-configured options: element `<h1 class="hero" data-astro-cid-lcdefpme>`, CSS `.hero[data-astro-cid-lcdefpme]` — plain attribute selector, **no `:where`**. With `scopedStyleStrategy: "where"` the output is class-based: `<h1 class="hero astro-lcdefpme">` + `.hero:where(.astro-lcdefpme)` — i.e. `:where` forms use `.astro-*` classes, **not** `data-astro-cid-*`. So the doc's (and AGENTS.md's) `:where([data-astro-cid-*])` matches neither mode: default = `[data-astro-cid-*]`; `where` mode = `:where(.astro-*)`. `el.matches('[data-astro-cid-*]')` works under default config. See deltas #2.

### Claim 8 — environment.moduleGraph + collectCSSWithOrder — CONFIRMED

- Per-environment graph is the current API: `vite/dist/node/index.d.ts:1687` (`DevEnvironment.moduleGraph: EnvironmentModuleGraph`); astro core itself uses `env.moduleGraph` (`astro/dist/vite-plugin-css/index.js:117,155-159`) and `viteServer.environments[...]` throughout.
- Mixed `server.moduleGraph` in vite 8.2.2: the getter emits `warnFutureDeprecation(config, "removeServerModuleGraph")` (`vite/dist/node/chunks/node.js:26465-26469`) — a future-deprecation warning with scheduled removal (not yet `@deprecated` in the .d.ts). The doc's "deprecated in Vite 8" is fair; formally: future-deprecation, slated for removal.
- `collectCSSWithOrder` exists in core: `astro/dist/vite-plugin-css/index.js:40-62` — an unexported module-local generator (~23 lines, not ~60): yields `{id, idKey, content, url}` for `isBuildableCSSRequest` modules, depth-first over `importedModules` with a `seen` set. Reference/mirror it as the doc planned.

## 4. Deltas needing backlog attention

1. **`data-astro-source-*` is dead on the locked stack** (claim 4): the "free element→source mapping" from core-reuse §5 must be re-planned — astroix-owned mapping (own overlay/index) or opportunistic feature-detection if a compiler update ships `annotateSourceFile`. Do not bless the POC backlog item assuming these attributes exist.
2. **Selector-engine doctrine** (claim 7): default scoped style output is `[data-astro-cid-{scope}]` attribute selectors (strategy `attribute`); `:where(...)` variants are class-based (`.astro-{scope}`). Update core-reuse §4/§5 wording, AGENTS.md gotcha ("`:where([data-astro-cid-*])`"), and author the e2e selector spec against the **default** strategy while tolerating `.astro-*` classes (a user may set `scopedStyleStrategy`).
3. **`extractStylesSync` import path** (claim 5): exported from `@astrojs/compiler-binding` (an indirect dep), not `@astrojs/compiler-rs`. Either add `@astrojs/compiler-binding` as a direct dependency (needs approval per AGENTS.md "Ask first: adding dependencies") or pin `@astrojs/compiler-rs` and import through it once re-exported upstream. The splice technique itself (`source.indexOf(block.content)`) is verified working.
4. **`convertToTSX` unavailable** (claim 5): any tooling premised on TSX-space output must be cut/deferred; replace the old trap note ("never splice from metaRanges") with "convertToTSX throws `not yet implemented` in compiler-rs 0.4.0".
5. **Scope-hash provenance** (claim 7): not xxhash64 — Rust `DefaultHasher` (SipHash-1-3) + custom base32-like, over the normalized filename; algorithm may change across Rust std versions. Standing rule unchanged: read `TransformResult.scope`, never compute.
6. **Minor / e2e awareness** (claim 1): Astro's four unshifted pre-middlewares (secFetch, routeGuard, trailingSlash, base) run ahead of any body-registered middleware; keep builder traffic same-origin (spec'd anyway) — `secFetchMiddleware` 403s cross-origin subresource requests (`sec-fetch.js:29-36`).

## 5. What stays fully valid

The §1 architecture (body-middleware interception + `server.transformIndexHtml` + virtual-module chrome + `injectScript('page')` with dev guard) and the §4 CSS architecture (dev-css virtual module + module-graph walk + static postcss index as edit-truth + splice from `extractStylesSync` content offsets) are all sound on astro@7.2.7 / vite@8.2.2 / compiler-rs@0.4.0 — with the corrections in §4 above.
