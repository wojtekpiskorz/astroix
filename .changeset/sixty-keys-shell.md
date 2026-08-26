---
'@wojciechpiskorz/astroix': patch
---

Chrome shell: the placeholder becomes a real app — React 19 (Compiler on, Oxc) in a shadow DOM root, header + sidebar + canvas layout, Tailwind 4 delivered per T1 (one constructed stylesheet adopted on both the document and the shadow root; `?inline` import with HMR `replaceSync`). Select mode (zustand, default off): hover outline and click-to-select with a stable descriptor; off restores the canvas untouched. TanStack Query fetches the index payload with a graceful empty state. Source mode now dedupes react/react-dom (the /@fs chrome made the optimizer mount two copies) and joins the checkout root to `server.fs.allow` (HMR re-fetches carry `?t=` which misses the import-chain exemption).
