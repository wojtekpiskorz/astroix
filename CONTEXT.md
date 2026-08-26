# Astroix — Domain Glossary

The ubiquitous language of this project. Use these terms (and these exact spellings) in issues, specs, tests, and proposals; don't drift to synonyms. Maintained via `/domain-modeling` as terms get resolved.

| Term | Meaning |
| --- | --- |
| **Astroix** | The product: a dev-only Astro integration — a visual builder over a live page. |
| **chrome** | The builder UI: the top-level page rendered at `?builder=1` (React app in shadow DOM), wrapping the canvas. |
| **canvas** | The same-origin iframe (`?builder=0`) showing the real, live site. |
| **repo-mapping** | The core principle: the builder reads/writes the same repo files an agent would — never a parallel world. |
| **indexer** | The pure module that scans project CSS sources into the index: selector → (file, source range, media condition). The edit-truth. |
| **matcher** | The pure module that, given the index and a clicked element, returns matching rules (via `el.matches()`), sorted by specificity. |
| **splice-writer** | The pure module applying rule edits as text-splices into source files, preserving formatting. |
| **rule** | One CSS rule from the repo, with its source location. |
| **nearest home** | Destination heuristic for a NEW rule: the file that styles the closest styled ancestor/sibling. |
| **overrides file** | Fallback destination (`src/styles/builder/[route].css`), loaded last in the cascade, when no home exists. |
| **entry** | A Content Collections item (`.md`/`.mdx` with frontmatter); `entry.data` is parsed frontmatter. |
| **selection** | The currently clicked element in the chrome; it survives reindex (re-matched after file changes). |
| **reindex** | Recomputing the indexer output after watched file changes; debounced; pushed to chrome via Vite WS events. |
| **dev-only guarantee** | Astroix never ships in production builds — an invariant, not a preference. |
| **core-first** | The rule that `docs/core-reuse.md` governs: if Astro/Vite core provides a mechanism, we don't build our own. |
