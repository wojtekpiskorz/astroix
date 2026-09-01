# Runtime topology, origin, and project introspection

Status: accepted (2026-08-31, [Grilling: ratify the runtime, origin, and project-introspection architecture](https://github.com/wojtekpiskorz/astroix/issues/202); adapter exact-pair proof [#206](https://github.com/wojtekpiskorz/astroix/issues/206); recorded by lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210))

## Context

With the parent-app boundary fixed (ADR-0004), the rewrite needed one settled runtime architecture: how many processes, who owns the managed dev server, where the project's real config executes, how the app shell and canvas share an origin without polluting the project, and through which interface the rest of the product touches a running project. The corrected runtime spine proof ([#189](https://github.com/wojtekpiskorz/astroix/issues/189), [#198](https://github.com/wojtekpiskorz/astroix/issues/198)) and the adapter proof ([#206](https://github.com/wojtekpiskorz/astroix/issues/206)) de-risked the choices.

## Decision

### Process topology

- **Electron main is a thin native host**: window, menus, single-instance behavior, application lifecycle, Electron security policy. Nothing else.
- **The trusted control plane is a separate long-lived Node-compatible process.** Web mode starts the same control-plane implementation as its test and diagnostic host.
- **The project plane is a disposable runtime group, not one OS process**: a project-runtime worker, the managed Astro dev server, the composition Vite server, fresh runners, watcher subscriptions, and timers. The control plane spawns and retains **exact child handles** for the project-runtime worker and the managed dev server as sibling children — a worker crash cannot orphan the managed server behind an unknown PID.
- The project plane is a failure and lifecycle boundary, not a sandbox (ADR-0004).
- **Normal stop**: first revoke the origin lease and close proxy sockets; the worker then rejects new inspection work and closes active runners, watcher subscriptions, timers, and the composition Vite server; the control plane terminates and reaps both children and returns **one recursive cleanup report**. A crash produces the same terminal cleanup path. Pre-alpha does not restart automatically.

### Origin and proxy contract

- One loopback port, selected at control-plane startup, stable for that process lifetime.
- Neutral launcher at `http://launcher.localhost:<port>/__astroix/app/`; active project app at `http://<project-key>.localhost:<port>/__astroix/app/` (project-key derivation: ADR-0006).
- `/__astroix/` is Astroix's reserved namespace (app assets, control requests, events). A managed project claiming it fails compatibility validation.
- The canvas loads the project's **natural URL** including its resolved Astro `base` on the active project hostname — no synthetic canvas-path rewrite.
- Every non-reserved HTTP request streams to the managed Astro dev server. WebSocket upgrades preserve the request URL, Host, Origin, HMR token, `vite-hmr` subprotocol, and the upstream handshake bytes — the proxy **never synthesizes a `101`**.
- A project switch replaces the project session and performs top-level `location.replace()` to the new project hostname; it never swaps project data inside the old origin.
- The **same-origin direct-DOM canvas remains the selector-engine contract**: the app shell reads `iframe.contentDocument`, observes navigation, and applies `Element.matches()` to effective selectors from Astro's real output.

### ProjectRuntime interface

```ts
interface ProjectRuntime {
  start(input: StartProject): ProjectRun;
}

interface ProjectRun {
  readonly ready: Promise<ReadyDescriptor>;
  inspect<R extends InspectionRequest>(request: R): Promise<InspectionResult<R>>;
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe;
  stop(reason: StopReason): Promise<CloseReport>;
  readonly closed: Promise<CloseReport>;
}
```

- `start()` returns the handle immediately, so startup can be observed and stopped. `ready` fulfills only after version certification, both project-plane children, the composition pipeline, the origin route, and a proxy health check are ready. `stop()` is idempotent; it and `closed` settle with the same `CloseReport` after cleanup. Startup failure and child crash are terminal close causes, not callable methods or stable running states.
- The interface exposes **no PID, upstream port, Vite handle, runner, watcher, timer, or raw project path**.
- `inspect()` accepts only typed `project`, `content`, `routes`, and `styles` requests (`project`: resolved base, source directory, scoped-style strategy, certified versions; `content`: collections, entries, schemas; `routes`: route patterns and enumeration results; `styles`: the static source index joined with effective selectors from real Astro output). Every result carries a **monotonic resource revision**. No arbitrary module import, no evaluation, no client-selected filesystem path, no raw Vite access. File-resource handles and writes belong to edit authority (ADR-0006).
- `subscribe()` emits revisioned invalidations and structured diagnostics. Renderer commands use fetch under `/__astroix/`; server-to-renderer events use same-origin SSE at `/__astroix/events`; canvas HMR stays a separate, transparently proxied Vite WebSocket.

### Real configuration and duplicate hooks

- The managed dev server **and** the composition inspector both load the project's real Astro configuration from the project installation; project integrations therefore execute twice. This is an explicit, accepted pre-alpha compatibility cost, confined to the disposable project plane.
- `configFile: false` is not a full-fidelity fallback and may never be reported as equivalent introspection.
- Content, route, and schema work uses a **fresh Vite server module runner per inspection pass, closed in `finally`**.
- Startup and compatibility evidence must include observable duplicate-hook behavior and a non-idempotent integration case with a clear failure diagnostic.

### Compatibility contract

- Astroix supports the latest stable Astro available when an Astroix release ships — not any upstream release before Astroix certifies and releases its adapter update. Acceptance is driven by **certified exact Astro/Vite pairs**; the first executed proof is `astro@7.2.10 + vite@8.2.2` ([#206](https://github.com/wojtekpiskorz/astroix/issues/206)).
- Astro and Vite resolve from the managed project's own installation. Certification records the exact tested pair and expands only after the compatibility fixture and migration oracle pass. An **uncertified pair fails before project config executes**, reporting the detected pair, certified pairs, and the rejected contract.
- All version-sensitive behavior lives behind the internal **`AstroProjectAdapter`** (Astro internal imports, `virtual:astro:*` identifiers, module-runner behavior, module-graph reads, compiled-CSS shapes). An unknown shape **fails closed**; the adapter never guesses routes, schemas, or selectors. Seam classes: `docs/core-reuse.md`.

## Consequences

- Two ADRs were required before implementation lanes: the product/trust ADR (ADR-0004) and this one.
- The rewrite documentation replaced the legacy integration assumptions in `docs/spec.md`, `docs/stack.md`, `docs/core-reuse.md`, and `CONTEXT.md`; ADR-0001 was superseded, ADR-0002 retained with amendments, ADR-0003 remained in force.
- Deep modules hide process IDs, ports, Vite handles, runners, watchers, and proxy details — downstream lanes code against `ProjectRuntime`, never against the topology.
- Registry, session generations, switching, and resource-authority semantics are ADR-0006's; the packaged runtime layout is ADR-0008's.
