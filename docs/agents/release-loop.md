# Release Loop Ops

Rewritten for the Electron parent-app rewrite (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210); rulings [#200](https://github.com/wojtekpiskorz/astroix/issues/200)/[#207](https://github.com/wojtekpiskorz/astroix/issues/207), ADR-0008/ADR-0010). The dormant npm-loop sections were deleted at the retirement gate ([#215](https://github.com/wojtekpiskorz/astroix/issues/215), lane A6) together with the machinery they described.

## Publication machinery is deleted

**There is no npm release loop.** The retirement gate (#215, lane A6, ADR-0010) deleted Changesets, the stable and snapshot release workflows, the npm artifact checks (publint, chrome artifact, dist graph), the npm-pack staging scripts, and the `ci:publish` chain, and made the root package private with no publishable artifact. The every-code-PR changeset convention died with the machinery.

- Do not publish, and do not reintroduce publication tooling — npm stays dormant through the pre-alpha; treat such requests as wontfix with a pointer to `docs/spec.md`.
- The desktop app's workspace will carry the private `@wojciechpiskorz/astroix@0.1.0` manifest (unpublished) when its lane creates it.

The deleted workflows exist only in git history; if anything resembling a release run ever appears, treat it as an incident: approve nothing beyond what CI needs, and file the finding.

## Pre-alpha delivery (the loop that matters)

Delivery is the packaged unsigned macOS artifact (ADR-0008), at candidate checkpoints only:

1. Build the exact pinned artifact (Electron 44.1.0 / Forge 7.11.2 / stock Node 24.20.0; hardened fuses; ad-hoc-sealed ZIP) and its build manifest.
2. Upload to an **access-limited GitHub draft release** for the owner and named inner testers, with the published SHA-256 checksum per asset.
3. Download the exact candidate asset, verify the checksum, and run the owner manual smoke (`docs/manual-smoke.md`) on the extracted app.
4. Passing promotes **the same bytes** to the final tag/release — there is never a post-smoke rebuild. Record release evidence (per-step results, checksum, environment) and create the git tag. A discovered defect returns to its own implementation lane and produces a new candidate.

Qualification detail (resource discovery, process topology/cleanup, security settings, launch lifecycle, hostile Service Worker, reproducibility comparison) is ADR-0008's candidate gate — it runs here, not on feature PRs.
