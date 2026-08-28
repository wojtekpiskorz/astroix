---
"@wojciechpiskorz/astroix": patch
---

feat: chrome sidebar on the shadcn Sidebar primitive + theme preset b1Z6BvKCW (#81). The hand-rolled aside frame gives way to the generated Sidebar (Base UI variant, offcanvas collapse via rail or cmd/ctrl+b, state persisted by the primitive's cookie; provider row `relative` + sidebar `absolute` keep it below the chrome header; width 18rem preserved). Vertical tabs pin in the sidebar header, bodies render in the scrollable content area — behavior from #70 (activeVertical, dock swap, CSS-scoped select mode) unchanged behind the same data contracts. Theme preset b1Z6BvKCW lands as a value swap of both token blocks; touched shell surfaces (root, dock frame, header) convert from slate utilities to semantic tokens, feature bodies convert when their slices touch them. New e2e: collapse/expand state preservation + theme resolution.
