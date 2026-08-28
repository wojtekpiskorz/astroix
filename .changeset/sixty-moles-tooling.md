---
"@wojciechpiskorz/astroix": patch
---

Classic-stack additions (owner-approved 2026-08-28): publint gates the published manifest in CI (`bun run check:publint`, after the artifact check — the exports/types must be consumer-clean), and the pre-commit hook now blocks on staged lint/format errors (`biome check --staged`) before the CC-warn scan. New devDep: publint.
