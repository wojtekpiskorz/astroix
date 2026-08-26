# ADRs

Architecture Decision Records for Astroix. Number sequentially: `NNNN-kebab-title.md` (e.g. `0001-iframe-canvas.md`). Status: `proposed` / `accepted` / `superseded by NNNN`.

## Where decisions live today

The founding decisions are recorded in prose docs, not ADRs:

- `docs/spec.md` — product/architecture decisions (iframe canvas, repo-mapping, persistence model)
- `docs/stack.md` — technology decisions with research rationale
- `docs/core-reuse.md` — what we reuse from Astro/Vite core instead of building

Start writing ADRs when implementation produces decisions that are **irreversible or surprising** and deserve their own artifact. When an ADR contradicts one of the prose docs, update both or the prose doc wins — never leave them split.

Consumer rules for agents: read ADRs touching your area before proposing changes; if your work contradicts an accepted ADR, stop and surface the conflict explicitly.
