# Release Loop Ops

The stable release loop (`.github/workflows/release.yml`, changesets/action) runs itself; the agent's part is two actions — approving the bot's workflow runs and merging its PR. Mechanics source of truth: `release.yml`, `ai-review.yml`, `package.json#ci:publish`. Live proofs: #101 (approve + skip), #99 (brownout).

## The loop

1. A feature PR carrying changesets merges to `main`. The `release` workflow then does one of two things:
   - **Non-empty changeset queue** → opens/updates the **Version Packages** PR on `changeset-release/main`.
   - **Empty queue** (that PR just merged) → `bun run ci:publish` (build → artifact check → publint → `changeset publish`) → npm latest, tag, GitHub Release.
2. CI on the Version Packages PR is the merge key. The advisory ai-review skips it by **branch guard** (`ai-review.yml`: `!startsWith(head.ref, 'changeset-release/')` — keyed on the branch prefix, not the actor, so a human reopen can't burn a review on generated output).
3. Merge a green Version Packages PR without re-asking — the owner's standing continuous-minimal-releases directive.
4. Verify the publish (below).

## `action_required` runs

PRs opened by the GITHUB_TOKEN bot land with their workflows awaiting approval. Approve per run:

```sh
gh api -X POST repos/wojtekpiskorz/astroix/actions/runs/<id>/approve
```

- Find ids with `gh run list --branch changeset-release/main`.
- Approve both runs. The CI one is the merge key; the ai-review one is safe to approve — its guard concludes it `skipped` within seconds, no GLM burn (proven on #101).

## Merge conventions

- Version Packages PRs merge **merge-commit style**, never squash.
- The `changeset-release/main` branch is **never deleted** — it belongs to the loop; the next bot PR reuses it.

## Actions brownouts

GitHub event delivery occasionally browns out (~15–25 min, self-recovering; #99 and #73's lane both recorded it). Symptom: a push landed but no runs appear, and nudges do nothing. Ladder, in order:

1. Empty-commit nudge: `git commit --allow-empty -m "chore: nudge ci"` and push.
2. Close/reopen the PR.
3. After recovery: rebase onto the target and force-push — the fresh `synchronize` lands first. Don't burn cycles re-running old SHAs; their events are gone.

## Publish verification

The release run fires on the merge push itself, typically done within minutes. Verify all three name the bumped version:

```sh
npm view @wojciechpiskorz/astroix version
git tag --sort=-creatordate | head -1
gh release list --limit 1
```

## Prerequisite

The repo setting **Allow GitHub Actions to create and approve pull requests** must stay on — off it, no bot PR is ever opened (recorded in `release.yml`).
