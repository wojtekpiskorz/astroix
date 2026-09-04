# The early packaged smoke (H6, #248)

The first exact packaged-host smoke: the **exact hardened ZIP** a local
`npm run package` produced (H3, #245), extracted and launched as the real
`Astroix.app` executable — never an instrumented development build — and
driven end-to-end through its real product surfaces only. This is
**early host evidence, not the final candidate** (ADR-0008: candidate
qualification is L1/L2's artifact-agnostic harness and the restricted
candidate; ADR-0008's owner Finder/UI smoke is L3's).

Local-only by law: the lane launches a real GUI binary, runs real
`codesign`/`ditto`/`pgrep`, and drives the real macOS native directory
picker through System Events. It is never part of `npm test` or CI.

## The command

```sh
npm run smoke:package                       # package --label early-smoke → smoke → record
npm run smoke:package -- --zip <path.zip>   # smoke an EXISTING build's ZIP (records which)
npm run smoke:package -- --force            # discard an UNCOMMITTED run and re-record
```

The recorded evidence lands in
`apps/desktop/test-results/early-package-smoke/` (`evidence.json` +
`run.log`) and is **write-once**: the no-rebuild-after-recording law
(#248's migration policy) — no upload, tag, publish, or rebuild after a
claimed exact run. A claim is a **committed** evidence record (git
history is the mechanism): `--force` refuses to discard one, so
superseding a claimed run requires an explicit `git rm` of the evidence
in its own commit before re-recording.

**Provenance of the committed record**: `evidence.json` names the source
commit the smoked ZIP was built at. The first recorded run (PR #361,
pre-review) was built at `21754f1`, before the #358 integration landed
on the branch — #358 was additive (`e2e/web` + `playwright.config.ts`),
touched nothing this battery runs, and the post-merge gates re-ran
green; the post-review re-record (the isolation-law harness fix) names
its own head. The composition flip (#360/#362) re-recorded before any
final claim, as this paragraph required: the #361 record was retracted
by `git rm` in its own commit (the write-once law), and the committed
record is the composition run (label `desktop-composition-362`).

## The battery

`e2e/desktop/early-package*.spec.ts`, wired into `npm run test:desktop`
(the H4/H5 additive-include idiom); each spec **self-skips** without a
local package build or its exact ZIP (the #339 pattern — `npm test`
stays deterministic and network-free). The shared machinery is
`e2e/desktop/early-package-kit.ts`: extraction (`ditto`), the isolated
launch (temp `HOME` + the product's `ASTROIX_DESKTOP_USER_DATA`
override + the browser-level `--user-data-dir` switch so Chromium's
early GPU/network helpers inherit the temp root too — asserted: no
process of the tree references the real account home; the product half
of that observation, the env override landing after the pre-boot
verification, is #363), the System Events driving
surface, and the post-run audits.

1. **Prelaunch verification** (`early-package-smoke.spec.ts`) —
   `verifyPackagedApp` over the smoke's own extraction: strict nested +
   outer `codesign` (adhoc), resources through the same adapter the app
   boots with (Node 24.20.0 / Electron 44.1.0 / Forge 7.11.2 pins, every
   SHA-256), release fuses off the real framework binary, bundle
   identity + min-OS 13.5 + asar integrity, single-arch arm64.
2. **Boot** — the app's own `control-plane-booted` line is the in-app
   verification's green light; the live process tree proves the
   control-plane child is the **bundled stock Node** running the rebased
   entry (never Electron-as-Node, never a discovered executable).
3. **Registration** — the REAL native flow: `File > Add Existing
   Project…` → the native directory picker (System Events) → the
   registry's sanitized `registered` summary (key, display name,
   availability — never a path), with the production versioned-JSON
   registry store created `0o700` under the isolated userData.
4. **The activation leg** (flipped at #362 from the H6 boundary leg) —
   the application menu carries the per-project `Activate <project>`
   entries, and a REAL activation drives the full hosting loop through
   the packaged composition: the settled transition over the
   kernel-leased production registry, the authoritative window replacing
   its top level onto the granted project origin, the launcher and
   project origins serving through the one loopback listener, the
   project's natural routes streaming through the proxy byte-identical,
   enforced admission on the reserved API, and the live HMR WebSocket
   through the raw-upgrade tunnel (see Flipped legs).
5. **Normal quit + audits** — the Apple-event quit (what Cmd+Q sends):
   `quit-settled` with `childStop: graceful`, exit 0, then the audits:
   zero stray processes referencing the staging root, zero listener
   sockets, zero temporary-root leftovers, the managed project
   byte-identical (the G3 zero-injection methodology), the canonical
   fixture clean in git, and the product log sanitized — no absolute
   paths, digests, PIDs, or ports, and every event inside the closed H1
   vocabulary.
6. **Tamper rejections** (`early-package-tamper.spec.ts`) — the H2
   fail-closed law firing in the real package, each over its own tampered
   extraction: a runtime-resource byte (`code=resource-tampered`), a
   swapped bundled Node (a working different Node is **never** a
   fallback), and a tampered manifest pin (`code=pin-mismatch`,
   field-level detail only). Each refuses BEFORE activation: exit 1,
   sanitized diagnostic, no product event, no child ever spawned.
7. **The repeated run** (`early-package-repeated-run.spec.ts`) — two
   consecutive full cycles over fresh extractions and fresh isolation
   roots: identical boot/quit shape, the same canonical root in both
   fresh registries (fresh CSPRNG ProjectKeys per registration —
   ADR-0006 §1, key equality is never the law), and the same
   zero-residue audits — no retained state, deterministic cleanup.

## Flipped legs (recorded at the composition, #362)

The migration policy's law ran its course: the boundary legs recorded at
#248 were reported to their owning issues, never hidden, and the
composition lane (#362, H7) flipped them in a recorded packaged run —
**13/13, exit 0**, the flip evidence posted on #248. The packaged
desktop host now **composes the production control plane** over its
kernel-leased production registry (the `unavailable-composition`
refusal is retired from the vocabulary): the origin listener, launcher
document, project origin, canvas, editing target, and HMR proxy are all
packaged and driven. The recorded leg statuses:

- **Activation with same-origin direct canvas DOM access** (AC-3) —
  flipped: the native menu drives the settled transition, the
  authoritative window (fresh editing partition, CDP bypass before
  navigation, H4 document authority injected) replaces its top level
  onto the granted origin, and the natural routes stream through the
  proxy byte-identical (zero injection).
- **Vite HMR through the packaged proxy** (AC-4, second half) — flipped:
  the canvas route lives on the project origin; the established
  upgrade-tunnel connection is the packaged evidence.
- **Document authority observed in the packaged app** (AC-4, first half)
  — flipped-half: the reserved API admission is enforced server-side in
  the packaged child (an unauthenticated mutation is unauthorized); the
  H4 injection and the H5 bypass are the composed load-bearing path, and
  their full enforcement observations remain the real-Electron lanes'
  truth (`e2e/desktop/document-authority-injection.spec.ts`).
- **Hostile Service Worker interception** — remains the real-Electron
  lane's truth (`e2e/desktop/service-worker-bypass.spec.ts`): the
  hostile-SW proof needs the hostile fixture the plain canonical copy
  never carries; the packaged app's editing target is bypass-guarded by
  construction.
- **The `CloseReport` half of AC-5** — flipped: quitting with the active
  session reaps the exact **runtime** children (the plane's worker and
  managed dev server) — graceful, zero strays, zero sockets, zero
  temporary-root leftovers.

The web host (`apps/web`, G1–G3, `e2e/web/**`) remains the behavioral
judge for the full builder loops and the switch races; the packaged
smoke proves the composed product path end to end.

## What the host needs

- macOS arm64, npm + Node 24 (the repo's stack of record).
- `e2e/fixture` installed (`npm install` there) — the managed copy is
  staged from it; the canonical fixture is never registered.
- System Events **Automation + Accessibility** for the lane host — the
  registration leg drives the real native picker; without it that leg
  skips with an explicit evidence line (everything else still runs).
