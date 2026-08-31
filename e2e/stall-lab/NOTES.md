# stall-lab attempt ledger (#171 lane, 2026-08-31)

Lane: worktree `../astroix-171`, branch `chore/boot-stall-root-cause`, ports
4383-4385 (reassigned from the assigned 4373/4374 — a sibling lane's src
server squatted 4373 mid-lane; all valid attempts below ran clean-verified).

## Valid attempts (no collision, ports verified free)

- iter 3-8 — single-spec `auto-write` runs, six GREEN (some with 5 steady CPU
  loops). Healthy test-1 durations 6.0-7 s — matching the #158 healthy
  cluster (6.8-7.9 s), so the harness was shape-faithful.
- full 1, 2, 3, 30 — full 87-test suites under bursty CPU (+30: also a cold
  deps-optimizer boot with live discovery), all GREEN (87 passed, 3.9-4.6 m).
- Instrumented healthy-path traces (env-gated TEMP tracing in the plugin,
  since reverted): chrome-module pipeline 69 ms - 1.8 s under load; document
  transform 2-42 ms; enum pass 17-395 ms; the crawl-end/optimizer machinery
  resolves normally. Caveat: those boots carried tracing env, so their
  optimizer state differed from pristine (see README warning).
- Deterministic mechanism repro: `probe/freeze-probe.mjs` (renderer SIGSTOP
  25 s on a warm healthy server) — module request 25.8 s, server-side
  response finish held for the whole freeze (socket backpressure on the
  7.85 MB payload), canvas visible 26.2 s, fresh page 1.8 s. The family
  signature, reproduced mechanically.
- Payload measurement: `/virtual:astroix/chrome` served 7,854,843 B =
  2,201,741 B code + 5,653,056 B inline base64 sourcemap appended by vite
  dev's `send` (only appended when the final map's `mappings` is truthy).

## Invalid attempts (kept for the lessons)

- iter 1-2 — port 4373 squatted by sibling lane astroix-166's src-fixture
  server: readiness polls answered by the wrong server, `page.goto`
  connection-refused, playwright refusing to start. Lesson: verify the trio
  is free before every batch.
- full 4, 5 — two campaign loops were started concurrently by mistake
  (sharing ports + fixture dirs): full-4's `✘ auto-write.spec.ts:94`
  (11.4 s — not a stall shape) and its sidecar capture are contaminated.
- full 6-11, iter 20-29 — same collision: all failed at boot
  ("port already used").
- full 31 — a REAL observer-effect casualty, not a family event: the sidecar
  fired on a false-positive trigger (inter-test quiet) and its
  `Debugger.pause` sampling froze the dev server for 143.7 s, manufacturing a
  2.6 m red in `body-editor.spec.ts` with zero server traces during the
  window. Valuable as a mechanism demonstration (a frozen loop reproduces
  the family observable exactly), invalid as family evidence. This is why
  the landed sidecar defaults pause sampling off.
- Earlier-lane probe data: the previous (stopped-early) agent's 12
  browser-load loops on :4373 showed implausibly fast 0.4 s "cold boots" —
  consistent with the same port collision answering their loads; treat as
  untrustworthy.

## Evidence mined from the #158 artifacts (/tmp/astroix-158-*)

- run-9 (builder spec, mid-suite): page snapshot shows the chrome FULLY
  mounted (sidebar, tabs, CSS panel, iframe present) — the stalled request
  was the canvas iframe's astro page, not the chrome module. The family
  stalls whichever dev request is in flight.
- auto-write reds (2, 6, 11, 12, 16, 17): `#astroix-canvas` not found for
  the full 45-105 s budget; next spec boots in 3.8-3.9 s. Runs 16/17 burned
  the entire 105 s budget including the gate's reload hop — the stall
  survived a reload and cleared only by next-spec time.
- No vite optimizer messages in any #158 run (no optimizer-rerun
  correlation available). No "Debugger" lines in any #158 run — the family
  was not inspector interference.

## Conclusion the chain supports

Server-side vite/astro pipelines are ms-scale under equal-or-harsher
contention; the observable reproduces mechanically from client-side renderer
starvation alone, with the 7.85 MB inline-sourcemap-amplified payload setting
the window's width. Follow-up decision (upstream scheduling report vs further
astroix-side hardening) lives in the follow-up issue; the #170 boot-gate
remains the mitigation layer.
