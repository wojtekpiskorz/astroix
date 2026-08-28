---
"@wojciechpiskorz/astroix": patch
---

refactor: chrome restructured to the ADR-0002 target layout (#58) — mechanical move, no behavior change. `app.tsx` becomes the thin shell; the css vertical lands in `features/css/` (ChromeHeader, Sidebar, RuleList, EditorPane, RuleEditor + its zustand store + `api.ts` with `useIndexPayload`); the canvas machinery moves to `canvas/`; the CodeMirror primitives (view setup, theme, range effects, `replaceDoc`) move to `editor/codemirror.ts` and the raw `/_astroix/file|edit` fetches to `editor/api.ts` as-is (Query conversion stays recorded debt); `store.ts` shrinks to the cross-vertical app store (selectMode/selection).
