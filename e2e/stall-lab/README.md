# stall-lab — boot-stall family repro kit (#171 / #158 / #129)

Durable home for the investigation tooling behind the e2e boot-stall family:
the request-path elimination chain, the load generators, and the deterministic
frozen-renderer mechanism repro. The lane's full attempt ledger lives in
`NOTES.md` (kept honest: contaminated attempts are marked INVALID).

## What the family is

Under ambient machine load, the first chrome-module request (or mid-suite, a
canvas-page request — see run-9 in the #158 artifacts) stalls for 45-105 s:
bimodal (healthy ~7 s vs full budget loss, nothing between), request-scoped
(the next fresh page boots in ~4 s), scaling with ambient load, never resolving
on its own within the budget.

## What the lane established (2026-08-31, lane ports 4383-4385)

1. **Server-side pipeline exonerated**: instrumented request-path traces show
   a healthy cold boot's chrome-module pipeline at 69 ms - 1.8 s under heavy
   contention (2.2 MB prebuilt bundle: plugin `load` 4-9 ms, transform+serve
   ~70 ms - 1.8 s; document transform 2-42 ms). CPU starvation of the vite
   transform pipeline cannot produce the observed 45-105 s.
2. **The wedge is client-side renderer starvation, mechanically reproduced**:
   `probe/freeze-probe.mjs` SIGSTOPs the tab's renderer for 25 s mid-boot on a
   warm, healthy server. Observed: module request 25.8 s (the server's
   response start-to-finish is held in socket backpressure for exactly the
   freeze), canvas visible at 26.2 s, next fresh page 1.8 s — the family
   signature end-to-end.
3. **The amplifier was ours**: vite dev inlines the module's transform
   sourcemap as a base64 data URL; for the prebuilt chrome bundle that is
   5.65 MB of dead weight on top of 2.2 MB of code (72% of the wire). The
   chrome-payload guard (`src/node/vite-plugin.ts`) drops it (empty-mappings
   map is vite `send`'s off-switch), cutting boot wire bytes ~3.5x. The #170
   boot-gate remains the mitigation layer for the starvation itself.

## Using the kit

Run everything from the repo root (probes import `playwright` from the root
`node_modules`). Ports default to the 4383-4385 lane trio — reassign via
`ASTROIX_E2E_PORT` / `ASTROIX_E2E_PACK_PORT` / `ASTROIX_E2E_SRC_PORT` when
sibling lanes are live, and never share a server with another lane.

- `burst.sh <minutes>` — CPU pressure: waves of 2-8 s hash loops, 3-6 at a time.
- `io-burst.sh <minutes>` — IO pressure: tar/stat storms (spotlight-shaped;
  macOS load averages count uninterruptible IO wait).
- `pristine-iter.sh <n> <burst-mins>` — one faithful full-suite run under
  pressure, artifacts preserved to `$OUT_DIR` (default `/tmp/astroix-stall-lab`).
- `campaign.sh <first> <last>` — serial pristine iterations alternating
  pressure profiles. Serial only: ports and fixture dirs are single-lane.
- `monitor.sh <tag>` — port/process watcher (safe observer).
- `probe/browser-load.mjs <url> <run>` — first page load with per-request
  timing; the canvas-visible line is the boot outcome.
- `probe/freeze-probe.mjs <url> <freeze-secs> <run>` — the deterministic
  mechanism repro (safe: touches only the browser's renderer process).
- `probe/inspector-probe.mjs <port> pause|profile` — inspector sampler.
- `probe/inspect-pending.mjs <port>` — live vite `_pendingRequests` dump
  (needs a temporary `globalThis` server stash in the plugin — see the probe's
  header).

## Observer-effect warnings (paid for in-lane, keep them)

- **Never launch the dev server with `NODE_OPTIONS=--inspect` or extra env
  vars for tracing**: env feeds vite's config hash — the boot then
  re-optimizes dependencies and is structurally different from the pristine
  family ("Re-optimizing dependencies because vite config has changed").
  If a stall is live, flip the inspector on post-hoc:
  `node -e "process._debugProcess(<pid>)"`.
- **`inspector-probe.mjs pause` freezes the dev server while sampling** — a
  capture battery that pauses mid-suite manufactures exactly the red it hunts
  (done once in-lane: a false-positive trigger + pause sampling turned a
  healthy run into a 2.6 m red). The sidecar therefore defaults to the safe
  probes (CPU snapshot, CPU profile, state eval); opt into pause sampling with
  `SIDECAR_PAUSE=1` only against a run you are willing to sacrifice.
- Two campaign loops sharing ports/fixtures contaminate each other's boots —
  run one at a time (see NOTES.md, the full-4..11 lesson).
