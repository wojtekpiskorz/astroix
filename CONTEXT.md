# Astroix — Domain Glossary

The ubiquitous language of this project. Use these terms (and these exact spellings) in issues, specs, tests, and proposals; don't drift to synonyms. Maintained via `/domain-modeling` as terms get resolved.

| Term | Meaning |
| --- | --- |
| **Astroix** | The product: a dev-only Astro integration — a visual builder over a live page. |
| **chrome** | The builder UI: the top-level page rendered at `?builder=1` (React app in shadow DOM), wrapping the canvas. |
| **canvas** | The same-origin iframe (`?builder=0`) showing the real, live site. |
| **vertical** | A top-level lane of the builder product — CSS (styles panel), Content (entries editing). In the chrome, each vertical gets its own feature folder, store, and query hooks (ADR-0002). |
| **workbench row** | The chrome's main horizontal band below the header — sidebar + editor dock + canvas — laid out by the app shell. |
| **editor dock** | The shell-owned column slot between the sidebar and the canvas hosting the active vertical's editor pane (rule editor / entry form); uniform width, the frame belongs to the shell. |
| **repo-mapping** | The core principle: the builder reads/writes the same repo files an agent would — never a parallel world. |
| **indexer** | The pure module that scans project CSS sources into the index: selector → (file, source range, media condition). The edit-truth. |
| **matcher** | The pure module that, given the index and a clicked element, returns matching rules (via `el.matches()`), sorted by specificity. |
| **effective selector** | The compiled form of a selector as it actually matches in the canvas DOM — for scoped rules, carrying the `data-astro-cid-*` attribute; distinct from the source-space selector the indexer reads. |
| **index payload** | The join of the static index (edit-truth) with effective selectors from the module graph, served to the chrome for matching. |
| **splice-writer** | The pure module applying rule edits as text-splices into source files, preserving formatting. |
| **rule** | One CSS rule from the repo, with its source location. |
| **nearest home** | Destination heuristic for a NEW rule: the file that styles the closest styled ancestor/sibling. |
| **overrides file** | Fallback destination (`src/styles/builder/[route].css`), loaded last in the cascade, when no home exists. |
| **entry** | A Content Collections item (`.md`/`.mdx` with frontmatter); `entry.data` is parsed frontmatter. |
| **active entry** | The entry open in the content editor; set manually (list click) or reactively (route resolution from the canvas URL). |
| **route resolution** | Matching the canvas URL against route patterns and entry ids to find the entry rendered there, and back (entry → canvas); a unique hit — or a plurality whose candidates all resolve to the same entry — selects; other ambiguity/no-match stays silent; a pure `src/core` module. |
| **candidate route** | A route pattern that plausibly renders a given entry, with the canvas URL it produces; entry→canvas navigation picks the most specific candidate of a same-entry plurality (segment param before catch-all, then shallowest), re-verified by forward match. |
| **unrouted entry** | An entry no route actually renders — marker truth comes from `getStaticPaths`-aware enumeration (candidate routes gate on rendering truth; 2026-08-30, #119: was "an entry with zero candidate routes — no pattern the id could fill", the pure shape heuristic). Unknown enumeration degrades to the shape premise and never fires the marker. The sidebar marks it (dimmed marker + tooltip): a legend for the click's navigational silence, never a disable. |
| **raw mode** | The CSS rule editor's free-form mode: the rule's declarations edited as plain CSS text instead of property→value widget rows. |
| **raw field** | The textarea fallback rendering an unsupported schema subtree as editable YAML. |
| **auto-write** | The persist-on-pause write loop (debounce ~300ms) writing the real repo file; the shared persistence doctrine of both verticals. |
| **smoke gate** | The manual-smoke checklist's only entry: a top-level `?astroix_smoke=1` — without the param the checklist renders nothing. |
| **hint pill** | The small fixed-position affordance visible while the smoke gate is open; summons the wizard (as does `S`, typing-guarded). |
| **wizard** | The in-chrome smoke checklist dialog: one step per screen over the steps mirrored from `docs/manual-smoke.md`, ending in a summary. |
| **copy report** | The smoke run's markdown payload — header, per-step checkboxes with notes, Result line — written to the clipboard for pasting into an issue. |
| **selection** | The currently clicked element in the chrome; it survives reindex (re-matched after file changes). |
| **reindex** | Recomputing the indexer output after watched file changes; debounced; pushed to chrome via Vite WS events. |
| **dev-only guarantee** | Astroix never ships in production builds — an invariant, not a preference. |
| **core-first** | The rule that `docs/core-reuse.md` governs: if Astro/Vite core provides a mechanism, we don't build our own. |
| **preflight** | The local CRAP hard stop (`bun run preflight`): a full-src baseline ratchet — every run evaluates all of `src/` and fails any new stop breach, complexity or coverage regression alike; the agent runs it before `gh pr create`. |
| **baseline ratchet** | `crap-baseline.json`: calibrated once, then only tightens or drops. New stop-breachers fail preflight; the baseline never absorbs them. |
| **watchlist** | The CC-only risk tier for `src/node` + `src/client`, where per-function unit coverage is not real; the generated `src/client/components/ui/` folder is watch-only — visible, never gated. |
| **metric honesty** | The principle that CRAP is computed only where per-function coverage is real (`src/core`); everywhere else stays a CC watchlist. |
