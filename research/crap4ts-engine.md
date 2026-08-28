# Research: crap4ts cyclomatic-complexity engine — build vs adopt

**Ticket:** #54 · **Date:** 2026-08-28 · **Branch:** `research/crap4ts-engine`
**Scope:** the CC engine (CRAP = CC² × (1−coverage)³ + CC, per [crap4clj](http://www.c2.com/cgi/wiki?Crap4j) / [PHPUnit's CRAP index](https://phpunit.readthedocs.io/en/9.5/code-coverage-analysis.html#crap-index)). Pipeline wiring is #55. **Addendum (same day):** per owner request, the adopt side was re-opened to whole-layer CRAP tools (crap4js/crap4ts/etc.) — see "The 2026 whole-layer landscape" below; the recommendation was re-weighed against it.

## Recommendation

**Build the CC engine in-house as a pure module in `src/core/`, parsing with `oxc-parser` (one new devDep), and join it with vitest's istanbul-format JSON. Fallback if the dependency is declined: the TypeScript 5.9 compiler API, already a devDep (zero new deps). Designate `@barney-media/crap-typescript` (0.5.0) as the verified adopt-fallback and use it as a cross-check oracle while developing.**

Reasoning in brief:

1. **No maintained library outputs per-function cyclomatic complexity as data; the whole-layer picture changed on 2026's npm, but not enough to flip the call.** A wave of CRAP tools shipped in 2026 (see landscape below); exactly one — `@barney-media/crap-typescript` — passes the whole-pipeline bar (istanbul-JSON join verified in our lab on our files, exit-code gate, agent-oriented JSON output, 4-month active history). It is a strong fallback, but it is a 4-month-old, single-maintainer, 16-star project — thin foundation for a risk gate whose numbers feed the CI advisory reviewer, and its counting semantics are not ours to pin. The engine it contains is the same ~60-line TS-API visitor this research built and verified in an afternoon.
2. **The build is genuinely small, verified, and now convergently validated.** I wrote two working visitors — 77 lines over `oxc-parser`, 63 lines over the TS compiler API. Both score identically to both working 2026 CRAP tools on the repo's own files (`handleApiRequest` cc=27, `selectorSpecificity` cc=10, `write` cc=12) and reproduce ESLint-classic semantics 14/14 on a construct probe. Only frozen-2018 typhonjs diverges (cc=23/9).
3. **Speed:** oxc parses the three sample files in ~0.7 ms warm in-process; tsc ~21 ms; full `src/` (~30 files, 2.8 kLOC) ≈ 7–210 ms. The adopted CLI invocations run ~0.3–0.4 s (node startup dominates) — acceptable, but the in-process lib is what makes the pre-commit mode truly millisecond-scale and spawn-free.
4. **The join is solved and copyable.** vitest + `@vitest/coverage-v8` with the `json` reporter emits istanbul-format `coverage-final.json` (verified end-to-end in the lab with the repo's real `matcher.test.ts`); function-level coverage is best derived from statement/branch counters inside each function's line range (the approach both working CRAP tools use, because v8-derived `fnMap` names anonymous functions lossily — verified: `fnMap` entry `{"name":"(anonymous_1)", "decl":..., "loc":...}`).
5. **`oxc-parser` is a low-friction dependency:** v0.147.0 published 2026-08-24, same version line as the repo's existing `oxc-transform-react@^0.147.0` (same NAPI-RS packaging), one types-only dep, ESTree-conformant AST.

What we take on: ownership of the counting rule and TS-syntax breadth over time. The probe fixture from this research pins the rule; the parsers absorb new syntax upstream. If the owner prefers to flip to adopt, the cost of flipping later is one glue script — the coverage join and report formats are shared between both paths.

## Adopt-side findings — engine-only candidates

### Candidates

| Candidate | Per-function CC? | TS breadth | ESM/bun | Dep weight | Maintenance (2026-08-28) | Measured runtime (3 files, warm) |
|---|---|---|---|---|---|---|
| `typhonjs-escomplex` 0.1.0 | **Yes** — `methods[]` with `cyclomatic`, `lineStart`/`lineEnd`, settings knobs | Parses TS/TSX via bundled Babel fork; **misses `??` and `||=/&&=/??=`** | CJS, fine under bun | commander@2 + 3 typhonjs siblings | **Dead** — last publish 2018-12-21; Travis CI; 8 issues / 7 PRs | ~44 ms in-process |
| `oxlint` 1.80.0 (drive `eslint/complexity`, `max:1`) | Partial — one diagnostic per function with CC ≥ 2; **CC = 1 functions never emit**; number lives in a message string; anon fns unnamed | Excellent (oxc); counts `?.` per current ESLint docs | Native CLI, `--format json` | 2.4 MB, zero JS deps | **Active** (1.80.0, 2026-08-24) | ~40 ms/invocation |
| `complexity-report` 2.0.0-alpha / `escomplex` | Yes (module + methods) | esprima@2 era — no modern TS | ancient CJS | 2014–2015 dep tree | **Dead** — alpha frozen ~2016 | n/a (cannot parse our TS) |
| `eslint-plugin-sonarjs` 4.2.0 | No — **cognitive** only; no cyclomatic rule; no CRAP rule (CRAP is not available outside the SonarQube platform) | n/a | n/a | drags ESLint | Active but wrong metric | n/a |
| Biome (`@biomejs/biome` 2.5.x) | No — `noExcessiveCognitiveComplexity` is cognitive (default 15); **no cyclomatic rule exists**; no data API | n/a | n/a | installed | Active but wrong metric / no data API | n/a |
| `@typescript-eslint` headless | Yes | Best-in-class | ESM ok | **eslint + @typescript-eslint/parser + typescript** — the toolchain the repo deliberately lacks | Active (8.68.0) | not run — dep weight disqualifies |
| `@ast-grep/napi` 0.45.2 | Indirect — per-function attribution means rebuilding the visitor anyway | Excellent | Native, bun-fine | 1 native pkg | Active (2026-08-23) | n/a — reduces to the build option |

### Key detail: typhonjs-escomplex works on TS/TSX — but is frozen

`escomplex.analyzeModule()` parsed all three sample files and returned per-function records with `cyclomatic`, `lineStart`, `lineEnd`, params, Halstead. On `matcher.ts`: `selectorSpecificity` cc=9 at lineStart=75 (every 2026 tool and my visitors: cc=10). The parser is a 2018 Babel snapshot: no `??`, no logical assignments, `forin`/`trycatch` counting off by default (`settings: {"forin":false,"logicalor":true,"switchcase":true,"trycatch":false}`), anonymous functions named `<anon method-N>`. Last publish 2018-12-21. Adopting it means inheriting a dead parser's TS ceiling.

### oxlint-as-data-source: cross-check, not engine

`"eslint/complexity": ["error", {"max": 1}]` + `--format json` emits `"function \`X\` has a complexity of N. Maximum allowed is 1."` per function with CC ≥ 2. Three disqualifiers as the primary engine: CC=1 functions never emit (a CRAP report needs every function — CRAP(1, 0%) = 2 is nonzero); the dataset lives in human-readable strings (weekly oxlint releases can break the join silently); counting drift is external (it counts each `?.`, probe: cc=4 vs McCabe-style 2). Keep as a cheap CI cross-check.

## The 2026 whole-layer landscape (addendum)

An npm search for CRAP tools finds a 2026 gold rush — ~15 packages, almost all published this year, several this month. The owner's evaluation bar ("1 stale star and no commits in years is a finding, not a solution") eliminates most of them. Two were lab-verified end-to-end.

| Tool (npm) | Version / last publish | GitHub evidence | Coverage input | Per-function CC | Lab result | Verdict |
|---|---|---|---|---|---|---|
| `@barney-media/crap-typescript` (+`-core`, `-vitest`, `-jest`) | 0.5.0, 2026-08-08; 9 publishes Apr→Aug 2026 | [fabian-barney/crap-typescript](https://github.com/fabian-barney/crap-typescript): 16 stars, created 2026-04-03, last push 2026-08-08, 0 open issues | Istanbul JSON (`coverage/coverage-final.json`), auto-runs vitest/jest coverage if absent | Yes — in-house TS-API engine (core deps: `typescript`, `fast-xml-parser`, `toon`) | **Works**: picked up our vitest-produced coverage; per-method `crap/cc/cov/src/lineStart/lineEnd`; `--changed` (git status, not staged-only); exit 2 gate (threshold 6.0); `--agent` output; 0.42 s/invocation; CC matches our visitors exactly | **Verified adopt-fallback** — best-in-class, still hobby-scale |
| `@gligor/crap4ts` | 1.1.0, 2026-08-26; 7 publishes in 3 days | [gligorkot/crap4ts](https://github.com/gligorkot/crap4ts): 1 star, created 2026-08-23 | Istanbul JSON (`--coverage`, required) | Yes | **Works**: per-function `complexity/coverage/crap/startLine/endLine`; **`--changed-since <ref>` (merge-base) — the right shape for PR-diff scope**; exit 2; 0.30 s; CC matches our visitors | Works but 5 days old — watch, don't adopt |
| `crap4ts` | 1.0.1 stable / 2.0.0-rc.5, 2026-06-24 | [breezy-bays-labs/crap4ts](https://github.com/breezy-bays-labs/crap4ts): 1 star, last push 2026-05-18 (3+ months) | unverified | via `@typescript-eslint/typescript-estree` | not run — 1 star, rc-stalled for 2 months, zod@3 dep | Finding, not a solution |
| `@mquesada02/crap-ts` | 0.8.0, 2026-08-24; 8 publishes in 4 days | [mquesada02/crap-ts](https://github.com/mquesada02/crap-ts): 0 stars, created 2026-08-20 | unverified | tsc-API (`typescript@^5.9.3` dep) | not run — 4 days old, 0 stars | Watch |
| `crap-score` | 1.2.1, 2026-04-24 (prior: 2023) | [ahilke/js-crap-score](https://github.com/ahilke/js-crap-score): 16 stars, 7 open issues | unverified | eslint-driven | not run — runtime deps include **@nestjs/cli, @nestjs/core, rxjs, eslint@8** for a lint tool | Dead-ish + pathological dep tree |
| `ts-crap` | 1.0.0, 2026-05-28 (only publish) | [dedalik/ts-crap](https://github.com/dedalik/ts-crap): 1 star | fast-xml-parser (XML coverage?) | via typescript-estree | not run | Finding |
| `crap4js` | 1.0.1-beta.0, 2026-04-14 | not on npm registry metadata | unverified | unverified | not run — beta, no activity since April | Finding |
| `plato` 1.7.0 | last publish ~2018 era | [es-analysis/plato](https://github.com/es-analysis/plato): **4551 stars, 312 forks — last push 2022-02-11** | coverage optional | via **`typhonjs-escomplex@0.0.9`** (2016) + jshint + eslint@3 | not run — dependency tree frozen in 2016 | **The historical complexity×coverage joiner; famous and dead.** Its lineage is the frozen typhonjs above |
| `crap4react`, `crap4node`, `crap-report` | — | 404 on npm | — | — | — | Do not exist |

Pattern worth naming: most of the 2026 wave appeared within days of each other, several explicitly advertise AI-slop heuristics or ship as Claude Code plugins — treat unmaintained entries as noise, and even the good ones as young.

### What the lab verification showed

Setup: throwaway dir, `bun add`, vitest + `@vitest/coverage-v8` + happy-dom, the repo's real `matcher.test.ts` (9 tests pass), `coverage: { reporter: ['json'] }` → `coverage/coverage-final.json` (istanbul format; verified `fnMap` shape: `{"name":"(anonymous_1)","decl":{"start":{"line":34,...}},"loc":{...},"line":34}`).

- `@barney-media/crap-typescript --format json files/…` → `selectorSpecificity cc=10 cov=61.29% crap=15.80`, `functionalPseudoContribution cc=5 cov=0 crap=30`, `splitTopLevel cc=8 cov=100% crap=8.0`; files absent from coverage get `cov=null` gracefully. Note the formula's property: CRAP ≥ CC even at 100% coverage — a threshold of 6 flags any function with CC > 6 regardless of tests. Threshold choice is a product decision for #55 either way.
- `@gligor/crap4ts files/ --coverage coverage/coverage-final.json --format json` → identical CC and coverage numbers (independent implementations converging on ESLint-classic counting + the same stmt-counter join).
- Both tools' CC agrees with my two visitors on every sampled function; typhonjs is the sole outlier.

### Whole-layer adopt vs build, against #55's four pipeline requirements

1. **Pre-commit staged-files scan in milliseconds** — adopt: both CLIs take explicit file args but have no staged-only mode (barney `--changed` = `git status` working tree; gligor `--changed-since` = merge-base diff); glue needed either way; ~0.3–0.4 s per invocation (process startup). build: in-process, ~7 ms for all of `src/`, embeddable in the hook itself.
2. **`bun run preflight` full-CRAP on PR diff with hard-stop** — adopt: exit code 2 + threshold, gligor's `--changed-since` fits PR scope best. build: same exit-code pattern over our own function.
3. **CI recompute feeding a per-function table into the advisory reviewer's prompt** — adopt: `--format json` / barney's `--agent` (toon) output is explicitly designed for this. build: we render the JSON ourselves.
4. **vitest + @vitest/coverage-v8 join** — adopt: **verified working** for both barney and gligor. build: same join, ~30 lines, technique copied from the verified tools.

Adopt clears the bar functionally (barney-media specifically). It loses on: single maintainer, 4 months of history, counting semantics we can't fixture-pin, and a risk gate whose oracle is someone else's hobby project. Build loses on: ~1 day of glue + tests we'd otherwise not write. Given the repo's doctrine (pure modules in `src/core/`, behavior-pinned unit tests, vendored-with-provenance habits) and that the engine is now de-risked to a 60-line fixture-guarded visitor, **build remains the recommendation — with barney-media one `bunx` away as the cross-check oracle and emergency fallback**.

## Build-side findings

### Raw AST access from JS/TS

- **`oxc-parser` (npm)** — official Node API for oxc's Rust parser, NAPI-RS bindings, per-platform `@oxc-parser/binding-*` optional deps + WASM fallback. `parseSync(filename, source)` → `{ program, errors, module }`; ESTree-flavored AST; raw-transfer makes the Rust→JS handoff near-zero ([oxc.rs parser guide](https://oxc.rs/docs/guide/usage/parser)). Active: 0.147.0 (2026-08-24), same line as our `oxc-transform-react@^0.147.0`. No `@oxc-project/parser` package exists (404) — `oxc-parser` is the name.
- **`oxc-transform`** (what `oxc-transform-react` wraps) — transform only, no AST walk. Not useful for CC directly.
- **`@astrojs/compiler-binding`** — Astro-component compiler only; irrelevant for `.ts`/`.tsx` CC. Excluded.
- **TypeScript compiler API** — `ts.createSourceFile()` + `forEachChild`. Zero new deps. Caveat found in the lab: `typescript@7.0.2` (current `latest`) does not expose the classic default-export JS API the same way (`import ts from 'typescript'` → `undefined` under bun); the repo's `~5.9.3` pin is unaffected, but the tsc path carries a forward-compat question mark the oxc path does not.

### What a ~60–80 line visitor covers — verified, not estimated

Probe: 14 functions, each isolating one construct; expected values from the ESLint rule docs.

| Construct (probe fn) | McCabe/ESLint-classic expected | typhonjs | oxlint | oxc visitor (mine) | tsc visitor (mine) |
|---|---|---|---|---|---|
| `if` | 2 | 2 | 2 | 2 | 2 |
| `else if` | 3 | 3 | 3 | 3 | 3 |
| `for` | 2 | 2 | 2 | 2 | 2 |
| `for-in` | 2 | **1** (`forin:false`) | 2 | 2 | 2 |
| `for-of` | 2 | **1** | 2 | 2 | 2 |
| `while` | 2 | 2 | 2 | 2 | 2 |
| `do` | 2 | 2 | 2 | 2 | 2 |
| `switch` (2 cases + default) | 3 | 3 | 3 | 3 | 3 |
| `catch` | 2 | **1** (`trycatch:false`) | 2 | 2 | 2 |
| ternary | 2 | 2 | 2 | 2 | 2 |
| `&&` `\|\|` `??` | 4 | **3** (misses `??`) | 4 | 4 | 4 |
| `\|\|=` `??=` `&&=` | 4 | **1** (misses all) | 4 | 4* | 4 |
| labeled `for-of` + `if` | 3 | 2 | 3 | 3 | 3 |
| optional chain `o?.p?.q ?? 0` | 2 | 1 | **4** (counts each `?.`) | 2 | 2 |

\* after a one-line fix — oxc models `||=` as `AssignmentExpression { operator: '||=' }`, not a distinct node type.

The two in-house visitors agree 14/14, including: labeled breaks (no CC impact), decorators (no impact), optional chaining (no impact), nested-function attribution to the innermost function (required for the join). Current ESLint docs additionally count **default parameter values** and offer a `"modified"` switch-variant; neither visitor counts default params today — a pin-it-in-#55 decision. "Cyclomatic complexity" is not one number across tools: three engines, three answers on the same file.

### Real cost observed

- oxc variant: **77 lines** (CC core ~50) after one probe-caught counting gap. tsc variant: **63 lines** (core ~45) after two real bugs (double-counted `BinaryExpression`; `node.getStart(src)` — takes no argument, fails at runtime).
- Wall-clock, 3 files (~800 LOC), warm, in-process, 5-run median: **oxc ~0.7 ms**, **tsc ~21 ms**, **typhonjs ~44 ms**; oxlint CLI ~40 ms; barney CLI 0.42 s; gligor CLI 0.30 s. Full `src/` extrapolation: oxc ≈ 7 ms, tsc ≈ 210 ms.
- Maintenance tail: the counting rule (table above, as a fixture) + new TS syntax (parsed by oxc/tsc upstream; the visitor ignores non-decision syntax). Failure mode is under-counting an exotic construct, caught by the fixture the day it's added.

## What #55 should do first

**Commit the construct probe as fixtures with the expected-CC table, then implement `analyzeComplexity(source, { kind }) → Array<{ name, lineStart, lineEnd, cc }>` as a pure function in `src/core/`** — no IO, unit-tested over fixtures, per repo doctrine. In order:

1. Decide and document the counting convention (recommend the table above; decide default-param counting explicitly). Pin with the probe fixture.
2. `bun add -d oxc-parser` (0.147.x line) — flag the Ask-first boundary in the PR; zero-dep tsc fallback is plan B (~15 changed lines).
3. Emit `{ name, lineStart, lineEnd, cc }` per function; join with `vitest run --coverage` (coverage provider `@vitest/coverage-v8`, reporter `json`) → `coverage/coverage-final.json`, matching istanbul `fnMap` `decl`/`loc` line ranges but deriving per-function coverage from statement/branch counters within the range (the technique both verified CRAP tools use — v8 `fnMap` names are lossy).
4. Cross-check: run `bunx @barney-media/crap-typescript --format json` over `src/` during development and diff against our output (CC must match; it did on every sampled function in this research). Keep gligor's `--changed-since <merge-base>` semantics in mind for the preflight diff scope.
5. Only then the three modes (pre-commit staged scan, `bun run preflight`, CI recompute into the reviewer prompt) — all consumers of the same pure function. Decide the CRAP threshold consciously (CRAP ≥ CC always; barney defaults 6.0, gligor 8).

## Sources

- npm registry (queried 2026-08-28): [`typhonjs-escomplex`](https://www.npmjs.com/package/typhonjs-escomplex) (0.1.0, 2018-12-21), [`typhonjs-escomplex-commons`](https://www.npmjs.com/package/typhonjs-escomplex-commons) (0.1.1, 2019-01-10), [`complexity-report`](https://www.npmjs.com/package/complexity-report), [`oxlint`](https://www.npmjs.com/package/oxlint) (1.80.0), [`oxc-parser`](https://www.npmjs.com/package/oxc-parser) (0.147.0), [`oxc-transform`](https://www.npmjs.com/package/oxc-transform) (0.147.0), [`@ast-grep/napi`](https://www.npmjs.com/package/@ast-grep/napi) (0.45.2), [`eslint-plugin-sonarjs`](https://www.npmjs.com/package/eslint-plugin-sonarjs) (4.2.0), [`plato`](https://www.npmjs.com/package/plato) (1.7.0, deps frozen at typhonjs-escomplex@0.0.9)
- Whole-layer tools (npm + GitHub, 2026-08-28): [`@barney-media/crap-typescript`](https://www.npmjs.com/package/@barney-media/crap-typescript) (0.5.0, 2026-08-08; [repo](https://github.com/fabian-barney/crap-typescript), 16★, pushed 2026-08-08), [`@gligor/crap4ts`](https://www.npmjs.com/package/@gligor/crap4ts) (1.1.0, 2026-08-26; [repo](https://github.com/gligorkot/crap4ts), 1★, created 2026-08-23), [`crap4ts`](https://www.npmjs.com/package/crap4ts) (1.0.1/2.0.0-rc.5; [repo](https://github.com/breezy-bays-labs/crap4ts), 1★, pushed 2026-05-18), [`@mquesada02/crap-ts`](https://www.npmjs.com/package/@mquesada02/crap-ts) (0.8.0; [repo](https://github.com/mquesada02/crap-ts), 0★), [`crap-score`](https://www.npmjs.com/package/crap-score) (1.2.1; [repo](https://github.com/ahilke/js-crap-score), 16★, NestJS-laden), [`ts-crap`](https://www.npmjs.com/package/ts-crap) (1.0.0; [repo](https://github.com/dedalik/ts-crap), 1★), [`es-analysis/plato`](https://github.com/es-analysis/plato) (4551★, last push 2022-02-11); `crap4react`/`crap4node` 404 on npm
- [typhonjs-escomplex on GitHub](https://github.com/typhonjs-node-escomplex/typhonjs-escomplex) — README (babel-parser basis, TS claim), 8 open issues / 7 open PRs, Travis CI, roadmap "fall '18"
- [oxc.rs parser guide](https://oxc.rs/docs/guide/usage/parser), [eslint/complexity on oxc.rs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity), [oxc-walker](https://github.com/oxc-project/oxc-walker)
- [ESLint `complexity` rule docs](https://eslint.org/docs/latest/rules/complexity) — counting semantics incl. `?.` and default params, `classic` vs `modified`, default max 20
- [Biome `noExcessiveCognitiveComplexity`](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/) + [rules index](https://biomejs.dev/linter/) — cognitive only, no cyclomatic rule
- [SonarSource/eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs) — cognitive-complexity only; archived, successor SonarJS analyzer; no CRAP outside the SonarQube platform
- CRAP formula: [Uncle Bob's crap4j/crap4clj rationale](http://www.c2.com/cgi/wiki?Crap4j), [PHPUnit CRAP index](https://phpunit.readthedocs.io/en/9.5/code-coverage-analysis.html#crap-index)
- All measurements: throwaway lab `/tmp/crap-lab` (bun 1.3.14, macOS arm64; vitest 4 + @vitest/coverage-v8 + happy-dom) over copies of `src/core/matcher.ts`, `src/node/rest.ts`, `src/client/editor.tsx`, with the repo's real `src/core/matcher.test.ts` for genuine coverage. Repo tree untouched.
