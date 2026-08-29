---
'@wojciechpiskorz/astroix': patch
---

Content auto-write loop (#74): drafts serialize to the entry file per pause — frontmatter spliced through the yaml Document API (untouched keys byte-identical, `image()` round-trips), body written below the closing delimiter — behind a ~300ms debounce with the `/edit`-style hash guard (`POST /__astroix/content-write`, 409 → reload from disk + banner), write-echo guards in the form, and core-first `astro:content-changed` freshness.
