# Astroix

A standalone Electron parent app for Astro projects. An AI agent does ~90% of the work; Astroix finishes the last 10% — content tweaks and CSS polish — in a GUI instead of hunting through an unfamiliar codebase. You register an **existing** project, Astroix runs that project's own dev server under its supervision, renders the live site in a same-origin canvas, and edits the project's real files.

**Zero injection**: no Astroix package, integration, bridge, config mutation, or control file ever enters your project — only the explicit Content and CSS edits you make through the app.

**Status: Electron rewrite in progress (pre-alpha).** The former public npm integration is retired by design (ADR-0010); npm publication is paused. Delivery will be an unsigned, ad-hoc-sealed macOS (Apple Silicon) Electron pre-alpha for inner testers (ADR-0008). Docs are the source of truth.

## What it does

- **Content vertical** — edit Astro Content Collections through forms generated from zod schemas; markdown body editing; auto-write (~300 ms debounce) to real `.md` files; inline validation that never blocks a draft.
- **CSS vertical** — click any element on the live canvas, see which repo rules style it and **where they live in your repo** (file + line, cascade winner marked), edit them in place (declaration widgets or raw CSS), and get minimal-diff writes back to the source files with live HMR. Bidirectional sync with your IDE; element selection survives reindex.

Core principle: **repo-mapping, not a parallel world** — the app reads and writes the same files an agent would, so the repo stays coherent for both humans and AI.

One active project session at a time; switching is transactional and never mixes projects' data. Web mode (the same control plane without Electron) is the deterministic behavioral test host.

## Docs

- [`docs/spec.md`](docs/spec.md) — product spec: boundary, user stories, implementation decisions, testing doctrine
- [`docs/stack.md`](docs/stack.md) — technology stack and the reasoning behind each choice
- [`docs/core-reuse.md`](docs/core-reuse.md) — Astro/Vite seams by class: public / certified exact-pair / fail-closed private
- [`CONTEXT.md`](CONTEXT.md) — domain glossary (ubiquitous language)
- [`docs/adr/`](docs/adr/) — architecture decision records (0004–0010 govern the rewrite)

## Scope

Certified against exact Astro/Vite pairs (first: `astro@7.2.10` + `vite@8.2.2`, resolved from each project's own installation); macOS 13.5+ on Apple Silicon; desktop UI only. No project scaffolding, no multi-project editing, no signing/notarization/auto-update in the pre-alpha.

## Development

The repository is mid-migration to npm workspaces + Node 24 (chartered, ADR-0010); until that lane lands, the checkout still runs on bun and still contains the integration-era code as a retirement-bound migration oracle.

```sh
bun install                        # also in e2e/fixture/
bun run check && bun run typecheck # Biome + tsc
bun run test                       # vitest (unit)
bun run test:e2e                   # Playwright (integration-era oracle lanes)
```

Target workspace shape: `packages/core`, `packages/protocol`, `packages/runtime`, `packages/app-shell`, `apps/web`, `apps/desktop`, with `e2e/fixture` a plain Astro project. See `docs/stack.md` and `AGENTS.md`.

## License

[MIT](LICENSE)
