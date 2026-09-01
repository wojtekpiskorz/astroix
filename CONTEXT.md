# Astroix — Domain Glossary

The ubiquitous language of this project. Use these terms (and these exact spellings) in issues, specs, tests, and proposals; don't drift to synonyms. Maintained via `/domain-modeling` as terms get resolved.

Rewritten for the Electron parent-app rewrite (lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210)); rulings: [#205](https://github.com/wojtekpiskorz/astroix/issues/205) (boundary and domain model), [#204](https://github.com/wojtekpiskorz/astroix/issues/204) (registry, session, edit authority). Architecture entries are one-line pointers — their normative definitions live in `docs/spec.md` and `docs/adr/0004`–`0010`.

## Product identity

| Term | Meaning |
| --- | --- |
| **Astroix** | The product: the Electron parent app — a visual layer for registered Astro projects, owning one active project session. |
| **app shell** | The builder UI: the Astroix-rendered application (React app in shadow DOM) hosting the workbench row and wrapping the canvas. Replaces the integration-era term `chrome`. |
| **canvas** | The same-origin iframe in the app shell showing the project's live page at its natural URL (including its resolved Astro `base`) on the active project hostname. |
| **vertical** | A top-level lane of the builder product — CSS (styles panel), Content (entries editing). In the app shell, each vertical gets its own feature folder, store, and query hooks (ADR-0002). |
| **workbench row** | The app shell's main horizontal band below the header — sidebar + editor dock + canvas — laid out by the shell. |
| **sidebar** | The shell's left rail: vertical tabs and the active vertical's browsing panel (rules list / entries list). |
| **editor dock** | The shell-owned column slot between the sidebar and the canvas hosting the active vertical's editor pane (rule editor / entry form); uniform width, the frame belongs to the shell. |
| **launcher** | The neutral trusted page at `http://launcher.localhost:<port>/__astroix/app/`, shown before any project is active: project list, registration entry point, corrupt-registry recovery. |
| **web mode** | The protocol-level test, diagnostic, and development host: the same control-plane implementation booted without Electron. It acquires no registry write authority and is not the user-facing destination. |
| **repo-mapping** | The core principle: the builder reads/writes the same repo files an agent would — never a parallel world. |
| **zero-injection guarantee** | Astroix never adds an Astroix dependency, integration, generated bridge, config or manifest mutation, or hidden control file to a managed project; only explicit Content/mapped-CSS edits and ordinary Astro/Vite caches may touch it. Replaces the integration-era `dev-only guarantee`. |

## Runtime and planes

| Term | Meaning |
| --- | --- |
| **Astroix runtime** | The executable application logic outside the renderer: the control plane plus the project planes it supervises. |
| **control plane** | The long-lived, trusted, Node-compatible process owning Astroix state, authority, routing, and lifecycle: registry, sessions, the loopback listener/proxy, edit-authority gating. Web mode boots this same implementation. |
| **project plane** | The disposable runtime group per project run: the project-runtime worker, the managed dev server, the composition Vite server, fresh runners, watcher subscriptions, and timers. A failure and lifecycle boundary — not a sandbox against developer-trusted project code. |
| **managed dev server** | The Astro dev process belonging to a project session — started, proxied, and reaped by the runtime; the project's own server, never a reimplementation. |
| **ProjectRuntime** | The deep, process-neutral seam interface to a project run (`start()` → `ProjectRun`: `ready`/`inspect()`/`subscribe()`/`stop()`/`closed`). Sibling deep seams inside the runtime package: `ProjectRegistry`, `SessionSupervisor`, `EditAuthority` — deep modules, none a package of its own. |
| **ProjectRun** | One supervised process attempt, including a private staged candidate. |
| **certified pair** | An exact Astro+Vite version pair accepted for the `AstroProjectAdapter` — first: `astro@7.2.10 + vite@8.2.2` ([#206](https://github.com/wojtekpiskorz/astroix/issues/206)). Astro and Vite resolve from the managed project's own installation; an uncertified pair fails before project config executes; a new pair enters the set only after the compatibility fixture and the migration oracle pass. |

## Registry and session

| Term | Meaning |
| --- | --- |
| **Registered Project** | A persisted reference to one canonical existing Astro project root (identity = `fs.realpath` + the filesystem's own case/identity semantics; aliases resolve to the existing record). |
| **managed project** | The developer's Astro project under Astroix's supervision — its dev server started and reaped by the project plane, its real files the editing surface. Wider than Registered Project: the zero-injection guarantee and production-build absence bind it whether or not a session is active. |
| **Project Key** | A random 128-bit lowercase-Base32 DNS-safe routing key allocated when a registry record is created; stable only for that record's lifetime (`http://<project-key>.localhost:<port>/`). Never project identity, never authority. |
| **project session** | The one committed, authority-bearing active run, identified publicly by its `SessionRef`. |
| **SessionRef** | The public session identity pair `{ runtimeEpoch, generation }`: a fresh random epoch per control-plane lifetime, a monotonic generation per activation attempt. Correlation and freshness data — not authentication. Carried by every session-scoped command, response, error, query key, and event. |
| **activation attempt** | The staged transaction that may commit a candidate run or roll it back while preserving the old session. |
| **origin lease** | The control plane's grant of the active project hostname route to one session; revoked before children are reaped on every stop or crash path. |

## Edit authority

| Term | Meaning |
| --- | --- |
| **authoritative editing client** | The one session- and document-bound browser target that owns the global lifecycle controls and the editor lease. Server-enforced role, not a UI convention. |
| **diagnostic target** | A read-only browser target (up to three) with separately bound client authority: inspection only, never an editor lease or editable resource grants. |
| **edit authority** | The per-session server capability that issues and executes revision-bound resource grants for resources discovered by Astroix's own Content or style model — never a client-selected path. |
| **resource grant** | An opaque, random, per-activation authorization for one discovered resource and its allowed operation set; bound to the canonical project identity, `SessionRef`, resource kind, and revision contract (exact SHA-256 baseline for existing resources, expected-absent for creation). |
| **resource revision** | The monotonic per-resource version carried by every inspection result; writes require and return revisions — the freshness contract behind grants. |
| **write executor** | The exact, disposable, serialized executor each session owns for accepted filesystem work; it lifetime-holds the kernel edit-writer lease until all accepted work is terminal and it exits. |
| **kernel lease** | A lifetime-held, kernel-backed exclusive writer lease (stock Node `node:sqlite` `DatabaseSync` + `BEGIN IMMEDIATE` on a fixed private file): `registry-writer` for the control-plane child, `edit-writer` for a session's write executor. Process exit is the release boundary; exclusive acquisition is the only same-boot proof no live holder remains. |

## Editing domain (contracts preserved from the integration era)

| Term | Meaning |
| --- | --- |
| **indexer** | The pure module that scans project CSS sources into the index: selector → (file, source range, media condition). The edit-truth. |
| **matcher** | The pure module that, given the index and a clicked element, returns matching rules (via `el.matches()`), sorted by specificity. |
| **effective selector** | The compiled form of a selector as it actually matches in the canvas DOM — for scoped rules, carrying the `data-astro-cid-*` attribute; distinct from the source-space selector the indexer reads. |
| **index payload** | The join of the static index (edit-truth) with effective selectors from the module graph, served to the app shell for matching. |
| **splice-writer** | The pure module applying rule edits as text-splices into source files, preserving formatting. |
| **rule** | One CSS rule from the repo, with its source location. |
| **nearest home** | Destination heuristic for a NEW rule: the file that styles the closest styled ancestor/sibling. Deferred beyond the pre-alpha with all new-rule placement ([#203](https://github.com/wojtekpiskorz/astroix/issues/203)). |
| **overrides file** | Fallback destination (per-route CSS loaded last in the cascade), when no home exists. Deferred beyond the pre-alpha with all override/new-rule placement ([#203](https://github.com/wojtekpiskorz/astroix/issues/203)). |
| **entry** | A Content Collections item (`.md`/`.mdx` with frontmatter); `entry.data` is parsed frontmatter. |
| **active entry** | The entry open in the content editor; set manually (list click) or reactively (route resolution from the canvas URL). |
| **route resolution** | Matching the canvas URL against route patterns and entry ids to find the entry rendered there, and back (entry → canvas); a unique hit — or a plurality whose candidates all resolve to the same entry — selects; other ambiguity/no-match stays silent; a pure core module. |
| **candidate route** | A route pattern that plausibly renders a given entry, with the canvas URL it produces; entry→canvas navigation picks the most specific candidate of a same-entry plurality (segment param before catch-all, then shallowest), re-verified by forward match. |
| **unrouted entry** | An entry no route actually renders — marker truth comes from `getStaticPaths`-aware enumeration (candidate routes gate on rendering truth); unknown enumeration degrades to the shape premise and never fires the marker. The sidebar marks it (dimmed marker + tooltip): a legend for the click's navigational silence, never a disable. |
| **raw mode** | The CSS rule editor's free-form mode: the rule's declarations edited as plain CSS text instead of property→value widget rows. |
| **raw field** | The textarea fallback rendering an unsupported schema subtree as editable YAML. |
| **raw truth** | The entry file's own parse as the content editor's single truth-space: the form's values, the write loop's baseline, and the pane's halves all live in it; the file's bytes are its anchor, writes are byte-surgical against them. Distinct from raw mode/raw field (both widget concerns). |
| **zod projection** | The collections payload's `entry.data` — Astro's zod output with defaults filled and transforms applied. In the pane it is display-only (image() metadata the raw truth cannot produce), plus sidebar data and the change signal; never the form's truth. |
| **widget-display** | A zod default rendered by the widget while the raw truth keeps the key absent: placeholder semantics for string, number, enum and raw kinds, checked-state display for boolean, natural-empty for arrays; a touch materializes the key, the write follows. |
| **auto-write** | The persist-on-pause write loop (debounce ~300 ms) writing the real repo file; the shared persistence doctrine of both verticals. |
| **selection** | The currently clicked element in the app shell; it survives reindex (re-matched after file changes). |
| **reindex** | Recomputing the indexer output after watched file changes; debounced; surfaced as revisioned invalidations over the protocol's event stream. |

## Migration era (transitional — dies with the integration, ADR-0010)

| Term | Meaning |
| --- | --- |
| **behavior contract** | An executable contract frozen from integration-era behavior (payloads, selector matches, conflicts, output bytes; lanes B1/B2). The replacement is judged against these, not against the old implementation. |
| **migration oracle** | The integration-era implementation retained during migration as the source of behavior-contract extraction and reusable-core/UI extraction — a retirement-bound reference (ADR-0010), not the product and not a compatibility contract. |

## Repo tooling

| Term | Meaning |
| --- | --- |
| **core-first** | The rule that `docs/core-reuse.md` governs: if Astro/Vite core provides a mechanism (within its seam classes), we don't build our own. |
| **preflight** | The local CRAP hard stop (`npm run preflight`): a baseline ratchet over `src/` + `packages/core` + `packages/app-shell` (future workspace packages join in their landing PR) — every run fails any new stop breach, complexity or coverage regression alike; the agent runs it before `gh pr create`. |
| **baseline ratchet** | `crap-baseline.json`: calibrated once, then only tightens or drops. New stop-breachers fail preflight; the baseline never absorbs them. |
| **watchlist** | The CC-only risk tier for tiers where per-function unit coverage is not real; the generated `components/ui/` folder is watch-only — visible, never gated. |
| **metric honesty** | The principle that CRAP is computed only where per-function coverage is real (the pure core); everywhere else stays a CC watchlist. |

Removed with the integration (do not reintroduce): `chrome` (→ app shell), `smoke gate`, `hint pill`, `wizard`, `copy report`, `dev-only guarantee` (→ zero-injection guarantee), `content-sync leg` (Vite-WS-specific push sequencing), and the generic `supervisor` (`SessionSupervisor` survives only as the seam-interface name).
