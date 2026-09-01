---
'@wojciechpiskorz/astroix': patch
---

Freeze the inspection behavior-contract corpus (#216, lane B1): a versioned schema (contractVersion 1.0.0) over CSS index payloads, effective selectors, Content collections, schema fields, route payloads, and route-resolution results; seven deterministic fixtures captured from disposable legacy-oracle runs over the canonical plain fixture (attribute and where scopedStyleStrategy legs); and a Playwright freeze suite that re-derives the corpus from fresh oracle runs byte-for-byte, validates it against the schema, hygiene-scans it for absolute paths/ports/timestamps/handles/staging artifacts, and proves the comparison rejects normalized-away selector identity, rule order, source ranges, collection order, and route identity.
