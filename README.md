# Astroix

A visual builder for Astro projects — a standalone application where an AI agent does ~90% of the work, and you finish the last 10% (content tweaks, CSS polish) in a GUI instead of hunting through an unfamiliar codebase. Astroix manages local Astro projects from the outside: a supervisor runs their dev servers behind per-project local hostnames, and the builder UI edits the real repo files (repo-mapping, never a parallel world). It writes only the content/CSS files you explicitly edit — never config or dependencies.

**Status: pivot in progress.** Astroix is being rebuilt as that standalone app (ADR-0004, map #179; the former dev-only Astro integration is deprecated on npm). The docs set is ratified; execution runs in the charter lanes (#188) — toolchain → monorepo → supervisor → app UI → e2e/pre-alpha. Until the pre-alpha ships, this repo is the product surface.

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

Requires Node >= 22.12 and npm.

```sh
npm install                       # also in e2e/fixture/
npm run check && npm run typecheck # Biome + tsc
npm run test                      # vitest (unit)
npm run test:e2e                  # Playwright (boots e2e/fixture on :4314)
npm run build                     # tsup (node side) + vite build
```

*(Transition state: a few scripts still shell out to bun internally until the toolchain-migration lane lands — the invocation is `npm run <script>` either way; recorded in AGENTS.md.)*

### Dogfood loop

Post-pivot dogfood is the app against the `e2e/fixture` project and real Astro projects (#185). The integration-era staging loop (`.astroix-local/`, `prepare-local`) retires with the restructure lane (L2, #192) — it served the deprecated integration's fixture consumption and is not part of the app.

### Ports *(integration-era e2e lanes; retire in L2, #192)*

The owner's manual smoke owns `:4312` (`bun run smoke`); the e2e lanes never touch it — Playwright boots the main lane on `:4314` (`ASTROIX_E2E_PORT` in the fixture's dev script) and the npm-pack lane on `:4313` (`ASTROIX_E2E_PACK_PORT`); both ports stay canonical for CI, while parallel local lanes override the pair per worktree (#120) so sibling checkouts never race for — or adopt — each other's dev servers. Both lanes always boot their own servers (`reuseExistingServer: false`), and the fixture dev script runs astro with `--ignore-lock` — astro's per-project single-server guard would otherwise refuse the e2e instance while the owner's smoke server runs; both paths own their lifecycle externally (the smoke script pre-checks its port, Playwright kills its own servers).

### Definition of done (POC)

The executable DoD is `e2e/loop.spec.ts` (the full CSS editing loop: chrome → select → rule list → CodeMirror edit → bytes on disk + canvas reflection), green in CI. The human half — the owner's manual smoke through the real chrome — is [`docs/manual-smoke.md`](docs/manual-smoke.md); `bun run smoke` prepares and boots the environment in one command.

## License

[MIT](LICENSE)
