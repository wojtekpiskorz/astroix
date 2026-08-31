# Issue #198 standalone runtime-spine proof

Status: disposable evidence, not migration code.

## Run it

From the repository root:

```sh
bun spikes/issue-198-runtime-spine/run.mjs
```

The command exits `0` only when every assertion passes. It copies the tracked plain project to an OS temporary directory, performs source edits only in that copy, prints each result and metric, then removes the copy after bounded teardown and filesystem quiescence. A failed assertion exits `1` and remains failed. If teardown fails, the command prints every cleanup cause and retains the named temporary path.

Verified run on 2026-08-31:

```text
PASS runtime-spine proof
METRICS {"programmaticBootMs":1239,"runnerListeners":{"listenerCountBefore":null,"listenerCountDuring":null,"listenerCountAfter":null},"managedConfiguredPort":0,"managedBoundPort":61653,"managedForegroundBootMs":1420,"managedForegroundSteadyRssKiB":242048,"managedForegroundRssSampling":{"intervalMs":300,"maxSamples":15,"windowSize":5,"tolerancePercent":2,"minimumToleranceKiB":4096,"samplesKiB":[369248,357232,357232,343776,338848,314624,280096,276224,246112,242048,242048,242048,242048],"convergedWindowKiB":[246112,242048,242048,242048,242048],"toleranceKiB":4841,"steadyStateRssKiB":242048},"watchedDirectories":10,"watchedEntries":25,"watcherListeners":35,"managedForegroundShutdownMs":23,"managedForegroundShutdownEscalated":false,"astroVersion":"7.2.7","viteVersion":"8.2.2"}
```

The timing and memory values are observations from one local macOS arm64 run, not performance limits.

## What passed

- The tracked test subject is a plain Astro project. Its only integration is `runtime-spine:observer`, disposable instrumentation that exposes hook counts, routes, the Vite server and watcher counts. It has no Astroix dependency or integration.
- An HTTP/WebSocket reverse proxy served the app stand-in at `/lab/__astroix/app/` and the canvas at `/lab/__astroix/canvas/home/` on one origin. The parent read `contentDocument`, selected with `Element.matches()`, observed iframe navigation to `/lab/articles/first/`, and received a native Vite CSS hot update without reloading the canvas document.
- Astro's real configuration loaded outside `astro dev` through Astro's config pipeline. The result preserved `srcDir: ./site`, `base: /lab`, the `@fixture` alias, `scopedStyleStrategy: where`, and one observable `astro:config:setup` invocation.
- The outside selector pipeline joined a source parse with Astro's compiled dev HTML. It produced `.hero-title:where(.astro-7svzluqx)`. The source edit changed compiled CSS from `color: #0a141e` to `color: #28323c`, invalidated the outside result, and updated the live canvas.
- The independent current-behavior oracle ran a separate temporary server with the real current Astroix integration. Its endpoint supplied source ranges and effective selectors; its rendered page supplied compiled scoped CSS. Before and after the edit, the outside pipeline and oracle had byte-for-byte equal compiled CSS, equal effective selectors, equal source-range bytes and the same concrete match, `H1.hero-title`. The exact compiled outputs were `.hero-title:where(.astro-7svzluqx) {\n  color: #0a141e;\n}\n` and `.hero-title:where(.astro-7svzluqx) {\n  color: #28323c;\n}\n`. The browser CSSOM independently carried `rgb(10, 20, 30)` before and `rgb(40, 50, 60)` after.
- A fresh Vite server module runner imported the content config and `astro:content`, loaded two schema-backed entries, imported the resolved dynamic route and enumerated `first` and `second`, then closed in `finally`.
- The proof directly spawned a foreground `astro dev --port 0 --host 127.0.0.1` child and owned its `ChildProcess`. Disposable observer evidence recorded `config.server.port` as `0`; the CLI URL and Vite `httpServer.address()` independently agreed on the actual bound port, 61653. The child served the plain project and exposed the watcher snapshot. RSS sampling ran every 300 ms for at most 15 samples and required a five-sample window whose span did not exceed the greater of 4096 KiB or 2% of its median. The run converged on `[246112, 242048, 242048, 242048, 242048]` KiB. Its 4064 KiB span was within the 4841 KiB tolerance, so the recorded steady-state value is the 242048 KiB window median. A bounded SIGTERM stopped the exact owned child in 23 ms without SIGKILL escalation.
- Installed versions were Astro 7.2.7 and Vite 8.2.2.
- Every acquired server, browser, proxy and managed foreground child becomes cleanup-owned before later assertions run. The proxy start helper receives the canonical temp root, so an internal post-start teardown failure retains the real project path. Foreground-child shutdown uses one close promise attached immediately to the owned `ChildProcess`; it checks that object's `exitCode`, `signalCode` and close result, sends SIGTERM through the child object, waits up to 5 s, then sends SIGKILL through the same object with a separate 3 s bound if needed. It never uses a PID lookup as kill authority. After resources stop, the runner requires five unchanged 100 ms temporary-tree intervals, within a 3 s bound, before deletion. The proof disables Astro's asynchronous update check so it cannot recreate `.astro/settings.json` after the runner has removed the temp root. A work failure plus a teardown failure recursively prints every nested `AggregateError` and `cause`, and retains the canonical temporary project instead of deleting it under a possibly live process. Forced failures immediately after the plain server/proxy start and the managed foreground child start both exited `1`; their cleanup completed, removed both temporary roots and left no managed child PID.
- A safe `proxy-cleanup-report` probe closed the proxy, then injected nested teardown errors. The command retained `/private/var/folders/zk/tkmdgsd97nd6d4t1yd82hslr0000gn/T/astroix-runtime-spine-N9l9ZB`, printed the work error, cleanup aggregate, nested aggregate and both leaf errors through `ERROR.2.2.1`, and left no process using the path. The retained probe directory was then removed explicitly.

