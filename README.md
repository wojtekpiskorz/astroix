# Astroix

A visual builder for Astro projects — a dev-only integration where an AI agent does ~90% of the work, and you finish the last 10% (content tweaks, CSS polish) in a GUI instead of hunting through an unfamiliar codebase.

**Status: scaffold.** The package structure, toolchain, CI, and the e2e fixture are in place; feature implementation is starting. Docs remain the source of truth.

## What it will do

- **Content tab** — edit Astro Content Collections through forms generated from zod schemas; markdown body editing; writes real `.md` files.
- **CSS tab** — click any element on the live canvas (same-origin iframe), see which rules style it and **where they live in your repo** (file + line), edit them in place (declaration widgets or raw CSS), and have changes written back to the source files with minimal diffs. Live bidirectional sync with your IDE.

Core principle: **repo-mapping, not a parallel world** — the builder reads and writes the same files an agent would, so the repo stays coherent for both humans and AI.

## Docs

- [`docs/spec.md`](docs/spec.md) — product spec: problem, solution, user stories, implementation decisions, testing strategy
- [`docs/stack.md`](docs/stack.md) — technology stack and the reasoning behind each choice
- [`docs/core-reuse.md`](docs/core-reuse.md) — inventory of Astro/Vite core APIs reused instead of rebuilt

## Scope

Targets the latest Astro major only (`astro ^7`, Vite 8, zod 4) — built for new projects and their maintenance, not for legacy support.

## Development

Requires [bun](https://bun.sh) and Node >= 22.12.

```sh
bun install                        # also in e2e/fixture/
bun run check && bun run typecheck # Biome + tsc
bun run test                       # vitest (unit)
bun run test:e2e                   # Playwright (boots e2e/fixture on :4312)
bun run build                      # tsup → dist
```

## License

[MIT](LICENSE)
