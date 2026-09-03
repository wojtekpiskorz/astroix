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
its own head. Either way, the composition flip (#360) re-records before
any final claim.

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
verification, belongs to its owning lane), the System Events driving
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
4. **The honest boundary leg** — the application menu is pinned to H1's
   closed product set (registration, no activation entry) and no session
   lifecycle exists: the desktop control-plane composition is not
   packaged (see Blocked legs).
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

## Blocked legs (recorded, not hidden)

The migration policy's law: a product gap the smoke finds is reported to
its owning issue, never hidden by the harness. At #248 the packaged
desktop host **does not compose the control-plane activation**: the
control-plane child answers the settled `unavailable-composition`
refusal; no origin listener, launcher document, project origin, canvas,
editing target, or HMR proxy is packaged. Consequently:

- **Activation with same-origin direct canvas DOM access** (AC-3) —
  blocked on the missing desktop composition seam.
- **Hostile Service Worker bypass + document authority observed in the
  packaged app** (AC-4, first half) — the H4/H5 surfaces are pure seams
  proven by their own real-Electron harness lanes; no packaged editing
  target exists to observe them on.
- **Vite HMR through the packaged proxy** (AC-4, second half) — no
  project origin/proxy is composed into the packaged host.
- The `CloseReport` half of AC-5 (reaping exact **runtime** children —
  the project plane's worker and managed dev server) requires a run that
  only activation can create; the packaged quit's own reap (the
  control-plane child, `graceful`) is proven.

The web host (`apps/web`, G1–G3, `e2e/web/**`) remains the behavioral
judge for exactly these laws until the composition lands; the boundary
leg in the smoke pins today's product surface so the composition lane
flips the spec at a named spot.

## What the host needs

- macOS arm64, npm + Node 24 (the repo's stack of record).
- `e2e/fixture` installed (`npm install` there) — the managed copy is
  staged from it; the canonical fixture is never registered.
- System Events **Automation + Accessibility** for the lane host — the
  registration leg drives the real native picker; without it that leg
  skips with an explicit evidence line (everything else still runs).
