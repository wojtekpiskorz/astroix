---
"@wojciechpiskorz/astroix": patch
---

Content read endpoints (wayfinder #68): `GET /__astroix/collections` (core-parsed entries via a fresh `runner.import('astro:content')` per request — stateless, no cross-request caching — plus schema presence from the content config) and `GET /__astroix/routes` (the `astro:routes:resolved` hook payload, re-captured on route-change restarts). Raw entry bytes continue through the root-confined `GET /__astroix/file`. E2e fixture grows a `blog` collection with nested-path ids (`2024/post`) and a `/blog/[...slug]` dynamic route.