## Private and shape-coupled seams

1. Outside config loading imports Astro's unexported `dist/core/config/config.js`, `settings.js`, `logger/core.js` and `dist/integrations/hooks.js`. The proof calls `resolveConfig`, `createSettings` and `runHookConfigSetup` directly.
2. Programmatic server access imports Astro's unexported `dist/core/dev/dev.js`. Disposable config instrumentation exposes the Vite server through `globalThis[Symbol.for('astroix.runtime-spine.vite-server')]`.
3. Content and route evaluation use Vite's `createServerModuleRunner(server.environments.ssr)`. Route enumeration imports `astro:routes:resolved` entrypoints and calls their exported `getStaticPaths` shape. Runner closure is proven; the Vite 8.2.2 hot wrapper does not expose `listenerCount`, so listener-count deltas remain unproven and print as `null`.
4. The outside scoped-CSS join reads Astro dev HTML's `style[data-vite-dev-id]` shape and correlates source and compiled rules by rule order. It uses `@astrojs/compiler-binding` `extractStylesSync` and PostCSS source offsets.
5. The current-integration oracle uses the private `/__astroix/index` endpoint. The current implementation behind that endpoint depends on Vite's per-environment client module graph and transformed CSS module code.
6. The proxy's WebSocket bridge uses the already-installed transitive `ws` package. The spike adds no dependency. Production code would need to own and version this capability instead of relying on a transitive package.
7. Watcher metrics use `server.watcher.getWatched()`, `eventNames()` and `listenerCount()`. These are instrumentation shapes, not OS watcher-handle counts.
8. Astro 7.2.7's `dist/cli/server.js` background helper forwards the port only under the exact truthiness check `if (flags.port) args.push('--port', String(flags.port))`. Numeric `0` is dropped, so this pinned version's `astro dev --background --port 0` binds the default port instead of requesting an OS-selected port. The proof does not use that helper.
9. Astro 7.2.7's `dist/cli/dev/index.js` auto-selects background mode for detected agents under `!process.env.ASTRO_DEV_BACKGROUND && isRunByAgent()`. The directly spawned child sets `ASTRO_DEV_BACKGROUND=1`, without the `--background` flag, to keep `wantsBackground` false. That environment variable also makes Astro's lock metadata say `background: true`; the proof does not use the lock as lifecycle or foreground evidence.
10. Managed-process metrics parse the actual URL from foreground CLI output, compare its port with observer access to Vite's `httpServer.address()`, and use macOS `ps` only for RSS while the owned child is known live. Lifecycle and signals use the exact `ChildProcess` plus its immediately attached close promise; `ps` is not an identity or kill decision. The steady-state criterion is an operational proof threshold, not an Astro guarantee: five consecutive samples, 300 ms apart, must fit within the greater of 4096 KiB or 2% of their median, with a hard limit of 15 samples.
11. The proof sets `ASTRO_DISABLE_UPDATE_CHECK=true`. Without it, Astro's unawaited update check can write `.astro/settings.json` after `devServer.stop()` resolves and after the runner removes its temp root.

## What this does not establish

- It does not run Electron, a `BrowserWindow`, IPC, packaging, signing, auto-update, crash recovery, multi-project switching, TLS, authentication or remote access.
- It does not prove a stable public Astro API for config loading, Vite server ownership, route enumeration or dev CSS extraction. Those are version-pinned compatibility work.
- It does not establish `astro dev --background` as a valid port-zero lifecycle for Astro 7.2.7. The pinned helper drops numeric zero.
- It does not prove the watcher and memory numbers on another project, OS or runtime. The fixture is deliberately small. One converged local sampling window does not establish a general performance budget.
- It does not prove every selector shape. The fixture pins one scoped `where` rule. Astro 7.2.7 emits an `.astro-*` scope class for this strategy, so the rewrite must consume effective selectors rather than synthesize `data-astro-cid-*` attributes.
- It does not replace the existing E2E oracle or qualify a production rewrite.

## Rewrite contract implication

The Electron parent path is feasible if it owns one project origin, including HTTP routing and Vite WebSocket forwarding. It must treat Astro/Vite as a version-pinned adapter: load the real config, preserve hook execution, keep module runners short-lived and closed, and compare outside selector results against the current integration oracle during the rewrite. Astro 7.2.7's background helper cannot own an OS-selected port because it drops numeric zero. Managed-project lifecycle for this version must use a directly supervised foreground child or programmatic dev. The adapter must expose failures instead of falling back to guessed selectors, routes or content schemas. Process supervision and watcher budgets need production work; the proof only establishes the minimum working spine.
