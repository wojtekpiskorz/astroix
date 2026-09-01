# The frozen edit-contract corpus (#217, lane B2)

Eight deterministic JSON fixtures — the observed, versioned WRITE behavior
of the retired integration over the canonical plain fixture, captured from
disposable legacy-oracle runs (`e2e/.oracle-fixture`): real CSS text-splices
and Content whole-file writes through the actual `/__astroix` write
endpoints, their optimistic expected-hash conflicts, and the exact file
bytes every cycle left on disk. Validated against
`e2e/behavior-contracts/schema/edit-contract.ts` (semver
`contractVersion`), unit-tested vitest-side (same directory), hygiene-
scanned for the artifacts #217 AC-5 forbids, and re-derived byte-for-byte
by `e2e/contracts-edit.spec.ts` — that last comparison is the freeze: if a
fresh oracle run no longer produces these bytes, the write behavior
changed and the contract must move deliberately.

These fixtures are the acceptance inputs for the Electron-rewrite lanes
(map #197): the app-shell presenting write state, and the replacement edit
authority, are judged against these bytes — never against the old
implementation.

## Inventory

| fixture | freezes |
| --- | --- |
| `css-splice.json` | a declaration splice in the global css: request/response, untouched bytes outside the window, the served index after |
| `css-scoped-splice.json` | a selector rename in a scoped `<style>` block: the served record before/after, the compiled cid form following the renamed selector |
| `css-conflict.json` | a stale expected-hash splice over a raced disk: 409, the disk-truth handback, byte retention |
| `content-frontmatter-write.json` | one frontmatter key over a commented, quoted, flow-styled file: the raw-truth serialization, verbatim landing, preserved lines |
| `content-body-write.json` | a body-only write: the whole frontmatter block byte-identical, the re-anchored body |
| `content-validate.json` | advisory validation: clean + invalid probes, and the byte-level proof the issues never gate the write |
| `content-conflict.json` | a stale expected-hash content write over a raced disk: 409, handback, retention |
| `edit-negatives.json` | the 400 taxonomy (invalid ranges, missing fields, root confinement, missing file) with the disk proven untouched |

## Observed vs derived

The observed side of every leg is its REST responses and disk reads. The
derived side is the client half of each cycle — the splice range located
over observed bytes and the posted `contents` computed by the pure
`packages/core` entry-writer over the observed baseline, exactly what the
chrome's auto-write loop sends. Scenario inputs written into the oracle
copy before a leg (the commented frontmatter variant, the out-of-band
interference bytes) are setup, like B1's where-oracle config generation —
the write behavior observed through them is the real endpoint, untouched.

## Regeneration

Regenerate with `node e2e/contract-oracle/capture.mjs` from the repo root
(boots the two inspection oracles plus the edit corpus's own two-boot
pipeline; needs a chromium install — Playwright's own registry path
decides; also re-freezes the inspection corpus in the same run).
Legitimate regeneration triggers mirror the inspection corpus's:

- **Write-behavior change** — the legacy oracle or the canonical fixture
  changed what the write surfaces do. Expect a targeted diff.
- **Formatter bump** — the corpus bytes go through the repo's pinned Biome
  (see `serializeFixture` in `e2e/contract-oracle/live-capture.ts`), so a
  formatter bump re-churns the corpus as an unrelated diff.
- **Dependency bump** — the advisory issues' `code`/`message` text comes
  from astro's bundled zod; a zod bump moves those strings deliberately.

Everything else is drift: the spec goes red on purpose.
