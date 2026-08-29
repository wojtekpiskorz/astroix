---
'@wojciechpiskorz/astroix': patch
---

chore: pre-commit hook now blocks on `tsc --noEmit` when the staged set touches `.ts`/`.tsx` (docs/changeset-only commits skip the run); closes the gap where a red typecheck could be committed mid-loop (#99 incident) — `scripts/setup-hooks.mjs` wiring message + AGENTS.md hook description synced
