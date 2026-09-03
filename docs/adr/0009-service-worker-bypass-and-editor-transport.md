# Service Worker bypass and authoritative editor transport

Status: accepted (2026-09-01, [Research: service-worker control of the project app origin](https://github.com/wojtekpiskorz/astroix/issues/208); carried into the session contract by [#204](https://github.com/wojtekpiskorz/astroix/issues/204) §8; recorded by lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210))

## Context

Because the app shell and the project's pages share the `<project-key>.localhost` origin, a root-scoped Service Worker installed by the managed project could control Astroix's own surfaces. Electron 44.1.0 research and a focused proof ([evidence note](https://github.com/wojtekpiskorz/astroix/blob/de5916799ed161374370402803b9b3422d1ca16a/docs/research/issue-208-service-worker-origin.md), commit `de59167`) established what such a worker can and cannot intercept, and which supported Chromium mechanism prevents control without falsely claiming full project-page fidelity.

## Decision

- **The finding**: a project root-scoped Service Worker can intercept or replace the Astroix app shell, `/__astroix/*` control fetches, the natural canvas navigation and its resources, and the SSE stream. It cannot intercept **Vite HMR** — the WebSocket opening request uses Service Worker mode `none`.
- **Version 1 does not promise Service Worker or PWA fidelity inside the editor.** Astroix states this openly instead of simulating it.
- **The bypass**: the authoritative BrowserWindow and its same-origin canvas are created in a **fresh non-persistent Electron partition**. Before the first project navigation, Electron's debugger is attached to the editing `webContents`, CDP Network enabled, and `Network.setBypassServiceWorker({ bypass: true })` set — and retained.
- **Fail-closed on detach**: a failure to attach, enable, set, or retain the bypass makes the editing target **unready and disables edits**. On the pinned Electron 44.1.0, opening DevTools neither detaches `webContents.debugger` nor blocks its CDP commands, so the guard observes `devtools-opened` itself and fail-closes: DevTools is kicked off the authoritative target, the debugger slot is cleaned, and the target is compromised — **DevTools cannot share the authoritative editing target in version 1**. Recovery requires a fresh or reloaded target with the bypass restored before project content can become authoritative again. *Amended 2026-09-03 (owner ruling on PR [#356](https://github.com/wojtekpiskorz/astroix/pull/356), lane [#247](https://github.com/wojtekpiskorz/astroix/issues/247)): this bullet originally claimed "Opening DevTools detaches the debugger" after the Electron docs — empirically false on the pinned 44.1.0, where DevTools coexists with an attached `webContents.debugger` (commands still resolve; re-attach succeeds with DevTools open), proven by both real paths in the lane's legs (`e2e/desktop/service-worker-bypass.spec.ts`). The mechanism is corrected to the observed `devtools-opened` compromise; the acceptance criterion is unchanged — met, arguably stricter than contemplated.*
- **Cleanup as defense in depth**: after the old target unloads, its Service Worker registrations and Cache Storage are cleared. The attached bypass remains the authority invariant — cleanup alone would not be.
- The app shell and the plain iframe stay in the same target, so direct `iframe.contentDocument` access survives the partition and debugger mechanics (ADR-0004's same-origin contract is unaffected).
- **Editor transport** (settled alongside, per [#204](https://github.com/wojtekpiskorz/astroix/issues/204)): renderer commands are fetch under `/__astroix/`; server-to-renderer events are same-origin SSE at `/__astroix/events`; Vite HMR remains a separate, transparently proxied WebSocket — never an Astroix event channel.

## Considered Options

- **Blocking or unregistering project Service Workers from Electron session APIs**: not a supported per-editor-session control surface for the project's own origin, and it would fight the project's own behavior.
- **A separate partition or origin per surface**: breaks the required same-origin direct-DOM contract between app shell and canvas.
- **Accepting worker control and hardening endpoints only**: the app shell document itself would remain replaceable — control traffic hardening alone cannot recover document integrity.

## Consequences

- A root-scope hostile Service Worker that cannot intercept authoritative app/API/canvas/SSE traffic while native Vite HMR still works is mandatory qualification evidence (ADR-0006's matrix), as is debugger-detach fail-closed behavior.
- The authoritative target cannot be the DevTools target: diagnostics and debugging use the read-only diagnostic targets or the web host.
- The fresh non-persistent partition also carries the ADR-0006 client-binding mechanics (per-document client capability, one authoritative editor, read-only diagnostics).
