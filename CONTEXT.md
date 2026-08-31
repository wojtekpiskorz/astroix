# Astroix — Domain Glossary

The ubiquitous language of this project. Use these terms (and these exact spellings) in issues, specs, tests, and proposals; don't drift to synonyms. Maintained via `/domain-modeling` as terms get resolved. Swept at the pivot ratification (2026-08-31, #187): app terms born, integration-era terms retired.

| Term | Meaning |
| --- | --- |
| **Astroix** | The product and the application: a standalone app that manages local Astro projects — supervisor + registry + builder UI (content and CSS verticals) over a per-project-vhost canvas. |
| **supervisor** | The app's Node process: serves the fixed-port origin the UI lives on, composes each registered project's dev pipeline, spawns and supervises its managed dev server, owns the registry and the UI-state push channel. |
| **registry** | The persisted list of registered projects (data + storage), owned by the supervisor — user-global JSON under `~/.astroix/`, never inside a managed project. |
| **registered project** | One registry entry: path (the identity anchor) + mutable display name defaulting to the directory name. |
| **managed dev server** | The `astro dev` process the supervisor spawns and supervises for a project. |
| **per-project vhost** | The `<project>.localhost` host on the supervisor's fixed port, reverse-proxied to that project's managed dev server — the canvas origin. |
| **fresh-runner doctrine** | The hard requirement that every supervisor-side content read runs in a newly created module runner — a long-lived runner serves stale content after store writes. |
| **canvas** | The live-site viewport in the app: an iframe loading the active project's per-project vhost, same-origin with the UI through the supervisor's reverse proxy. |
| **sidebar** | The app's left-hand panel: collections/entries and rules navigation, owned by the active vertical. |
| **vertical** | A top-level lane of the builder product — CSS (styles panel), Content (entries editing). Each vertical gets its own feature folder, store, and query hooks in the app UI (ADR-0002). |
| **workbench row** | The app's main horizontal band below the header — sidebar + editor dock + canvas — laid out by the app shell. |
| **editor dock** | The shell-owned column slot between the sidebar and the canvas hosting the active vertical's editor pane (rule editor / entry form); uniform width, the frame belongs to the shell. |
| **repo-mapping** | The core principle: the builder reads/writes the same repo files an agent would — never a parallel world. |
| **indexer** | The pure module that scans project CSS sources into the index: selector → (file, source range, media condition). The edit-truth. |
| **matcher** | The pure module that, given the index and a clicked element, returns matching rules (via `el.matches()`), sorted by specificity. |
| **effective selector** | The compiled form of a selector as it actually matches in the canvas DOM — for scoped rules, carrying the `data-astro-cid-*` attribute; distinct from the source-space selector the indexer reads. |
| **index payload** | The join of the static index (edit-truth) with effective selectors from the module graph, served to the app for matching. |
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
| **raw truth** | The entry file's own parse — what the write loop's `parseEntryDraft` produces — as the content editor's single truth-space (#149): the form's values, the write loop's baseline and the pane's halves all live in it. Distinct from raw mode/raw field (both widget concerns); the file's bytes are its anchor, writes are byte-surgical against them. |
| **zod projection** | The collections payload's `entry.data` — astro's zod output with defaults filled and transforms applied. In the pane it is display-only (image() metadata the raw truth cannot produce), plus sidebar data and the change signal; never the form's truth. |
| **widget-display** | A zod default rendered by the widget while the raw truth keeps the key absent (#149): placeholder semantics for string, number, enum and raw kinds, checked-state display for boolean, natural-empty for arrays; a touch materializes the key, the write follows. |
| **content-sync leg** | Which watcher half a content-sync push carries: **srcdir** (pre-commit file event) or **loader** (post-commit data-store write). The app sequences on it — srcdir invalidates the content caches immediately, loader holds until the canvas's next load so its refetch never races the post-commit full-reload render (#155). |
| **auto-write** | The persist-on-pause write loop (debounce ~300ms) writing the real repo file; the shared persistence doctrine of both verticals. |
| **selection** | The currently clicked element in the app; it survives reindex (re-matched after file changes). |
| **reindex** | Recomputing the indexer output after watched file changes; debounced; pushed to the app over the supervisor's push channel. |
| **core-first** | The rule that `docs/core-reuse.md` governs: if Astro/Vite core provides a mechanism, we don't build our own. |
| **preflight** | The local CRAP hard stop (`npm run preflight`): a full-src baseline ratchet — every run evaluates all of `src/` and fails any new stop breach, complexity or coverage regression alike; the agent runs it before `gh pr create`. |
| **baseline ratchet** | `crap-baseline.json`: calibrated once, then only tightens or drops. New stop-breachers fail preflight; the baseline never absorbs them. |
| **watchlist** | The CC-only risk tier for the non-core tiers (`src/node` + `src/client`), where per-function unit coverage is not real; the generated `src/client/components/ui/` folder is watch-only — visible, never gated. |
| **metric honesty** | The principle that CRAP is computed only where per-function coverage is real (`src/core`); everywhere else stays a CC watchlist. |
