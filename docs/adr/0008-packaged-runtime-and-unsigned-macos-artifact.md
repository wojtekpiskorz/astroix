# Packaged runtime and unsigned macOS artifact

Status: accepted (2026-09-01, [Grilling: ratify the packaged runtime and unsigned macOS artifact contract](https://github.com/wojtekpiskorz/astroix/issues/207); packaged-host proof [#201](https://github.com/wojtekpiskorz/astroix/issues/201); lease packaged-integrity proof [#209](https://github.com/wojtekpiskorz/astroix/issues/209); recorded by lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210)). A deliberately minimal, testable pre-alpha contract that keeps the fast local feature loop.

## Context

The packaged-host proof ([#201](https://github.com/wojtekpiskorz/astroix/issues/201)) validated the process topology and lifecycle but left permanent artifact choices open: packager, bundled runtime, resource layout, sealing, delivery, and how much qualification a release needs without slowing every feature PR.

## Decision

### Supported product

- Version 1 ships **one macOS `arm64` application** for Apple Silicon (including M1); minimum **macOS 13.5** (the official Node 24 floor).
- Exact initial pins: **Electron 44.1.0, Electron Forge 7.11.2, stock Node 24.20.0**, and the certified `astro@7.2.10 + vite@8.2.2` pair. Every pin change requires packaged requalification.
- Astroix certifies that exact Astro/Vite pair and representative mainstream modern Astro tooling on its bundled Node runtime — not compatibility with every ecosystem package. A dependency that cannot run under the bundled runtime **fails before activation with a clear diagnostic and no managed-project mutation**. No fallback to developer Node, `nvm`/`fnm`, shell discovery, Rosetta, first-run download, or first-run native rebuild.

### Packager and runtime layout

- The permanent packager is exact-pinned **Electron Forge** using Packager, the Fuses plugin, and the ZIP maker. The Forge Vite plugin is not part of the runtime architecture.
- Electron-owned main and renderer code live in `app.asar`. The built control-plane and project-plane runtime plus their non-project dependencies live as **real immutable files** under `Contents/Resources/astroix-runtime/`. The exact stock Node binary lives under `Contents/Resources/node/`.
- Electron resolves private assets from `process.resourcesPath`; packaged paths stay behind an internal asset adapter and never leak into the public `ProjectRuntime` interface.
- A **build manifest** records the source commit, architecture, exact tool/runtime versions, and packaged-resource hashes; Astroix verifies its runtime resources before spawning them. The installed app bundle is immutable — registry, logs, and other mutable state use standard Electron locations (registry schema/locking/permissions/session semantics belong to ADR-0006).

### Release hardening

- The release artifact enables embedded **ASAR integrity** and only-load-app-from-ASAR, and disables **Electron RunAsNode**, **Electron `NODE_OPTIONS`**, and command-line inspection.
- Control-plane and project-plane processes execute with bundled stock Node, never Electron-as-Node.
- The packager explicitly applies an **ad-hoc signature** (identity `-`) after all resources and fuses are final; nested executable code is signed before the outer app.
- The deliverable is a **ZIP only**; verification runs again after ZIP extraction with strict `codesign` validation. The artifact is described as **ad-hoc sealed** — not Developer ID-signed, not notarized; Gatekeeper rejection is expected, so `spctl` acceptance is not a release gate.

### Identity and delivery

- Product name `Astroix`; bundle identifier `dev.astroix.app`; app data in the standard Astroix directory below Electron `userData` (no separate pre-alpha identity).
- Candidates are **access-limited GitHub draft releases** for the owner and named inner testers. The exact candidate asset is downloaded and smoked before publication; passing promotes the **same bytes** to the final tag/release — no post-smoke rebuild. Each asset carries a published **SHA-256 checksum**.
- Inner-tester onboarding documents browser download, checksum verification, Finder extraction, moving Astroix to Applications, the first blocked launch, System Settings Privacy & Security Open Anyway, project registration, known limits, and useful failure reporting. The instructions never remove quarantine attributes, invoke Terminal bypasses, or disable Gatekeeper.

### Minimal qualification and fast iteration

- Normal feature development uses the fast local web and app workflows; full packaging qualification belongs only to candidate/release checkpoints, never every feature PR. Web mode remains the deterministic full-behavior test host; a separately marked instrumented Electron build may test wiring but is never release evidence.
- The exact hardened release artifact is tested black-box (resource discovery, process topology and cleanup, security settings, launch lifecycle), then receives an owner Finder/UI smoke.
- The smallest final candidate gate: correct architecture and minimum-OS metadata; exact version and resource manifest; fuse state; extracted-app signature verification; zero injection; activation of representative registered projects; CSS and Content editing with HMR; A-to-B-to-A switching; quit and relaunch; one focused incompatible-dependency diagnostic. It does not grow into an ecosystem-wide fixture matrix.
- Candidate qualification compares two clean builds by normalized payload inventory and immutable hashes; version 1 makes no byte-identical-ZIP claim.
- The kernel-lease adapter's packaged-integrity gates bind here too ([#209](https://github.com/wojtekpiskorz/astroix/issues/209)): qualified only for the exact stock Node 24.20.0 pin (embedded SQLite 3.53.4 source ID `2026-07-24 19:02:57 bf7c7f30…`) on local APFS-class storage through the extracted, ad-hoc-signed Electron 44.1.0 package shape and the package-shaped exact bundled-Node launch on Ubuntu 24.04 x64; every bundled-Node pin change starts unqualified and must rerun the full two-platform matrix before release.

## Consequences

- Explicit non-goals (version 1): Intel or universal builds, broader hardware matrices, Developer ID signing, notarization, DMG packaging, auto-update, public distribution, custom Node selection, runtime-manager integration, exhaustive native-addon coverage, byte-identical archives, generalized edge-case hardening. NFS/SMB/network mounts, FUSE, cloud-synced state, removable media, and Windows are unsupported for the lease and the artifact.
- This ADR supersedes ADR-0001's delivery model (no foreign host remains) and records the release-evidence + tester-instruction duties of the final charter lane; the owner manual smoke lives in `docs/manual-smoke.md`.
- Packaging implementation terms stay out of `CONTEXT.md` unless they become genuine product-domain language.
