# Release Loop Ops

Rewritten for the Electron parent-app rewrite (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210); rulings [#200](https://github.com/wojtekpiskorz/astroix/issues/200)/[#207](https://github.com/wojtekpiskorz/astroix/issues/207), ADR-0008/ADR-0010).

## Publication is paused

**npm publication — stable and snapshot — is paused by the rewrite.** The npm-migration lane (A2) pauses it mechanically; the retirement gate then deletes Changesets, publint, npm artifact staging, the integration release workflows, and these instructions' subject matter. Until then:

- Do not publish, and do not merge a Version Packages PR expecting a release; the loop below is **dormant provenance**, kept only while the workflow files still exist so no session fumbles the machinery if it fires.
- Changesets remain only as the every-code-PR-changeset convention; their accumulated queue is never released.
- The desktop app's workspace will carry the private `@wojciechpiskorz/astroix@0.1.0` manifest (unpublished); npm stays dormant.

If a release workflow does fire during the pause, treat it as an incident: approve nothing beyond what CI needs, and file the finding.

## Pre-alpha delivery (the loop that matters)

Delivery is the packaged unsigned macOS artifact (ADR-0008), at candidate checkpoints only:

1. Build the exact pinned artifact (Electron 44.1.0 / Forge 7.11.2 / stock Node 24.20.0; hardened fuses; ad-hoc-sealed ZIP) and its build manifest.
2. Upload to an **access-limited GitHub draft release** for the owner and named inner testers, with the published SHA-256 checksum per asset.
3. Download the exact candidate asset, verify the checksum, and run the owner manual smoke (`docs/manual-smoke.md`) on the extracted app.
4. Passing promotes **the same bytes** to the final tag/release — there is never a post-smoke rebuild. Record release evidence (per-step results, checksum, environment) and create the git tag. A discovered defect returns to its own implementation lane and produces a new candidate.

Qualification detail (resource discovery, process topology/cleanup, security settings, launch lifecycle, hostile Service Worker, reproducibility comparison) is ADR-0008's candidate gate — it runs here, not on feature PRs.

## Dormant npm-loop mechanics (provenance)

While `.github/workflows/release.yml` and `ci:publish` still exist, for reference only:

- `action_required` bot runs: approve per run with `gh api -X POST repos/wojtekpiskorz/astroix/actions/runs/<id>/approve`; find ids with `gh run list --branch changeset-release/main`.
- Version Packages PRs merged merge-commit style, never squash; the `changeset-release/main` branch is never deleted while the loop exists.
- Actions brownouts (~15–25 min, self-recovering; #99): empty-commit nudge → close/reopen the PR → after recovery, rebase onto the target and force-push (fresh `synchronize` first; old SHAs' events are gone).
- The repo setting **Allow GitHub Actions to create and approve pull requests** must stay on for the bot PR to appear.

These mechanics are deleted by the retirement lane; do not invest in them.
