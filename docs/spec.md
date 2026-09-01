# Astroix — Spec

Status: product spec of record for the Electron parent-app rewrite · Authority: [map #197](https://github.com/wojtekpiskorz/astroix/issues/197) + [rewrite charter #203](https://github.com/wojtekpiskorz/astroix/issues/203); this rewrite landed as lane A1 ([#210](https://github.com/wojtekpiskorz/astroix/issues/210), 2026-09-01) and supersedes the integration-era spec in full (git history is provenance) · Project name: **Astroix** — a standalone Electron parent app; the former public npm integration (`@wojciechpiskorz/astroix`) is retired by this rewrite and never returns (ADR-0010). Pre-alpha delivery is a packaged unsigned macOS artifact (ADR-0008), not an npm package.

Astroix is the **Electron parent app for registered existing Astro projects**: a visual layer that hosts the project's own dev server, renders its live site in a same-origin canvas, and edits **Content Collections content** and **repo-mapped CSS** through the product's two verticals. It owns exactly **one active project session** at a time, performs **zero managed-project injection**, and is delivered as an **unsigned macOS Electron pre-alpha**. Web mode — the same control-plane implementation booted without Electron — is the **behavioral test host**: the protocol-level, deterministic, full-behavior surface every vertical is tested against; it is not the user-facing destination.

Vocabulary is normative: `CONTEXT.md` defines every term used here. Architecture decisions are recorded in `docs/adr/0004`–`0010`; this spec summarizes and binds them, it does not replace them.

---

## Problem Statement

An AI agent does ~90% of the work on Astro projects today, but the last 10% — a content fix ("change the hero lead") and CSS polish ("this image should be smaller and rounded") — forces the user to dig through a codebase they may not know at all: finding the right markdown file, the frontmatter, the CSS file behind one specific element on the page. It inverts the proportions: a trivial change costs more than the agent-built section around it.

The problem has two faces:

1. **Content**: page and post content lives in Content Collections frontmatter — editing without a GUI means hand-writing YAML and guessing fields.
2. **CSS**: element styles are scattered across `.css` files and scoped `<style>` blocks in `.astro` files — there is no map from "element on screen" to "file in the repo".

The integration-era answer (an Astro integration installed into the managed project) is settled history: it demanded package installation and config registration inside the project, and is retired (ADR-0010). The product answer is a **parent app**: Astroix registers a project the developer already trusts, runs that project's own dev server under its supervision, and edits the project's real files — with nothing of Astroix ever entering the project.

## Product Boundary and Trust Model

Ruled in [#205](https://github.com/wojtekpiskorz/astroix/issues/205) (ADR-0004); threat detail in [#199](https://github.com/wojtekpiskorz/astroix/issues/199) (ADR-0007).

- **Destination**: a working macOS-first unsigned Electron pre-alpha. Web mode is the protocol-level test, diagnostic, and development host — never the completion milestone.
- **Registered existing projects**: pre-alpha registers projects that already exist. `Add Existing Project...` is a native Electron action (application menu / neutral trusted launcher); Electron main obtains the chosen directory and hands it to the Astroix runtime for validation. No project creation, scaffolding, or templating.
- **One active session**: Astroix owns one supervisor-global active project session. A switch replaces that session transactionally and performs a top-level navigation to the new project's app origin. No simultaneous active projects, per-tab sessions, or multi-window editing.
- **Developer-trusted projects**: the registered project, its Astro configuration, integrations, dependencies, inline code, and external scripts are developer-trusted executable code — a trust inherent in starting its dev server. Astroix does not sandbox, filter, or audit them. The project plane is a failure and lifecycle boundary, **not** a malicious-code sandbox.
- **Same-origin direct DOM**: the app shell and canvas share the active project's origin for direct canvas DOM access (`iframe.contentDocument`, `Element.matches()`). A canvas that navigates off the project origin may stay visible, but editing is unavailable until it returns.
- **No privileged renderer bridge**: the renderer receives no raw Electron API, no generic filesystem bridge, no raw IPC — only the product operations Astroix needs.
- **Zero-injection guarantee** (replaces the integration-era "dev-only guarantee"): Astroix never adds an Astroix dependency, integration, generated bridge, Astro config mutation, package manifest mutation, or hidden control file to a managed project. Permitted side effects: explicit Content edits initiated through Astroix; explicit mapped-CSS edits initiated through Astroix; ordinary Astro/Vite runtime caches. Registering or removing a project never changes its source files.

## Solution

A standalone Electron app. The app shell (sidebar + editor dock + canvas, the retained workbench-row layout) is served from Astroix's reserved origin namespace; the canvas is a same-origin iframe loading the project's **natural URL** (including its resolved Astro `base`) on the active project hostname, proxied through the control plane to the project's managed dev server. Two verticals, both preserving the settled editing contracts:

- **Content**: GUI over Content Collections — forms generated from zod schemas (custom fields become fields), markdown body editing, auto-write (debounce ~300 ms), inline validation that never blocks saving.
- **CSS**: selection mode on the canvas. Click an element → the repo rules matching it, each with file and line, winner marked in the cascade → inline editing (property→value rows with color/unit/enum widgets; plus raw mode) → text-splice into the original source file with auto-write debounce → HMR = live preview.

The core principle survives unchanged: **repo-mapping, not a parallel world**. Astroix reads and writes the real repo files where an agent would put them ("nearest home"), so the repo stays coherent for humans and agents alike. Bidirectional sync (a hard requirement): a save in the IDE live-updates both canvas and the open panel of the selected element's rules after reindex; a change in the app writes the local file. Element selection survives reindex.

## User Stories

Grouped; the editing contracts carry over from the integration era unchanged in behavior, re-framed for the parent app.

### Registration and session

1. As a developer, I want to register an existing Astro project from a native file chooser, so the project needs no Astroix package, config, or any other injection.
2. As a developer, I want Astroix to remember my registered projects between launches, so I do not re-register each session.
3. As a developer, I want to rename or remove a registered project from the launcher, and removal must never delete project files.
4. As a developer, I want exactly one active project session, with switching that never mixes two projects' data, so a stale tab, selection, or queued write can never land in the wrong project.
5. As a developer, when the canvas navigates away from the project origin it may stay visible but editing is disabled, so I never edit through a foreign document.

### Canvas and selection

6. As a developer, I want a real-viewport canvas (iframe with live page, its own HMR), so media queries and `vw` units do not lie.
7. As a developer, I want hover outlines in selection mode, so I see what I will click before I click it.
8. As a developer, I want to switch selection mode off, so I can click links and interact with the page normally.

### CSS vertical

9. As a developer, clicking an element shows the matching repo rules — each with file and line — so I know WHERE in the repo its styles live.
10. As a developer, the winning rule in the cascade is marked, so I do not edit a losing rule and wonder why nothing changed.
11. As a developer, scoped rules from `.astro` `<style>` blocks are shown readably (hash `data-astro-cid-*` filtered), so scoped styles are not black magic.
12. As a developer, rules in `@media` queries carry the condition as a badge, so I know a rule is conditional.
13. As a developer, I edit a rule in place through widgets (color, units, enums) or raw mode, so basic fixes need no hand-writing.
14. As a developer, an edit writes the original source file preserving formatting, so the git diff is minimal and the agent reads its known world.
15. As a developer, auto-write with debounce (~300 ms) plus live HMR preview means no Save button, so style tweaking is immediate.
16. As a developer, undo lives in session memory, so experiments are reversible without touching git.
17. As a developer, a new rule lands in the nearest styled ancestor/sibling's file ("nearest home"), with a dropdown of alternatives and a per-route overrides fallback loaded last, so the repo stays coherent and there is always somewhere to write.
18. As a developer, clicking an element shows its source component file (from dev-mode source instrumentation), so element→source navigation is immediate.

### Content vertical

19. As a developer, I get the list of collections and entries, so I find content to edit without knowing repo paths.
20. As a developer, the form is generated from the zod schema, so custom fields (e.g. `hero.title`, `hero.cta.href`) are fields, not YAML to hand-edit.
21. As a developer, inline zod validation flags errors per field, but never blocks saving, so I can save a schema-breaking draft and leave the fix to the agent.
22. As a developer, I edit the markdown body with preview, so body fixes need no IDE.
23. As a developer, auto-write for content works like CSS (debounce ~300 ms, live canvas reload through Astro sync), so content has the same immediate edit→disk→preview loop.
24. As a developer, I can create new entries as drafts (frontmatter flag), so I can sketch posts from the GUI.
25. As a developer, unsupported schema subtrees render as clearly marked editable YAML fields (raw fields) and `image()` metadata round-trips untouched, so every schema opens in the builder.

### Sync and write safety

26. As a developer working beside an agent, an mtime/hash guard precedes every write, so Astroix reloads and shows a diff instead of overwriting a file changed underneath.
27. As an agent, I read files written by Astroix as ordinary repo files, so my work needs no awareness of the builder.
28. As a developer, Astroix never performs git operations, so versioning stays exclusively my decision.
29. As a developer, a file save in my IDE live-refreshes both the canvas and the open rule panel of the selected element, so builder and IDE never drift.

### App qualities

30. As a developer, the app shell renders in shadow DOM, so page styles and builder styles never fight.
31. As a developer, I work on loopback with activation-bound request authorization (no ambient authority in URLs), so the dev tool needs no auth setup yet remote and stale traffic cannot act.

## Implementation Decisions

The full contracts live in the ADRs; each decision below names its authority. Anything not listed here retains its integration-era contract where the verticals are concerned (auto-write doctrine, route resolution, raw truth/raw field/zod projection, nearest home, overrides fallback) — those editing-domain contracts were extracted as behavior contracts during migration and bind the replacement unchanged.

1. **Form factor**: a standalone Electron parent app (ADR-0004). Electron main is a thin native host (window, menus, single instance, lifecycle, Electron security policy); the trusted **control plane** is a separate long-lived Node-compatible process; the **project plane** is a disposable runtime group (project-runtime worker, managed Astro dev server, composition Vite server, fresh runners, watchers, timers) (ADR-0005). No Astroix code executes inside the managed project's own process tree beyond its own dev server.
2. **Origins and proxy**: one loopback port per control-plane lifetime. Neutral launcher at `http://launcher.localhost:<port>/__astroix/app/`; active project app at `http://<project-key>.localhost:<port>/__astroix/app/`. `/__astroix/` is Astroix's reserved namespace — a project claiming it fails compatibility validation. The canvas loads the project's natural URL (resolved `base` included); every non-reserved HTTP request streams to the managed dev server; WebSocket upgrades preserve URL/Host/Origin/HMR token/`vite-hmr` subprotocol and upstream handshake bytes; the proxy never synthesizes a `101`. A switch performs top-level `location.replace()` to the new project hostname — never data swaps inside the old origin (ADR-0005).
3. **ProjectRuntime**: the deep, process-neutral interface (`start()` → `ProjectRun` with `ready`/`inspect()`/`subscribe()`/`stop()`/`closed`); `inspect()` accepts only typed `project`, `content`, `routes`, `styles` requests, each result carrying a monotonic resource revision; no PID, port, Vite handle, runner, watcher, timer, or raw path escapes the interface (ADR-0005).
4. **Registry**: canonical-root project identity (`fs.realpath` + filesystem case/identity semantics), random 128-bit lowercase-Base32 DNS-safe `ProjectKey` allocated per record (never derived from the root), versioned JSON persistence below Electron `userData` (dir `0700`, files `0600`), atomic same-directory-rename writes with `fsync`, last-known-good snapshot, quarantine + explicit recovery on corrupt/future schema, one kernel-backed registry-writer lease lifetime-held by the control-plane child (ADR-0006; lease mechanics per [#209](https://github.com/wojtekpiskorz/astroix/issues/209)).
5. **Session and edit authority**: `SessionRef` (`runtimeEpoch` + `generation`) on every session-scoped command, response, error, query key, and event; request authority is a separate 256-bit capability (host-only `HttpOnly` cookie, `Path=/`) plus an Electron-injected per-document client capability; one authoritative editing client, up to three read-only diagnostic targets; activation is a serialized staged transaction with rollback, bounded drain (5 s), forced-reap path (2 s), one-use switch-preparation receipts, and irreversible post-revocation failure handling; each session owns a disposable serialized write executor lifetime-holding the kernel-backed edit-writer lease; the server issues opaque per-activation resource grants bound to revision contracts, exact SHA-256 baselines for existing resources, expected-absent exclusive creation, `realpath` containment recheck immediately before commit, external symlinks ungrantable, `nlink > 1` rejected (ADR-0006).
6. **Protocol v1**: control traffic below `/__astroix/api/v1/`, every envelope carries `protocolVersion: 1`; events are same-origin SSE at `/__astroix/events` (Vite HMR is the only transparent WebSocket); strict Host/Origin/Fetch Metadata/capability checks, no CORS, unknown-field and ambiguous-encoding rejection, hard size limits, stable sanitized error envelopes that never disclose roots, ports, PIDs, environment values, capabilities, or stacks (ADR-0006).
7. **Security posture**: loopback-only listener bound before an origin is published; Host validation rejecting unknown/malformed/duplicate/trailing-dot/rebinding values; activation-bound authority checked at dispatch and again immediately before every write; no operations for arbitrary paths, shell commands, PID kills, arbitrary module evaluation, raw Vite handles, or git (ADR-0007 + the #199 negative-test matrix).
8. **Service workers**: the authoritative BrowserWindow and its canvas live in a fresh non-persistent Electron partition; CDP `Network.setBypassServiceWorker({ bypass: true })` is attached before the first project navigation and retained — a detach (including opening DevTools) makes the target unready and disables edits until bypass is restored. Astroix does not promise Service Worker or PWA fidelity inside the editor (ADR-0009).
9. **Compatibility**: Astroix supports the latest stable Astro available when an Astroix release ships, driven by **certified exact Astro/Vite pairs** — first certified pair `astro@7.2.10 + vite@8.2.2` ([#206](https://github.com/wojtekpiskorz/astroix/issues/206)); Astro and Vite resolve from the managed project's own installation; an uncertified pair fails before project config executes with the detected pair, certified pairs, and rejected contract; all version-sensitive behavior lives behind the internal `AstroProjectAdapter` whose private seams fail closed (ADR-0005, `docs/core-reuse.md`). Real project config and integrations execute in both the managed dev server and the composition inspector — duplicate hook execution is an explicit accepted pre-alpha cost, confined to the disposable project plane.
10. **Editing domain**: the Content/CSS editing contracts of the integration era are preserved — content read through the fresh module runner per inspection pass (closed in `finally`), schema introspection through the shared zod instance, the static postcss index as CSS edit-truth joined with effective selectors from real Astro output, text-splice writes preserving formatting, yaml Document API serialization, route resolution as a pure module. See `docs/core-reuse.md` for the seam classes.
11. **Web behavioral hosting**: web mode boots the same control-plane implementation as its test and diagnostic host — the deterministic full-behavior surface for Playwright and diagnostics. It acquires no registry write authority (tests inject an isolated registry) and is not the user-facing destination (ADR-0004/#205, ADR-0008/#207).
12. **Electron pre-alpha delivery**: one Forge-built, ad-hoc-sealed Apple Silicon (`arm64`) macOS 13.5+ ZIP with bundled stock Node 24 (`Contents/Resources/node/`), immutable verified runtime resources under `Contents/Resources/astroix-runtime/`, hardened release fuses (ASAR integrity, only-load-app-from-ASAR, RunAsNode/NODE_OPTIONS/CLI-inspection disabled), inner-tester delivery through access-limited GitHub draft releases with SHA-256 checksums, smoke-before-publish on the exact candidate bytes (ADR-0008). Qualified environment floor per [#209](https://github.com/wojtekpiskorz/astroix/issues/209): stock Node 24.20.0 (`node:sqlite` `DatabaseSync` holds the two fixed lease files).
13. **Migration**: additive — reusable core and UI foundation are extracted under behavior contracts, the canonical fixture becomes a plain Astro project, then the integration, injected chrome, old delivery lanes, and npm publish machinery are deleted **before** replacement-runtime implementation. No side-by-side parity cutover; the replacement is judged against the extracted behavior contracts, the web checkpoint, and the packaged pre-alpha qualification gate (ADR-0010).

Stack, plumbing, and tooling (npm workspaces, Node 24, Electron/Forge pins, React 19, TanStack, vitest, Playwright, Biome): **see `docs/stack.md`**. The inventory of Astro/Vite mechanisms reused, by seam class (public / certified exact-pair / fail-closed private): **`docs/core-reuse.md`**.

## Testing Decisions

Rule unchanged: test only external behavior (resulting file bytes, matched rules on fixtures), never index internals.

- **Unit (vitest + happy-dom)**: pure modules — indexer/matcher, splice-writer, route resolution, protocol schemas, registry/session state machines where pure.
- **Web host (Playwright)**: web mode is the deterministic full-behavior test host — the only source of truth for selector-engine behavior (`[data-astro-cid-*]` under the default `attribute` scopedStyleStrategy; `:where(...)` only when configured) and full builder loops, including the A-to-B-to-A switch races, stale-authority rejection, and zero-injection byte/metadata snapshots.
- **Behavior contracts**: payloads, matched selectors, conflicts, and output bytes captured from the integration oracle before retirement bind the replacement (`docs/adr/0010`).
- **Electron smoke**: an early packaged-host smoke precedes vertical work; a separately marked instrumented Electron build may test wiring but is never release evidence.
- **Packaged qualification**: the exact hardened release artifact is tested black-box (resource discovery, process topology and cleanup, security settings, launch lifecycle) plus the owner Finder/UI smoke — only at candidate/release checkpoints, never on every feature PR (ADR-0008). The final owner manual smoke is `docs/manual-smoke.md`.
- **No-E2E interval**: between the retirement gate and the first web-host slice there is explicitly no product E2E lane; CI must not present that interval as a passing E2E (ADR-0010).
- Hybrid pattern retained: `@playwright/test` in CI as source of truth; Playwright MCP locally for exploring and authoring deterministic specs.

## Out of Scope

From map #197, binding:

- Public npm launch, signing, notarization, auto-update, and production distribution — the destination is an unsigned inner-tester pre-alpha.
- Creating new Astro projects and template UX — pre-alpha registers and manages existing projects.
- Multiple simultaneous active projects, multi-window editing, per-tab project sessions.
- GitHub-connected remote projects, dependency updates, project build/check orchestration, app self-update.
- Mobile or narrow-viewport UI (ADR-0003, reaffirmed).
- Support for Astro below 7, Vite below 8, zod 3 — or any Astroix presence in a managed project's production build.
- WYSIWYG/block editing/drag-drop layout; SCSS; Tailwind class emission; breakpoint widgets; DevTools-style cascade strikethroughs; content beyond Content Collections (`.ts` data files, DB/CMS); git operations.

## Provenance

- Boundary, trust, and domain model: [#205](https://github.com/wojtekpiskorz/astroix/issues/205) (ADR-0004).
- Runtime, origin, introspection: [#202](https://github.com/wojtekpiskorz/astroix/issues/202) (ADR-0005); adapter proof [#206](https://github.com/wojtekpiskorz/astroix/issues/206).
- Registry, session, edit authority, protocol v1: [#204](https://github.com/wojtekpiskorz/astroix/issues/204) (ADR-0006); lease proof [#209](https://github.com/wojtekpiskorz/astroix/issues/209); packaged-host proof [#201](https://github.com/wojtekpiskorz/astroix/issues/201).
- Threat model: [#199](https://github.com/wojtekpiskorz/astroix/issues/199) (ADR-0007).
- Packaged artifact and delivery: [#207](https://github.com/wojtekpiskorz/astroix/issues/207) (ADR-0008).
- Service worker and editor transport: [#208](https://github.com/wojtekpiskorz/astroix/issues/208) (ADR-0009).
- Migration and retirement: [#200](https://github.com/wojtekpiskorz/astroix/issues/200) (ADR-0010).
- Charter and DAG: [#203](https://github.com/wojtekpiskorz/astroix/issues/203); map: [#197](https://github.com/wojtekpiskorz/astroix/issues/197).
- The integration-era spec (Polish, last revision at the #176 merge) is provenance in git history; its editing-domain decisions survive as the preserved contracts summarized above.
