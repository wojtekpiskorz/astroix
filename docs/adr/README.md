# ADRs

Architecture Decision Records for Astroix. Number sequentially: `NNNN-kebab-title.md` (e.g. `0004-electron-parent-app-boundary-and-domain-model.md`). Status: `proposed` / `accepted` / `superseded by NNNN`. Amendments are appended as dated sections; the original body stays as the historical record.

## Current decision map

The Electron parent-app rewrite (map [#197](https://github.com/wojtekpiskorz/astroix/issues/197), charter [#203](https://github.com/wojtekpiskorz/astroix/issues/203), first doc lane [#210](https://github.com/wojtekpiskorz/astroix/issues/210)) records its architecture authority here:

- **0004** — Electron parent app: boundary, trust, and zero injection (accepted, [#205](https://github.com/wojtekpiskorz/astroix/issues/205))
- **0005** — Runtime topology, origin, and project introspection (accepted, [#202](https://github.com/wojtekpiskorz/astroix/issues/202) + proof [#206](https://github.com/wojtekpiskorz/astroix/issues/206))
- **0006** — Registry, project session, and edit authority (accepted, [#204](https://github.com/wojtekpiskorz/astroix/issues/204) + lease proof [#209](https://github.com/wojtekpiskorz/astroix/issues/209))
- **0007** — Trusted project and loopback threat model (accepted, [#199](https://github.com/wojtekpiskorz/astroix/issues/199))
- **0008** — Packaged runtime and unsigned macOS artifact (accepted, [#207](https://github.com/wojtekpiskorz/astroix/issues/207) + proof [#201](https://github.com/wojtekpiskorz/astroix/issues/201))
- **0009** — Service Worker bypass and authoritative editor transport (accepted, [#208](https://github.com/wojtekpiskorz/astroix/issues/208))
- **0010** — Additive migration and integration retirement (accepted, [#200](https://github.com/wojtekpiskorz/astroix/issues/200) + [#203](https://github.com/wojtekpiskorz/astroix/issues/203))

Integration-era records: **0001** (chrome delivery) is superseded by 0008 + 0010; **0002** (app-shell module architecture) is accepted with Electron-rewrite amendments, governing the retained renderer only; **0003** (desktop-only viewport) is accepted and reaffirmed.

## Where decisions live today

The prose docs remain the product and engineering narrative: `docs/spec.md` (product spec), `docs/stack.md` (technology decisions with rationale), `docs/core-reuse.md` (Astro/Vite seams by class). When an ADR contradicts one of the prose docs, update both or the prose doc wins — never leave them split. The rewrite ADRs summarize rulings; the spec binds them into the product record.

Consumer rules for agents: read ADRs touching your area before proposing changes; if your work contradicts an accepted ADR, stop and surface the conflict explicitly.
