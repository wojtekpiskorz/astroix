# Issue #198 standalone runtime-spine proof

Status: disposable evidence, not migration code.

## Run it

From the repository root:

```sh
bun spikes/issue-198-runtime-spine/run.mjs
```

The command exits `0` only when every assertion passes. It copies the tracked plain project to an OS temporary directory, performs source edits only in that copy, prints each result and metric, then removes the copy. A failed assertion exits `1` and remains failed.

Verified run on 2026-08-31:

```text
PASS runtime-spine proof
METRICS {"programmaticBootMs":1054,"runnerListeners":{"listenerCountBefore":null,"listenerCountDuring":null,"listenerCountAfter":null},"managedCliBootMs":1884,"managedCliSteadyRssKiB":363376,"watchedDirectories":10,"watchedEntries":27,"watcherListeners":35,"managedCliShutdownMs":404,"astroVersion":"7.2.7","viteVersion":"8.2.2"}
```

The timing and memory values are observations from one local macOS arm64 run, not performance limits.

## What passed

- The tracked test subject is a plain Astro project. Its only integration is `runtime-spine:observer`, disposable instrumentation that exposes hook counts, routes, the Vite server and watcher counts. It has no Astroix dependency or integration.
- An HTTP/WebSocket reverse proxy served the app stand-in at `/lab/__astroix/app/` and the canvas at `/lab/__astroix/canvas/home/` on one origin. The parent read `contentDocument`, selected with `Element.matches()`, observed iframe navigation to `/lab/articles/first/`, and received a native Vite CSS hot update without reloading the canvas document.
- Astro's real configuration loaded outside `astro dev` through Astro's config pipeline. The result preserved `srcDir: ./site`, `base: /lab`, the `@fixture` alias, `scopedStyleStrategy: where`, and one observable `astro:config:setup` invocation.
- The outside selector pipeline joined a source parse with Astro's compiled dev HTML. It produced `.hero-title:where(.astro-7svzluqx)`. The source edit changed compiled CSS from `color: #0a141e` to `color: #28323c`, invalidated the outside result, and updated the live canvas.
- The independent current-behavior oracle ran a temporary copy with the real current Astroix integration, read `/__astroix/index`, and matched the effective selector against the browser DOM. Before and after the edit, the oracle and outside pipeline had equal effective selectors, equal source-range bytes and the same concrete match, `H1.hero-title`. The browser CSSOM carried `rgb(10, 20, 30)` before and `rgb(40, 50, 60)` after.
- A fresh Vite server module runner imported the content config and `astro:content`, loaded two schema-backed entries, imported the resolved dynamic route and enumerated `first` and `second`, then closed in `finally`.
- `astro dev --background --port 0 --host 127.0.0.1` reported an ephemeral port and daemon PID, served the plain project, exposed the watcher snapshot, and stopped through `astro dev stop`. The measured daemon RSS was 363376 KiB. Shutdown took 404 ms.
- Installed versions were Astro 7.2.7 and Vite 8.2.2.

## Private and shape-coupled seams

1. Outside config loading imports Astro's unexported `dist/core/config/config.js`, `settings.js`, `logger/core.js` and `dist/integrations/hooks.js`. The proof calls `resolveConfig`, `createSettings` and `runHookConfigSetup` directly.
2. Programmatic server access imports Astro's unexported `dist/core/dev/dev.js`. Disposable config instrumentation exposes the Vite server through `globalThis[Symbol.for('astroix.runtime-spine.vite-server')]`.
3. Content and route evaluation use Vite's `createServerModuleRunner(server.environments.ssr)`. Route enumeration imports `astro:routes:resolved` entrypoints and calls their exported `getStaticPaths` shape. Runner closure is proven; the Vite 8.2.2 hot wrapper does not expose `listenerCount`, so listener-count deltas remain unproven and print as `null`.
4. The outside scoped-CSS join reads Astro dev HTML's `style[data-vite-dev-id]` shape and correlates source and compiled rules by rule order. It uses `@astrojs/compiler-binding` `extractStylesSync` and PostCSS source offsets.
5. The current-integration oracle uses the private `/__astroix/index` endpoint. The current implementation behind that endpoint depends on Vite's per-environment client module graph and transformed CSS module code.
6. The proxy's WebSocket bridge uses the already-installed transitive `ws` package. The spike adds no dependency. Production code would need to own and version this capability instead of relying on a transitive package.
7. Watcher metrics use `server.watcher.getWatched()`, `eventNames()` and `listenerCount()`. These are instrumentation shapes, not OS watcher-handle counts.
8. Managed-process metrics parse Astro CLI output for the URL and daemon PID, use macOS `ps` for RSS, and use Astro's background lock plus `astro dev stop` for shutdown.

## What this does not establish

- It does not run Electron, a `BrowserWindow`, IPC, packaging, signing, auto-update, crash recovery, multi-project switching, TLS, authentication or remote access.
- It does not prove a stable public Astro API for config loading, Vite server ownership, route enumeration or dev CSS extraction. Those are version-pinned compatibility work.
- It does not prove the watcher and memory numbers on another project, OS or runtime. The fixture is deliberately small.
- It does not prove every selector shape. The fixture pins one scoped `where` rule. Astro 7.2.7 emits an `.astro-*` scope class for this strategy, so the rewrite must consume effective selectors rather than synthesize `data-astro-cid-*` attributes.
- It does not replace the existing E2E oracle or qualify a production rewrite.

## Rewrite contract implication

The Electron parent path is feasible if it owns one project origin, including HTTP routing and Vite WebSocket forwarding. It must treat Astro/Vite as a version-pinned adapter: load the real config, preserve hook execution, keep module runners short-lived and closed, and compare outside selector results against the current integration oracle during the rewrite. The adapter must expose failures instead of falling back to guessed selectors, routes or content schemas. Process supervision and watcher budgets need production work; the proof only establishes the minimum working spine.
