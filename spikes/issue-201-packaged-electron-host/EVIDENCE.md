# Packaged Electron host and lifecycle proof

Resolution evidence for [Task: prove the packaged Electron host and process lifecycle](https://github.com/wojtekpiskorz/astroix/issues/201), under [Wayfinder map: final Astroix Electron parent-app architecture and rewrite charter](https://github.com/wojtekpiskorz/astroix/issues/197).

The proof passed on 2026-08-31. It is a disposable architecture probe, not product code and not a permanent packaging choice.

## Environment and artifact

- macOS 26.3.1 (25D771280a), arm64
- host Node 22.22.3 and Bun 1.3.14
- Electron 44.1.0, downloaded from the official release URL and checked against SHA-256 `9e624a8c44dee2792a532551f224ec8b8649b654a0e039416164fbf620888512`
- packaged Electron Node 24.19.0, module ABI 149, `process.versions.openssl` `0.0.0`
- Astro 7.2.7 and Vite 8.2.2 from the managed project's installation
- manual `Contents/Resources/app` assembly, with no Forge, Builder, or new repository dependency
- renamed native `.app` executable; `app.isPackaged === true`
- ad-hoc arm64 code signature, no Developer ID, no notarization, and no quarantine attribute
- `codesign --verify --deep --strict` passed; `spctl --assess` rejected the artifact with exit 3

“Unsigned” here means unsigned for distribution: no identity and no notarization. The ad-hoc seal is needed for a locally assembled native arm64 bundle and is not Gatekeeper approval.

## Proven topology

Electron main owns the `BrowserWindow`, command-line single-instance lock, asynchronous quit gate, live renderer policy, and one exact control-plane child. It does not run project configuration, Astro, the composition server, the proxy, watchers, or timers.

The packaged Electron executable starts the control plane in Node mode with `shell: false`. The control plane retains two sibling handles per project run:

- a disposable composition worker;
- the managed project's exact local Astro command.

The public project-run surface returns immediately and contains `ready`, `inspect`, `subscribe`, idempotent `stop`, and `closed`. The exercised `project` inspection is revisioned and reports the fixture's base, project-relative source directory, scoped-style strategy, and certified Astro/Vite pair. The subscription emits its revisioned project invalidation and can be unsubscribed. Public inspection and close reports contain no PIDs or child-process objects. Fault injection, lifecycle state, and PID collection live behind proof-only `WeakMap` helpers.

The control plane owns one configured port for its lifetime on both `127.0.0.1` and `::1`. Each project uses `<key>.localhost` on that port. The app is served at `/__astroix/app/`; the iframe uses the project's natural `/lab/home/` route. HTTP preserves the virtual Host. WebSocket upgrades are raw tunnels rather than terminated and recreated WebSockets. Project teardown removes the route and destroys that project's tracked HTTP and raw-upgrade sockets before child termination begins.

## Observed matrix

| Case | Observed result |
| --- | --- |
| Packaged launch | The renamed `.app` executable started Electron main, a separate control plane, a composition worker, and project-local Astro. |
| Shell independence | The incoming `PATH` contained only fake `node`, `astro`, and `sh` sentinels. None ran. The project path contained spaces, `;`, and `$`. Every spawn used an executable plus argv and `shell: false`. |
| Environment boundary | `NODE_OPTIONS` and a proof secret reached Electron main but not the control or project children. Child environments were constructed explicitly. |
| Same-host canvas | App and natural-base canvas had the same virtual project origin and direct `contentDocument` access. Project JavaScript could reach the parent DOM, as required by the trusted-project contract. |
| HMR | A CSS source edit reached the canvas without a document reload. The tunnel preserved Host, Origin, URL token, `vite-hmr`, and the upstream `HTTP/1.1 101 Switching Protocols` bytes. |
| Switch | Two concurrent requests produced one `200` and one `409`. Renderer JavaScript then called `location.replace()` with the winning result, and main consumed one exact next-origin permit. The old route and its live sockets were revoked before either old child closed; the retired hostname returned `421`. A separately injected permit failure revoked and reaped both candidate children while alpha remained active. |
| Startup cancel | Stop during startup rejected `ready`, terminated both children, and returned the same close promise from repeated `stop()` calls. |
| Startup timeout | A non-listening managed command timed out in 250 ms, terminated both children, and became terminal. |
| Composition-failure classification | A preconfigured worker fatal signal produced the distinct composition-failure close cause and sibling cleanup; it was not mislabeled as a timeout. This did not induce a real composition resource failure. |
| Graceful stop | Normal workers exited after `SIGTERM`; managed Astro exited without escalation. |
| Forced stop | An ignore-TERM worker escalated to bounded `SIGKILL`; its Astro sibling still stopped without escalation. |
| Worker crash | Exact worker `SIGKILL` made the run terminal, stopped Astro, and did not auto-restart. Explicit restart produced new child PIDs. |
| Astro crash | Exact Astro `SIGKILL` made the run terminal, stopped the worker, and did not auto-restart. Explicit restart produced a running session. |
| Control crash | Main observed exit 86, used only the live child's transient POSIX process group to clear descendants, observed port release, then performed an explicit restart. |
| Renderer crash | The project session route was revoked before its children stopped. Editing stayed disabled and no replacement window was created. |
| Normal app quit | The first `before-quit` was prevented, the bounded control close report completed, the second quit exited 0, the registry lock was released, and the listener and children disappeared. |
| Abrupt main exit | `SIGKILL` of Electron main closed the control IPC channel. The control plane stopped both exact children and released its resources. |
| Electron singleton | A second command-line launch exited without spawning another control plane; the primary retained one window. |
| Registry writer | A direct second control plane using the same proof registry failed with exit 73 before binding or spawning project children. |
| Port writer | A direct control plane with a separate registry but a foreign listener on its configured port failed with exit 74 (`EADDRINUSE`). |

## Live renderer policy

The running window reported `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and `webviewTag: false`, with no preload.

Both app and canvas saw no `process`, `require`, Electron global, IPC renderer, or preload bridge. The proof observed both permission handlers denying geolocation, denied `window.open` and `_blank`, denied a download, rejected external and wrong-project top-level navigation, blocked `file:`, `data:`, and `javascript:` effects, and denied an external iframe navigation. A representative same-origin edit operation returned `204` before that canvas denial and `423` after the main process revoked edit authority in the control plane.

## Measurements

- packaged readiness: 5,934 ms
- normal shutdown: 241 ms
- live process family: 7 processes
- aggregate RSS at the measurement point: 888.1 MiB
- public project-run handle return: below 1 ms in the recorded runs

These are observations, not performance gates.

## Limits and final-charter requirements

The proof deliberately does not settle these points:

- `ELECTRON_RUN_AS_NODE` worked, so the packaged `runAsNode` fuse was enabled. This remains proof-only because it binds project execution to Electron's Node ABI, BoringSSL behavior, and fuse policy. The implementation charter must exercise an ABI-sensitive native-addon project and retain bundled stock Node as the zero-injection fallback. `utilityProcess.fork` avoids the fuse dependency but not the Electron ABI.
- The stale lock recovery used after an induced control crash is a disposable adapter. [Grilling: ratify the registry, project-session, and edit-authority contract](https://github.com/wojtekpiskorz/astroix/issues/204) owns registry generations, stale recovery, project keys, and edit authority.
- Only revisioned `project` inspection and subscription mechanics were exercised here. Real `content`, `routes`, and `styles` inspection, real configuration discovery, duplicate-hook behavior, and fail-closed adapter certification remain with the separate `AstroProjectAdapter` proof required by the runtime ruling.
- The switch rollback probe injected a rejected navigation permit. The final charter must also retain a live main-frame load-failure rollback case.
- The composition-failure case verifies fatal classification and sibling cleanup, not a failure raised by a real composition resource.
- The transient process group is valid only while main retains the exact live control child. It is not persisted kill authority. Parent IPC disconnect covers ordinary abrupt-main death, but a control plane that hangs at the same time, a descendant that calls `setsid()`, reaping of non-child descendants, and detached descendants remain explicit limits.
- The run proves a local, non-quarantined, ad-hoc-signed arm64 bundle. It does not prove Finder launch, Intel, Rosetta, Developer ID, Hardened Runtime, notarization, quarantine acceptance, Gatekeeper override UX, updates, or public distribution.
- Manual unpacked assembly is only the cheapest proof route. The permanent packaging tool remains undecided.
- The implementation charter must retain live negative tests for permissions, popup and navigation policy, renderer crash, independent singleton/registry/port collisions, switch rollback, startup cancel/timeout, both project-child crashes, control crash, quit, abrupt-main cleanup, raw HMR upgrade fidelity, and no automatic restart.

## Reproduce

From this branch and worktree:

```bash
bun install --frozen-lockfile
bun run prepare-local
node --test spikes/issue-201-packaged-electron-host/test/*.test.mjs # 20 tests
node spikes/issue-201-packaged-electron-host/run.mjs
```

`run.mjs` verifies the pinned Electron archive, assembles and ad-hoc-signs a temporary app, executes the matrix, prints `PROOF_REPORT`, and deletes the temporary tree only after a pass. A failure retains the package, configs, and JSONL traces. Primary-source notes are in [UPSTREAM.md](./UPSTREAM.md).
