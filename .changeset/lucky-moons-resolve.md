---
"@wojciechpiskorz/astroix": patch
---

Core route-resolution module — the URL↔entry heuristic bridge (wayfinder #47, issue #69).

- New pure module `src/core/route-resolver.ts`, zero IO: `resolveActiveEntry` (canvas URL → active entry) and `candidateRoutes` (entry id → plausible canvas routes).
- Input is Astro's own parse, not a re-derived grammar (owner ruling, PR #77): `RouteInfo` carries `pattern` + `segments` (`RoutePart[][] {content, dynamic, spread}`) + `params` from `astro:routes:resolved`; contract: page routes only (the routes payload filters endpoint/redirect/fallback, #68).
- Doctrine: a unique hit selects — exactly one single-param route pattern matching, entry id held by exactly one collection. Ambiguity (id collision across collections, overlapping patterns resolving to different entries, a static page shadowing the dynamic route), multi-param and embedded-param patterns, or no match — all stay silent; the heuristic never picks wrong, it picks nothing.
- Rest params carry glob-loader ids (slugified paths: `2024/post.md` → id `2024/post` fits `/blog/[...slug]`).
