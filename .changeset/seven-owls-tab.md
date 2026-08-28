---
"@wojciechpiskorz/astroix": patch
---

feat: chrome shell tabs — `activeVertical` + vertical-scoped select mode (#70). CSS|Content tabs at the top of the sidebar (first use of the shadcn `Tabs`), `activeVertical: 'css' | 'content'` in the app store, and the editor dock slot (shell-owned column frame, uniform width) swaps between the css rule editor and the content placeholder — `features/content/` is born with the two slot stubs that #71 (entries list) and #72 (generated form) fill. Select mode becomes a property of the CSS vertical: off-CSS it stays armed in the store but is suspended on the canvas (overlay stripped, toggle disabled) and restored on return. The ADR-0002 layer list and the AGENTS.md checklist gain `sidebar.tsx` as app shell.
