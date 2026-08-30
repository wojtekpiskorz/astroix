---
"@wojciechpiskorz/astroix": patch
---

Move `shadcn` from `dependencies` to `devDependencies` — consumers no longer install the shadcn CLI tree (`ts-morph`, `execa`, `@modelcontextprotocol/sdk`, …). Nothing imports it at runtime; the documented workflow uses `bunx shadcn@latest add`.
