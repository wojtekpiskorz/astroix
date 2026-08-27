# Release channels on npm with changesets — research findings

Ticket: [#43](https://github.com/wojtekpiskorz/astroix/issues/43) (child of wayfinder map #39).
Branch: `research/release-channels`. Research date: 2026-08-27.
All claims traced to primary sources (official changesets guides + changesets source on `main` (CLI v3 line, matching our `@changesets/cli@^3.0.1`), changesets/action README + release, npm CLI docs v12, npm policies). Sources listed at the end.

## Constraints (from the ticket + repo state)

- One public package: `@wojciechpiskorz/astroix`, currently `0.0.1`, `publishConfig.access: public`.
- Owner publishes with a **granular access token (GAT)**; npm registry metadata propagation lag is a known annoyance.
- Want: **stable `latest` always** + an **experimental build publishable from `main` HEAD by CI without ceremony**.
- Repo currently has **18 accumulated changesets** and no release workflow yet (only `ci.yml`).

## TL;DR recommendation

1. **Stable channel**: the canonical changesets/action loop on `main` (Version Packages PR → merge → `changeset publish` → `latest`). Release cadence is "as often as you merge the version PR"; nothing about the experimental channel slows it down.
2. **Experimental channel**: **snapshot releases** (`changeset version --snapshot experimental` + `changeset publish --tag experimental --no-git-tag`) run **directly by a small CI job** (workflow_dispatch), in an ephemeral workspace, never pushed back. Zero repo-state ceremony, `latest` can never move, and `main`'s changeset queue is untouched.
3. **Keep pre mode out of the steady state.** It is a repo-wide mode that suspends stable releases and *hard-blocks snapshots*. Reserve it for a future real major beta (e.g. `1.0.0-rc`).
4. **Don't use plain dist-tag layering as the mechanism**: it either burns the accumulated-changesets queue on a non-`latest` release (requiring manual, lag-prone promotion) or needs out-of-changesets manual versioning.

Caveats that come with the recommendation are in [Adopting notes](#adopting-notes-if-we-go-with-the-recommendation).

---

## Option A — changesets `pre` prerelease mode

Mechanics (per the [prereleases guide](https://changesets.dev/guide/prereleases)):

- `changeset pre enter beta` writes `.changeset/pre.json` — the mode is **repo-wide state committed to the branch**. Switching tags mid-mode means hand-editing `pre.json`.
- `changeset pre exit` only records intent; you then run `version` + `publish` as usual to get stable versions back on `latest`.

| Question | Answer |
| --- | --- |
| Publish experimental from `main` HEAD without ceremony? | **No.** Pre mode is a long-lived state you enter/exit; every release while in it is a prerelease of the *next* version. The guide itself calls the flows complicated. |
| Consumers always keep stable `latest`? | Mostly yes (publishes go to the pre tag automatically) — **except** a package that has never had a normal release: npm requires a `latest`, so the first-ever publish during pre mode **also lands on `latest`** (guide + CLI warning). We are unpublished at `0.0.1`, so this bites us unless we cut one stable release first. |
| Interaction with the changesets queue | Distinctive but delicate: in pre mode `changeset version` **moves** consumed changeset files to `.changeset/pre/` instead of deleting them (verified in [`apply-release-plan/src/index.ts`](https://github.com/changesets/changesets/blob/main/packages/apply-release-plan/src/index.ts): `fs.rename(changesetPath, .changeset/pre/<id>.md)`), so the same changesets feed every prerelease *and* the final stable release/changelog. Stable releases stop until you exit pre mode. |
| npm caveats | `changeset publish` uses the pre tag automatically; passing `--tag` in pre mode is a **hard error** ("Releasing under custom tag is not allowed in pre mode!" — [publish command source](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/publish/index.ts)). Prerelease versions aren't matched by normal semver ranges, so consumers must opt in via `@beta`. |
| CI shape | Works with the official changesets/action **implicitly**: the action just runs `changeset version` / your publish script, and the CLI respects `pre.json`. The guide notes the version PR title gets the `(beta)` postfix. The old docs recommended running pre from a non-default branch; the current guide's primary model is pre on the default branch with a copied stable branch for backports. Either way it reshapes your whole release flow, not just one channel. |
| Killer con for our use case | **Pre mode blocks snapshots entirely**: `"Snapshot release is not allowed in pre mode."` (version command source; also [changesets#1195](https://github.com/changesets/changesets/issues/1195)). So choosing A forecloses B, and A alone can't give "stable often + experimental often" — while in pre, *stable* releases stop. |

## Option B — snapshot releases

Mechanics (per the [snapshot releases guide](https://changesets.dev/guide/snapshot-releases) + CLI v3 source):

- `changeset version --snapshot experimental` → every pending release becomes `0.0.0-experimental-<datetime>` (default template; v3 adds a configurable `snapshot.prereleaseTemplate` with `{commit}`, `{commit-short}`, `{tag}`, `{timestamp}`, `{datetime}` placeholders — verified in [`assemble-release-plan/src/index.ts`](https://github.com/changesets/changesets/blob/main/packages/assemble-release-plan/src/index.ts)).
- `changeset publish --tag experimental` — note: **`publish --snapshot` does not exist**; v3's `PublishOptions` only has `tag` (verified in the publish command source). The tag flag at publish time is the only mechanism.
- `--no-git-tag` skips git tags — snapshots are "for installation only".

| Question | Answer |
| --- | --- |
| Publish experimental from `main` HEAD without ceremony? | **Yes — this is exactly what snapshots are for.** Fresh CI checkout → `changeset version --snapshot experimental` → `changeset publish --tag experimental --no-git-tag` → throw the workspace away. Nothing is committed or pushed. |
| Consumers always keep stable `latest`? | **Yes, structurally.** The versions are `0.0.0-*` (chosen deliberately so they never interfere with real releases) and the publish goes to the `experimental` tag. The one footgun the guide shouts about: **omitting `--tag` on publish puts the snapshot on `latest`** — bake the flag into the CI step so it can't be forgotten. |
| Interaction with the changesets queue | In the *working tree*, snapshot versioning consumes changeset files exactly like a normal release (`fs.rm(changesetPath)`; the snapshot flag changes version numbering only, not file handling — verified in `apply-release-plan` source). Since the snapshot run lives in an ephemeral CI workspace, **`main`'s queue is untouched**. The guide's "never push snapshot version output" rule is satisfied for free by a workflow that never commits. |
| npm caveats | Each snapshot is a permanent version (name@version is immutable even after unpublish). `0.0.0-*` junk accumulates; cleanup is unpublish (easy now: single owner, presumably <300 weekly downloads, no dependents — see policy below) or just `npm deprecate`. Snapshot versions sort below every real release, so ranges never accidentally grab them. |
| CI shape | The **official changesets/action has no snapshot support at all** (README lists no prerelease/snapshot inputs; community actions like seek-oss/changesets-snapshot or snapit exist). Per repo policy (ask before adding dependencies), run the CLI directly in a dedicated job instead — see workflow sketch below. |
| Caveat worth knowing | A snapshot packages **the queue, not HEAD per se**. Right after a stable release (queue empty) `changeset version --snapshot` no-ops and the subsequent publish publishes nothing. That's usually correct (HEAD == released), but if we ever want "build of HEAD even when clean", snapshots won't do that. Also: snapshot requires the whole repo **not** be in pre mode. |

## Option C — plain dist-tags layered on normal versioning

Mechanics: keep ordinary `changeset version` + `changeset publish` (normal semver), and either

- **C1**: publish some releases with `changeset publish --tag experimental` (allowed in non-pre mode; the hard error is pre-mode only), or
- **C2**: publish everything to `latest` and manually publish extra builds to `experimental` with hand-bumped versions outside changesets.

| Question | Answer |
| --- | --- |
| Publish experimental from `main` HEAD without ceremony? | No. C1 needs a queue-consuming release decision each time; C2 needs manual versioning entirely outside changesets. |
| Consumers always keep stable `latest`? | Fragile. In C1, a release published under `experimental` is a *real* semver version with a real git tag and changelog entry, but `latest` doesn't move — promoting it later is a manual `npm dist-tag add pkg@x.y.z latest`, i.e. a **second metadata write**, which is exactly the operation that trips over propagation lag (see npm side notes). And the classic npm footgun — publishing a prerelease-formatted version without `--tag` hijacks `latest` ([npm/npm#13248](https://github.com/npm/npm/issues/13248)) — lives in this mode of working. |
| Interaction with the changesets queue | **Worst of the three.** `changeset version` consumes the queue regardless of which channel the release goes to (files are deleted in normal mode). An experimental release "spends" changesets that a stable release would have used; repo state (git tag, changelog) then says "released" while `latest` consumers see nothing until someone manually promotes. |
| npm caveats | Everything in the shared section, plus the divergence above. |
| CI shape | Same as the standard action workflow, but channel selection and promotion are manual discipline, not mechanics. |

## Shared npm-side notes (apply to all three)

- **dist-tag semantics** ([npm-dist-tag docs](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag)): tags are mutable aliases to published versions; `npm publish` defaults to `latest`; `npm install pkg` resolves `latest`; "other than `latest`, no tag has any special significance to npm itself" — they're just install specifiers. Tags share a namespace with versions; semver-parseable tags are rejected.
- **Propagation lag**: `npm publish` returning success does **not** mean globally visible — there's a grace period across the registry/CDN ([npm/feedback#68](https://github.com/npm/feedback/discussions/68)), and caches (local, CDN, proxy registries) can serve stale metadata ([npm/cli#593](https://github.com/npm/cli/issues/593), [npm/cli#3424](https://github.com/npm/cli/issues/3424)); `npm dist-tag add` immediately after publish can fail behind proxies ([semantic-release/npm#279](https://github.com/semantic-release/npm/issues/279)). Practical rules: **set the tag at publish time (`--tag`) rather than publish-then-retag**, don't chain "install what we just published" in the same CI job without retry, and expect `npm view`/website UI to lag minutes.
- **Unpublish policy** ([policy](https://docs.npmjs.com/policies/unpublish)): `name@version` is permanently unusable once used, even after unpublish. Within the first 72h you can unpublish versions freely (if no registry packages depend on them); after 72h only if no dependents + <300 downloads/week + single owner. Unpublishing *everything* imposes a 24h cooldown before publishing again. Deprecation is the low-cost alternative for junk versions. For this package today, cleaning up experimental junk is cheap; it gets harder as it gets popular (a good problem).
- **GAT specifics**: the propagation lag is a registry property, not a GAT property — but GATs **expire within 90 days** and changesets' automation guide now labels token-based publishing "no longer recommended" in favor of **trusted publishing** (OIDC, `id-token: write`). If we stay on GAT, calendar the rotation; if we adopt trusted publishing later, the workflow shapes below don't change (only the auth step does). A GAT must have read/write on this specific package for publish *and* dist-tag writes.

## CI workflow shapes

### 1. Stable releases — official action (both today and after this decision)

Standard [changesets/action](https://github.com/changesets/action) (current release `v2.1.1`) on push to `main`, per the [automating guide](https://changesets.dev/guide/automating):

```yaml
release:
  runs-on: ubuntu-latest
  permissions:
    contents: write        # push version commit + tags
    pull-requests: write   # open Version Packages PR
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - uses: actions/setup-node@v4
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org   # writes .npmrc using NODE_AUTH_TOKEN
    - run: bun install --frozen-lockfile
    - uses: changesets/action@v2
      with:
        publish: bun run build && changeset publish
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}   # the GAT
```

On push to `main`: queue non-empty → opens/updates the "Version Packages" PR; queue empty (i.e. just after merging that PR) → runs the publish script → `latest`. Release cadence = how often we merge the version PR. Repo setting "Allow GitHub Actions to create and approve pull requests" must be on.

### 2. Experimental channel — snapshots, no action, no pushback (recommended)

```yaml
snapshot:
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  permissions:
    contents: read          # never writes anything back
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - uses: actions/setup-node@v4
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org
    - run: bun install --frozen-lockfile
    - run: bun run build
    - run: bunx changeset version --snapshot experimental
    - run: bunx changeset publish --tag experimental --no-git-tag
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Trigger via `workflow_dispatch` (manual, "without ceremony" — one click from the Actions tab on `main` HEAD) and/or a `workflow_call` reused by a future `/snapshot` comment flow. The ephemeral workspace means the queue, changelog, and package.json on `main` are untouched; consumers opt in with `bun add @wojciechpiskorz/astroix@experimental`.

### 3. Pre mode — only if we later run a real major beta

No workflow changes: commit `.changeset/pre.json` (from `changeset pre enter rc`) and the standard action workflow above starts producing `0.0.0-rc.N` version PRs and publishing under `rc` automatically. Exit with `changeset pre exit` + one more version PR. First stable release must already exist (see the new-package/`latest` caveat), and snapshots are unavailable while in pre mode.

## Adopting notes (if we go with the recommendation)

1. **Publish `0.0.1` stable first** (merge the pending queue via the action) before experimenting with pre mode — the never-published-package-gets-`latest` caveat only exists until a first normal release exists. Snapshots don't have this problem.
2. Bake `--tag experimental` into the CI step; never run snapshot publish bare. Add a `changeset status`-free guard? Not needed — but a post-publish `npm view` assertion will flake due to propagation lag; avoid it.
3. Snapshot hygiene: expect `0.0.0-experimental-*` to accumulate. Within 72h windows, `bunx npm unpublish @wojciechpiskorz/astroix@0.0.0-experimental-...` is available; otherwise deprecate. Don't sweat it early.
4. GAT expires ≤90 days — set a rotation reminder now; consider trusted publishing as a follow-up ticket (workflow shapes above survive the swap).
5. The `experimental` snapshot only carries *queued* changes; immediately after a stable release it no-ops. If "build of HEAD even when clean" ever becomes a requirement, that's a different mechanism (option C2 or CI-only versioning) and a new research question.

## Sources

- Changesets guides (current): [prereleases](https://changesets.dev/guide/prereleases), [snapshot releases](https://changesets.dev/guide/snapshot-releases), [automating](https://changesets.dev/guide/automating); legacy copies in the repo `docs/` are marked outdated.
- Changesets source (`main`, v3 line): [`packages/cli/src/commands/publish/index.ts`](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/publish/index.ts) (no `--snapshot` on publish; `--tag` hard-error in pre mode; new-package-gets-latest warning), [`packages/cli/src/commands/version/index.ts`](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/version/index.ts) (snapshot flag, pre-mode mutex), [`packages/apply-release-plan/src/index.ts`](https://github.com/changesets/changesets/blob/main/packages/apply-release-plan/src/index.ts) (`fs.rm` in normal/snapshot mode; `fs.rename` into `.changeset/pre/` in pre mode), [`packages/assemble-release-plan/src/index.ts`](https://github.com/changesets/changesets/blob/main/packages/assemble-release-plan/src/index.ts) (`0.0.0-` prefix rationale; `snapshotPrereleaseTemplate` placeholders).
- [changesets/action README](https://github.com/changesets/action) (inputs; no prerelease/snapshot support), latest release `v2.1.1` (2026-08-19).
- npm docs: [npm-dist-tag (CLI v12)](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag), [npm-publish (CLI v12)](https://docs.npmjs.com/cli/v12/commands/npm-publish), [unpublish policy](https://docs.npmjs.com/policies/unpublish), [about access tokens](https://docs.npmjs.com/about-access-tokens/), [trusted publishers](https://docs.npmjs.com/trusted-publishers/).
- Propagation lag: [npm/feedback#68](https://github.com/npm/feedback/discussions/68) (grace period after publish), [npm/cli#593](https://github.com/npm/cli/issues/593), [npm/cli#3424](https://github.com/npm/cli/issues/3424) (stale caches), [semantic-release/npm#279](https://github.com/semantic-release/npm/issues/279) (`dist-tag add` right after publish failing), [npm/npm#13248](https://github.com/npm/npm/issues/13248) (prerelease hijacking `latest` without `--tag`).
- Community snapshot tooling (not adopted, for the record): [seek-oss/changesets-snapshot](https://github.com/seek-oss/changesets-snapshot), [snapit-release](https://github.com/marketplace/actions/snapit-release); pre/snapshot conflict: [changesets#1195](https://github.com/changesets/changesets/issues/1195).
