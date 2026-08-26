# AGENTS.md

Astroix is a dev-only Astro 7 integration — a visual builder with a chrome over a same-origin iframe canvas for editing Content Collections content and repo-mapped CSS. **Pre-implementation:** `docs/` is the source of truth; no production code exists yet.

## Read the docs first

- `docs/spec.md` — product spec: user stories, implementation decisions, testing seams
- `docs/stack.md` — technology choices with rationale
- `docs/core-reuse.md` — Astro/Vite core APIs we reuse instead of building

When your work touches an architectural decision, these files win over your priors. If your change contradicts one, surface the conflict explicitly instead of silently overriding.

## Commands

- No build/test commands exist yet — the package scaffold is pending. This section gets its canonical commands with it.
- Package manager is **bun**. Run bun; never npm/pnpm/yarn.
- Expected future commands (do not run until they exist): `bun run check`, `bun run test`, `bun run test:e2e`, `bun run build`.

## Repo layout

- `docs/` — spec, stack, core-reuse: the decision record
- `docs/agents/` — agent-workflow config (issue tracker, triage labels, domain docs)
- `docs/adr/` — architecture decision records; read those touching your area before proposing changes
- `CONTEXT.md` — domain glossary (ubiquitous language); use its terms in issues, tests, proposals
- `.out-of-scope/` — knowledge base of triaged-out requests, with reasons

## Code style (agreed, lands with the scaffold)

- TypeScript strict, ESM-only, `moduleResolution: bundler`
- Biome is canonical for lint + format. Do not introduce eslint/prettier configs.
- React 19 + React Compiler: no manual memoization. TanStack (Form/Query) where applicable; zustand for client-only UI state.
- Plain async/TS. No Effect — decision recorded in `docs/stack.md`.

## Testing doctrine

- **Unit (vitest + happy-dom)**: pure modules only. The CSS indexer/matcher and splice-writer are pure functions over fixtures — test behavior (matched rules, output bytes), never index internals.
- **E2E (Playwright)**: the only source of truth for selector-engine behavior (`:where([data-astro-cid-*])`, quoting edge cases) and full builder loops.
- Author specs by exploring with Playwright MCP locally, then commit deterministic specs for CI.

## PR & release

- Every PR touching code needs a changeset (patch by default).
- Conventional-commit titles (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep PRs surgical: every changed line should trace to the task.

## Boundaries

Always:

- Check `docs/core-reuse.md` before building any mechanism — if Astro/Vite core already provides it, use it.
- Use glossary terms from `CONTEXT.md`.

Ask first:

- Adding dependencies.
- Changing anything recorded in `docs/stack.md` (these are research-backed — bring evidence).

Never:

- Support Astro < 7, Vite < 8, or zod 3. Out of scope by spec; close such issues as wontfix with a pointer to `docs/spec.md`.
- Break the dev-only guarantee: astroix must not exist in production builds.
- Force-push (`main` is protected).
- Weaken, skip, or regenerate tests to make a failing suite pass.

## Gotchas (from core-reuse research)

- Astro dev pages never pass through Vite's HTML middleware: the `transformIndexHtml` plugin hook is useless here — use `server.transformIndexHtml()` inside middleware.
- Astro dev generates no CSS sourcemaps: the static postcss index is the edit-truth.
- Never splice from `convertToTSX` `metaRanges` — positions are in TSX-output space.
- Full trap list: `docs/core-reuse.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
