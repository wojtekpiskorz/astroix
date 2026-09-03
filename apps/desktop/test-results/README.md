# apps/desktop/test-results — the early packaged-smoke evidence

The one committed test-results root of the workspace: the recorded
evidence of the **early packaged smoke** (`#248`, lane H6; ADR-0008 — the
packaged smoke is H6's evidence, local-only, never `npm test` or CI).

## What lives here

- `README.md` — this file.
- `early-package-smoke/evidence.json` — the recorded run's identity: the
  exact ZIP (path, SHA-256, size, packaging label), the source commit,
  host facts (`sw_vers`, `uname -m`), the battery summary, and the honest
  **blocked-legs** record.
- `early-package-smoke/run.log` — the full battery output, including
  every `early-package-evidence: ` line the specs printed (process tree,
  artifact verification facets, the registration summary, the menu
  enumeration, the post-run audits).

Nothing else: raw run scratch (staging, extractions, isolated
user-data roots) lives in the system temp directory and is removed by
the specs themselves.

## The recording law

`npm run smoke:package` writes this directory **write-once**: a second
recording is refused unless `--force` is passed explicitly (the ticket's
"no upload, tag, publish, or rebuild after recording a claimed exact
run"). The evidence names the exact ZIP bytes it smoked — `--zip` adopts
an existing build instead of packaging a fresh one, and the record says
which happened.

## Reproducing

```sh
npm run smoke:package                       # package a labeled build + smoke + record
npm run smoke:package -- --zip <path.zip>   # smoke an EXISTING build's ZIP
npm run smoke:package -- --force            # discard an unclaimed run and re-record
```

The battery behind it is the `e2e/desktop/early-package*.spec.ts` family
behind `npm run test:desktop`; without a local package build the specs
self-skip. See `docs/testing/early-packaged-smoke.md` for the lane's
full contract, including the recorded blocked legs (the desktop
control-plane composition is not packaged at #248).
